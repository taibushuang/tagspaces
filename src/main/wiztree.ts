/**
 * WizTree disk-usage analysis adapter for TagSpaces Windows desktop.
 *
 * WizTree reads the NTFS master file table directly, so a whole drive is
 * analyzed in seconds instead of minutes. There is no library interface, so
 * this module drives WizTree64.exe from the command line, exports the result
 * as CSV and parses the largest folders/files out of it.
 *
 * WizTree has no "quit after export" switch: the process may stay open after
 * writing the CSV. The export is therefore considered finished once the CSV
 * has been non-empty and its size unchanged for a few seconds AND the header
 * plus scanned-root row are present (or the launched process already exited).
 * The process tree is killed at that point.
 *
 * Elevation may restart WizTree: with /admin=1 a non-elevated process can
 * exit while an elevated instance launched by the UAC prompt keeps writing
 * the CSV. A close without any CSV therefore starts a grace period instead
 * of failing immediately.
 *
 * This module is lazy-loaded in mainEvents.ts **only on win32** to avoid
 * touching Windows-only binaries on the macOS development machine.
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import readline from 'readline';
import { spawn, execFileSync } from 'child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WizTreeScanArgs {
  /** Drive ("C:") or folder ("C:\\Users") to analyze */
  path: string;
  /** Largest folders/files to return per list (default 20) */
  topN?: number;
  /** Also export the largest files (larger CSV, slower) */
  includeFiles?: boolean;
  /** WizTree file filter, e.g. "*.mp4|*.mkv" */
  filter?: string;
  /** Use the elevated MFT scan (default true; shows a UAC prompt) */
  admin?: boolean;
}

export interface WizTreeEntry {
  path: string;
  size: number;
  allocated: number;
  modified?: string;
  files?: number;
  folders?: number;
  /** Allocated field had the hard-link prefix; the space is not really used */
  isHardLink?: boolean;
}

export interface WizTreeScanResult {
  ok?: boolean;
  available?: boolean;
  scannedPath?: string;
  durationMs?: number;
  totalFiles?: number;
  totalFolders?: number;
  totalSize?: number;
  /** Disk space actually used (hard-link rows count as 0) */
  totalAllocated?: number;
  driveSize?: number;
  topFolders?: WizTreeEntry[];
  topFiles?: WizTreeEntry[];
  error?: string;
  installHint?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TOP_N = 20;
const MAX_TOP_N = 200;

const CSV_PARSE_TIMEOUT_MS = 60000;
const CSV_HEAD_BYTES = 4096;

const DEFAULT_POLL_MS = 1000;
const DEFAULT_STABLE_TICKS = 3;
/** Wait for an elevated WizTree instance after the launched one exited */
const DEFAULT_GRACE_MS = 60000;
/** Keep waiting for the root row before accepting an otherwise stable CSV */
const DEFAULT_HEADER_GRACE_MS = 30000;
const DEFAULT_EXPORT_TIMEOUT_MS = 180000;

export const WIZTREE_INSTALL_HINT =
  'Install WizTree with "winget install --id AntibodySoftware.WizTree -e" ' +
  'or download it from https://www.diskanalyzer.com/download ' +
  '(free for personal use, commercial use requires a license).';

// ---------------------------------------------------------------------------
// Registry access (InnoSetup uninstall key + App Paths)
// ---------------------------------------------------------------------------

/**
 * Read a registry value through PowerShell with a UTF-8 console. reg.exe
 * prints OEM/GBK text, which turns non-ASCII install paths (e.g.
 * D:\软件\WizTree) into replacement characters — same rationale and pattern
 * as readRegValue() in everythingSdk.ts.
 */
function readRegValue(key: string, valueName: string): string | undefined {
  const quotedName =
    valueName === '' ? "''" : `'${valueName.replace(/'/g, "''")}'`;
  const script =
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
    `$k=Get-Item -LiteralPath 'Registry::${key.replace(/'/g, "''")}' -ErrorAction SilentlyContinue; ` +
    `if($k){$v=$k.GetValue(${quotedName}); if($null -ne $v){$v.ToString()}} else {''}`;
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'buffer', windowsHide: true, timeout: 15000 },
    );
    const value = out.toString('utf8').trim();
    return value.length > 0 ? value.replace(/^"|"$/g, '') : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Executable discovery
// ---------------------------------------------------------------------------

let cachedExe: string | undefined;

function isWizTreeExe(file: string): boolean {
  return /^wiztree(64)?\.exe$/i.test(path.basename(file));
}

/**
 * Default candidates in priority order. Within every directory the 64-bit
 * binary comes first: the 32-bit wiztree.exe only re-launches WizTree64.exe.
 */
export function defaultExeCandidates(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const candidates: string[] = [];

  const custom = (env.WIZTREE_PATH || '').trim();
  if (custom) {
    let isDir = false;
    try {
      isDir = fs.statSync(custom).isDirectory();
    } catch {
      isDir = false;
    }
    if (isDir) {
      candidates.push(
        path.join(custom, 'WizTree64.exe'),
        path.join(custom, 'WizTree.exe'),
      );
    } else {
      candidates.push(custom);
    }
  }

  const programFiles =
    env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = env.LOCALAPPDATA || '';
  candidates.push(
    path.join(programFiles, 'WizTree', 'WizTree64.exe'),
    path.join(programFiles, 'WizTree', 'WizTree.exe'),
    path.join(programFilesX86, 'WizTree', 'WizTree.exe'),
  );
  if (localAppData) {
    candidates.push(
      path.join(localAppData, 'WizTree', 'WizTree64.exe'),
      path.join(localAppData, 'Programs', 'WizTree', 'WizTree64.exe'),
    );
  }
  return candidates;
}

/**
 * Locate WizTree64.exe / WizTree.exe. Order: WIZTREE_PATH env → default
 * install dirs → InnoSetup uninstall key → App Paths.
 */
export function findWizTreeExe(): string | null {
  if (cachedExe && fs.existsSync(cachedExe)) {
    return cachedExe;
  }
  cachedExe = undefined;

  const candidates = defaultExeCandidates(process.env);

  const uninstallKeys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WizTree_is1',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WizTree_is1',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WizTree_is1',
  ];
  for (let i = 0; i < uninstallKeys.length; i += 1) {
    const location = readRegValue(uninstallKeys[i], 'InstallLocation');
    if (location) {
      candidates.push(
        path.join(location, 'WizTree64.exe'),
        path.join(location, 'WizTree.exe'),
      );
    }
  }

  const appPathKeys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WizTree64.exe',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WizTree.exe',
  ];
  for (let i = 0; i < appPathKeys.length; i += 1) {
    const appPath = readRegValue(appPathKeys[i], '');
    if (appPath) candidates.push(appPath);
  }

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (isWizTreeExe(candidate) && fs.existsSync(candidate)) {
      cachedExe = candidate;
      return candidate;
    }
  }
  return null;
}

export function isWizTreeAvailable(): {
  available: boolean;
  exePath?: string;
  error?: string;
} {
  if (process.platform !== 'win32') {
    return { available: false, error: 'WizTree is only available on Windows.' };
  }
  const exe = findWizTreeExe();
  if (!exe) {
    return { available: false, error: 'WizTree not found on this machine.' };
  }
  return { available: true, exePath: exe };
}

// ---------------------------------------------------------------------------
// Target validation
// ---------------------------------------------------------------------------

export type ScanTarget =
  | { targetPath: string; driveOnly: boolean }
  | { error: string };

export function validateScanTarget(
  raw: unknown,
  statFn: (p: string) => { isDirectory(): boolean } = fs.statSync,
): ScanTarget {
  const target = typeof raw === 'string' ? raw.trim() : '';
  if (!target) {
    return { error: 'path is required (a drive like "C:" or a folder path)' };
  }
  if (/^[A-Za-z]:$/.test(target)) {
    return { targetPath: `${target}\\`, driveOnly: true };
  }
  let stats;
  try {
    stats = statFn(target);
  } catch {
    return { error: `path not found: ${target}` };
  }
  if (!stats.isDirectory()) {
    return { error: `path is not a directory: ${target}` };
  }
  return { targetPath: target, driveOnly: false };
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function normalizeKey(p: string): string {
  return p.replace(/[\\/]+$/, '').toLowerCase();
}

function stripTrailingSlash(p: string): string {
  return p.replace(/[\\/]+$/, '');
}

/**
 * WizTree marks hard links with a leading 0 in the Allocated column: the
 * file shares its clusters with another path and uses no extra space. Keep
 * the numeric value for display, but count 0 in hard-link-adjusted totals.
 */
function parseAllocated(raw: string | undefined): {
  allocated: number;
  isHardLink: boolean;
} {
  const text = (raw || '').trim();
  const isHardLink = text.length > 1 && text.startsWith('0');
  return { allocated: Number(text) || 0, isHardLink };
}

interface TopList {
  push: (entry: WizTreeEntry) => void;
  sorted: () => WizTreeEntry[];
}

/** Bounded min-heap: O(log limit) per row, O(limit) memory. */
function createTopList(limit: number): TopList {
  const heap: WizTreeEntry[] = [];
  const swap = (a: number, b: number) => {
    const tmp = heap[a];
    heap[a] = heap[b];
    heap[b] = tmp;
  };
  const siftUp = (index: number) => {
    let i = index;
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (heap[parent].size <= heap[i].size) break;
      swap(parent, i);
      i = parent;
    }
  };
  const siftDown = (index: number) => {
    let i = index;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let min = i;
      if (left < heap.length && heap[left].size < heap[min].size) min = left;
      if (right < heap.length && heap[right].size < heap[min].size) min = right;
      if (min === i) break;
      swap(min, i);
      i = min;
    }
  };
  return {
    push(entry: WizTreeEntry) {
      if (limit <= 0) return;
      if (heap.length < limit) {
        heap.push(entry);
        siftUp(heap.length - 1);
        return;
      }
      if (entry.size > heap[0].size) {
        heap[0] = entry;
        siftDown(0);
      }
    },
    sorted() {
      return [...heap].sort((a, b) => b.size - a.size);
    },
  };
}

export interface ParsedExport {
  totalFiles: number;
  totalFolders: number;
  totalSize: number;
  totalAllocated: number;
  topFolders: WizTreeEntry[];
  topFiles: WizTreeEntry[];
}

/**
 * Stream the exported CSV. Columns:
 *   File Name, Size, Allocated, Modified, Attributes, Files, Folders
 * Folder rows are marked by a trailing backslash. The scanned root row is
 * used for the totals and kept out of the top folders ranking.
 */
export async function parseWizTreeExport(
  exportFile: string,
  targetPath: string,
  topN: number,
  includeFiles: boolean,
  timeoutMs = CSV_PARSE_TIMEOUT_MS,
): Promise<ParsedExport> {
  const rootKey = normalizeKey(targetPath);
  const folders = createTopList(topN);
  const files = createTopList(topN);
  const deadline = Date.now() + timeoutMs;
  let rowsParsed = 0;
  let folderRows = 0;
  let fileRows = 0;
  let maxFiles = 0;
  let maxSize = 0;
  let maxAllocated = 0;
  let rootRow: WizTreeEntry | undefined;
  let rootAllocated = 0;

  const input = fs.createReadStream(exportFile, { encoding: 'utf8' });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  let firstLine = true;
  try {
    for await (const rawLine of reader) {
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out after ${Math.round(timeoutMs / 1000)}s (${rowsParsed} rows parsed)`,
        );
      }
      let line = rawLine;
      if (firstLine) {
        firstLine = false;
        line = line.replace(/^\uFEFF/, '');
        if (/^"?file name"?/i.test(line)) {
          // eslint-disable-next-line no-continue -- skip CSV header
          continue;
        }
      }
      if (!line) {
        // eslint-disable-next-line no-continue -- skip blank lines
        continue;
      }
      const cols = parseCsvLine(line);
      const rowPath = cols[0];
      if (!rowPath) {
        // eslint-disable-next-line no-continue -- skip malformed rows
        continue;
      }
      rowsParsed += 1;
      const size = Number(cols[1]) || 0;
      const { allocated, isHardLink } = parseAllocated(cols[2]);
      const effectiveAllocated = isHardLink ? 0 : allocated;
      const modified = cols[3] || undefined;
      if (/[\\/]$/.test(rowPath)) {
        const folderPath = stripTrailingSlash(rowPath);
        const entry: WizTreeEntry = {
          path: folderPath,
          size,
          allocated,
          ...(modified && { modified }),
          ...(isHardLink && { isHardLink }),
          files: Number(cols[5]) || 0,
          folders: Number(cols[6]) || 0,
        };
        folderRows += 1;
        maxFiles = Math.max(maxFiles, entry.files as number);
        maxSize = Math.max(maxSize, size);
        maxAllocated = Math.max(maxAllocated, effectiveAllocated);
        if (!rootRow && normalizeKey(folderPath) === rootKey) {
          rootRow = entry;
          rootAllocated = effectiveAllocated;
        } else {
          folders.push(entry);
        }
      } else {
        fileRows += 1;
        files.push({
          path: rowPath,
          size,
          allocated,
          ...(modified && { modified }),
          ...(isHardLink && { isHardLink }),
        });
      }
    }
  } finally {
    reader.close();
    input.destroy();
  }

  const totalFiles = rootRow
    ? (rootRow.files as number)
    : includeFiles
      ? fileRows
      : maxFiles;
  return {
    totalFiles,
    totalFolders: folderRows,
    totalSize: rootRow ? rootRow.size : maxSize,
    totalAllocated: rootRow ? rootAllocated : maxAllocated,
    topFolders: folders.sorted(),
    topFiles: includeFiles ? files.sorted() : [],
  };
}

// ---------------------------------------------------------------------------
// Completion detection
// ---------------------------------------------------------------------------

export interface ExportTiming {
  pollMs?: number;
  stableTicks?: number;
  graceMs?: number;
  headerGraceMs?: number;
  timeoutMs?: number;
}

export interface ExportDeps {
  spawnFn?: (exe: string, args: string[], opts: any) => any;
  statSize?: (file: string) => number;
  hasRootRow?: (file: string, targetPath: string) => boolean;
  kill?: (pid: number | undefined) => void;
}

interface ExportOutcome {
  ok: boolean;
  error?: string;
}

function defaultStatSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Cheap readiness probe: the first 4KB must contain the CSV header and the
 * scanned-root row (WizTree writes the root row first). A locked/partial
 * file counts as "not ready".
 */
export function hasRootRowSync(
  exportFile: string,
  targetPath: string,
): boolean {
  const rootKey = normalizeKey(targetPath);
  let fd: number | undefined;
  try {
    fd = fs.openSync(exportFile, 'r');
    const buffer = new Uint8Array(CSV_HEAD_BYTES);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const text = Buffer.from(buffer.subarray(0, read))
      .toString('utf8')
      .replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/);
    let headerSeen = false;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line) {
        // eslint-disable-next-line no-continue -- skip blank lines
        continue;
      }
      if (!headerSeen) {
        if (/^"?file name"?/i.test(line)) {
          headerSeen = true;
          // eslint-disable-next-line no-continue -- header consumed
          continue;
        }
        return false;
      }
      const rowPath = parseCsvLine(line)[0];
      if (rowPath && normalizeKey(rowPath) === rootKey) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* ignore */
  }
}

export function buildExportArgs(
  targetPath: string,
  exportFile: string,
  options: WizTreeScanArgs,
): string[] {
  const args = [
    targetPath,
    `/export=${exportFile}`,
    `/admin=${options.admin === false ? 0 : 1}`,
    '/sortby=1',
    '/exportfolders=1',
    options.includeFiles === true ? '/exportfiles=1' : '/exportfiles=0',
  ];
  const filter =
    typeof options.filter === 'string' ? options.filter.trim() : '';
  if (filter) args.push(`/filter=${filter}`);
  return args;
}

/**
 * Run the export and resolve once it is done:
 * - the CSV is non-empty and stable for stableTicks polls, and it contains
 *   the header + root row (or the launched process already exited), or
 * - the launched process exited and an elevated instance wrote the CSV
 *   within graceMs, or
 * - the header did not show up within headerGraceMs (accept what we have).
 * Without any CSV after graceMs the UAC prompt was probably declined.
 */
export function runExport(
  exe: string,
  targetPath: string,
  exportFile: string,
  options: WizTreeScanArgs,
  timing: ExportTiming = {},
  deps: ExportDeps = {},
): Promise<ExportOutcome> {
  return new Promise((resolve) => {
    const pollMs = timing.pollMs ?? DEFAULT_POLL_MS;
    const stableTicksNeeded = timing.stableTicks ?? DEFAULT_STABLE_TICKS;
    const graceMs = timing.graceMs ?? DEFAULT_GRACE_MS;
    const headerGraceMs = timing.headerGraceMs ?? DEFAULT_HEADER_GRACE_MS;
    const timeoutMs = timing.timeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS;
    const spawnFn = deps.spawnFn ?? spawn;
    const statSize = deps.statSize ?? defaultStatSize;
    const hasRootRow = deps.hasRootRow ?? hasRootRowSync;
    const kill = deps.kill ?? killTree;

    let child: any;
    try {
      child = spawnFn(exe, buildExportArgs(targetPath, exportFile, options), {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch (err: any) {
      resolve({ ok: false, error: `Failed to start WizTree: ${err.message}` });
      return;
    }

    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let lastSize = -1;
    let stableTicks = 0;
    let graceDeadline: number | undefined;
    let headerDeadline: number | undefined;
    let pollTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;

    const finish = (outcome: ExportOutcome) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      // WizTree may keep running after writing the CSV (there is no auto-quit
      // flag), and a timed-out scan must not leave an orphan behind.
      kill(child.pid);
      resolve(outcome);
    };

    child.on('error', (err: any) => {
      finish({ ok: false, error: `Failed to start WizTree: ${err.message}` });
    });

    child.on('close', (code: number | null) => {
      if (settled) return;
      exited = true;
      exitCode = code;
      // Elevation can hand the export to a new elevated instance: the
      // launched process exits before the CSV exists. Wait instead of failing.
      if (statSize(exportFile) <= 0) {
        graceDeadline = Date.now() + graceMs;
      }
    });

    pollTimer = setInterval(() => {
      const now = Date.now();
      const size = statSize(exportFile);
      if (size > 0) {
        if (size === lastSize) {
          stableTicks += 1;
        } else {
          lastSize = size;
          stableTicks = 0;
        }
        if (stableTicks >= stableTicksNeeded) {
          if (exited || hasRootRow(exportFile, targetPath)) {
            finish({ ok: true });
          } else if (headerDeadline === undefined) {
            // A stable size alone can be a pause between write bursts; keep
            // polling for the root row, but do not wait forever.
            headerDeadline = now + headerGraceMs;
          } else if (now >= headerDeadline) {
            finish({ ok: true });
          }
        }
      } else if (graceDeadline !== undefined && now >= graceDeadline) {
        finish({
          ok: false,
          error:
            `WizTree exited (code ${exitCode}) without producing an export ` +
            `file within ${Math.round(graceMs / 1000)}s. The UAC prompt may ` +
            'have been declined or cancelled — retry and accept it, or retry ' +
            'with admin=false for a slower non-elevated scan.',
        });
      }
    }, pollMs);

    timeoutTimer = setTimeout(() => {
      finish({
        ok: false,
        error:
          `WizTree did not finish exporting within ${Math.round(timeoutMs / 1000)}s. ` +
          'The /admin=1 MFT scan waits for the UAC prompt to be accepted — ' +
          'accept it and retry, or retry with admin=false for a slower ' +
          'non-elevated scan.',
      });
    }, timeoutMs);
  });
}

async function getDriveSize(targetPath: string): Promise<number | undefined> {
  try {
    const stats = await fs.promises.statfs(targetPath);
    return Number(stats.blocks) * Number(stats.bsize);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Serial queue (one WizTree run at a time — avoids double UAC / instances)
// ---------------------------------------------------------------------------

export function createSerialTaskQueue<T>() {
  let tail: Promise<T> = Promise.resolve(undefined as unknown as T);
  return (task: () => Promise<T>): Promise<T> => {
    tail = tail.then(task, task);
    return tail;
  };
}

const enqueueScan = createSerialTaskQueue<WizTreeScanResult>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function wiztreeScanOnce(
  args: WizTreeScanArgs,
): Promise<WizTreeScanResult> {
  if (process.platform !== 'win32') {
    return { available: false, error: 'WizTree is only available on Windows.' };
  }

  const options = args || ({} as WizTreeScanArgs);
  const target = validateScanTarget(options.path);
  if ('error' in target) {
    return { error: target.error };
  }
  const { targetPath, driveOnly } = target;

  const exe = findWizTreeExe();
  if (!exe) {
    return {
      available: false,
      error: 'WizTree not found on this machine.',
      installHint: WIZTREE_INSTALL_HINT,
    };
  }

  const topN = Math.max(
    1,
    Math.min(MAX_TOP_N, Math.floor(Number(options.topN) || DEFAULT_TOP_N)),
  );
  const includeFiles = options.includeFiles === true;
  const startedAt = Date.now();
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'tagspaces-wiztree-'),
  );
  const exportFile = path.join(tmpDir, 'export.csv');

  try {
    const outcome = await runExport(exe, targetPath, exportFile, options);
    if (!outcome.ok) {
      return { available: true, error: outcome.error };
    }

    let parsed: ParsedExport;
    try {
      parsed = await parseWizTreeExport(
        exportFile,
        targetPath,
        topN,
        includeFiles,
      );
    } catch (err: any) {
      return {
        available: true,
        error: `Failed to read the WizTree export: ${err.message}`,
      };
    }

    const driveSize = driveOnly ? await getDriveSize(targetPath) : undefined;
    return {
      ok: true,
      scannedPath: targetPath,
      durationMs: Date.now() - startedAt,
      totalFiles: parsed.totalFiles,
      totalFolders: parsed.totalFolders,
      totalSize: parsed.totalSize,
      totalAllocated: parsed.totalAllocated,
      ...(driveSize !== undefined && { driveSize }),
      topFolders: parsed.topFolders,
      ...(includeFiles && { topFiles: parsed.topFiles }),
    };
  } finally {
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
  }
}

export function wiztreeScan(args: WizTreeScanArgs): Promise<WizTreeScanResult> {
  return enqueueScan(() => wiztreeScanOnce(args));
}
