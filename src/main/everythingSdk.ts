/**
 * Everything search adapter for TagSpaces Windows desktop.
 *
 * Uses voidtools' es.exe (the official Everything command-line interface)
 * instead of the C SDK. This removes the koffi FFI layer entirely — no native
 * bindings, no arch-specific Everything.dll loading, no per-platform install
 * scripts. es.exe talks to the running Everything client over IPC and writes
 * UTF-8 TSV to a temp file, so Chinese paths survive round-trips.
 *
 * es.exe discovery order:
 *   1. Custom path from settings (install dir, Everything.exe or es.exe path)
 *   2. Next to Everything.exe (located via registry App Paths / Uninstall /
 *      Run key / service ImagePath — read through PowerShell so non-ASCII
 *      install paths like D:\软件\Everything are handled correctly)
 *   3. Default: C:\Program Files\Everything\es.exe / (x86)\Everything\es.exe
 *   4. Fallback: bundled es.exe shipped under resources/everything/
 *
 * This module is lazy-loaded in mainEvents.ts **only on win32** to avoid
 * crashing the macOS development machine.
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn, execFileSync, execSync, exec } from 'child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EverythingSearchOptions {
  /** Maximum results to return (default 200 for live search) */
  maxResults?: number;
  /** Limit search to a specific folder path */
  pathPrefix?: string;
  /** File extensions filter, e.g. ['pdf', 'doc'] */
  extensions?: string[];
  /** Minimum file size in bytes */
  minSize?: number;
  /** Maximum file size in bytes */
  maxSize?: number;
  /** Modified after (epoch ms) */
  modifiedAfter?: number;
  /** Modified before (epoch ms) */
  modifiedBefore?: number;
}

export interface EverythingResult {
  path: string;
  name: string;
  isFile: boolean;
  size: number;
  lmdt: number; // epoch ms
}

export interface EverythingSearchResponse {
  available: boolean;
  results: EverythingResult[];
  totalCount?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RESULTS = 200;
const AVAILABILITY_CACHE_TTL_MS = 30000;
const DEBUG_LOG_MAX = 300;
const AUTOSTART_THROTTLE_MS = 60000;
// First-run indexing can take a while (real-world reports: 1.5b first build
// 30-60s+). Negative results are never cached, so the next search re-probes
// anyway — this timeout only bounds the explicit wait loop.
const DB_LOAD_TIMEOUT_MS = 120000;
const PROBE_CACHE_TTL_MS = 5000;
// es.exe exits non-zero when it cannot reach Everything; error 8 = IPC window
// not found (Everything not running in this session).
const ES_EXIT_IPC_NOT_FOUND = 8;
// How long es.exe waits for the Everything DB to load before answering.
const ES_TIMEOUT_MS = 3000;
// Seconds between auto-start DB polling.
const DB_POLL_MS = 1000;

/** YYYYMMDD in local time (Everything dm:/dc: ranges are local-time based). */
function formatLocalDate(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}${month}${day}`;
}

// ---------------------------------------------------------------------------
// Debug log (ring buffer, surfaced in the Everything debug dialog)
// ---------------------------------------------------------------------------

export interface EverythingDebugEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

const debugLog: EverythingDebugEntry[] = [];

function logDebug(level: 'info' | 'warn' | 'error', message: string) {
  debugLog.push({ ts: Date.now(), level, message });
  if (debugLog.length > DEBUG_LOG_MAX) {
    debugLog.splice(0, debugLog.length - DEBUG_LOG_MAX);
  }
  if (level === 'error') {
    console.error('[Everything]', message);
  } else {
    console.log('[Everything]', message);
  }
}

// Last-known state for the debug dialog
let lastQuery: string | undefined;
let lastQueryAt: number | undefined;
let lastResultCount: number | undefined;
let lastError: string | undefined;
let lastAutoStartAt = 0;
let autoStartInFlight: Promise<boolean> | undefined;

// ---------------------------------------------------------------------------
// Registry access (Unicode-safe via PowerShell). reg.exe prints OEM-codepage
// text and execSync(encoding:'utf8') mangles non-ASCII install paths
// (e.g. D:\软件\Everything → U+FFFD garbage). Forcing PowerShell's console to
// UTF-8 round-trips real Unicode. Results are cached behind findEverythingExe
// so the few hundred ms of PS startup only happens on a probe cache miss.
// ---------------------------------------------------------------------------

function readRegValue(subKey: string, valueName: string): string | undefined {
  // GetValue('') reads the key's default (unnamed) value.
  const quotedName =
    valueName === '' ? "''" : `'${valueName.replace(/'/g, "''")}'`;
  const script =
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
    `$k=Get-Item -LiteralPath 'Registry::${subKey.replace(/'/g, "''")}' -ErrorAction SilentlyContinue; ` +
    `if($k){$v=$k.GetValue(${quotedName}); if($null -ne $v){$v.ToString()}} else {''}`;
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'buffer', windowsHide: true, timeout: 15000 },
    );
    const text = out.toString('utf8').trim();
    return text.length > 0 ? text : undefined;
  } catch (err: any) {
    logDebug(
      'warn',
      `registry read failed (${subKey}\\${valueName}): ${err.message}`,
    );
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// es.exe / Everything.exe discovery
// ---------------------------------------------------------------------------

// Only log probe results when they change (the debug dialog polls every second)
let lastExeProbe: string | null | undefined;
let lastEsProbe: string | null | undefined;

// User-configured Everything location (install dir, Everything.exe, es.exe or
// a legacy dll path). Set from the renderer settings via IPC on every search.
let customEverythingPath: string | undefined;

// exe/running probing spawns sync child processes (powershell.exe,
// tasklist.exe). Cache the results so the debug dialog's 1s polling does not
// block the Electron main process with several process spawns per second.
let probeCache:
  | { at: number; exePath: string | undefined; running: boolean }
  | undefined;

/** Electron's process.resourcesPath (Node's Process type has no such field). */
function getResourcesPath(): string | undefined {
  const p = process as { resourcesPath?: string };
  return p.resourcesPath;
}

/** Invalidate after install/start actions so the dialog reflects reality. */
function invalidateProbeCache(): void {
  probeCache = undefined;
}

function isEverythingRunning(): boolean {
  try {
    const output = execSync('tasklist /FI "IMAGENAME eq Everything.exe"', {
      encoding: 'utf8',
      windowsHide: true,
    });
    return /Everything\.exe/i.test(output);
  } catch (err: any) {
    logDebug('warn', `tasklist check failed: ${err.message}`);
    return false;
  }
}

/**
 * Locate Everything.exe itself (used to auto-start it and to find es.exe next
 * to it).
 */
function findEverythingExe(): string | undefined {
  // Only accept real Everything executables — a custom path pointing at an
  // unrelated .exe must not be launched.
  const EVERYTHING_EXE_RE = /^everything(64)?\.exe$/i;
  const probe = (
    exe: string | undefined,
    source: string,
  ): string | undefined => {
    if (
      exe &&
      EVERYTHING_EXE_RE.test(path.basename(exe)) &&
      fs.existsSync(exe)
    ) {
      if (lastExeProbe !== exe) {
        lastExeProbe = exe;
        logDebug('info', `Everything.exe found via ${source}: ${exe}`);
      }
      return exe;
    }
    return undefined;
  };

  // 0. User-configured custom path (install dir, exe or dll path)
  if (customEverythingPath) {
    const p = customEverythingPath;
    let customCandidates: string[];
    if (/\.exe$/i.test(p)) {
      customCandidates = [p];
    } else if (/\.dll$/i.test(p)) {
      customCandidates = [path.join(path.dirname(p), 'Everything.exe')];
    } else {
      customCandidates = [path.join(p, 'Everything.exe')];
    }
    for (let i = 0; i < customCandidates.length; i += 1) {
      const hit = probe(customCandidates[i], 'custom path');
      if (hit) return hit;
    }
  }

  // 1. Registry: App Paths, Uninstall InstallLocation, Run key and the
  //    Everything service ImagePath. ImagePath covers portable installs that
  //    registered the service (Everything -svc).
  const registryProbes: Array<{ key: string; value: string; how: string }> = [
    {
      key: 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Everything.exe',
      value: '',
      how: 'registry App Paths (HKCU)',
    },
    {
      key: 'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Everything.exe',
      value: '',
      how: 'registry App Paths (HKLM)',
    },
    {
      key: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Everything',
      value: 'InstallLocation',
      how: 'registry Uninstall key',
    },
    {
      key: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Everything',
      value: 'InstallLocation',
      how: 'registry Uninstall key (WOW6432Node)',
    },
    {
      key: 'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',
      value: 'Everything',
      how: 'registry Run key',
    },
    {
      key: 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\Everything',
      value: 'ImagePath',
      how: 'Everything service ImagePath',
    },
  ];
  for (let i = 0; i < registryProbes.length; i += 1) {
    const { key, value, how } = registryProbes[i];
    const data = readRegValue(key, value);
    if (!data) {
      // eslint-disable-next-line no-continue -- skip absent registry values
      continue;
    }
    if (
      how.startsWith('registry Run key') ||
      how.startsWith('Everything service')
    ) {
      // Command line like "C:\...\Everything.exe" -startup / "-svc"
      const match = /^"?([^"]+?\.exe)/i.exec(data.trim());
      if (match) {
        const hit = probe(match[1], how);
        if (hit) return hit;
      }
    } else {
      const hit = probe(path.join(data, 'Everything.exe'), how);
      if (hit) return hit;
    }
  }

  // 2. Default paths (machine-scope installs; LOCALAPPDATA kept as a cheap
  //    fallback for portable/per-user setups)
  const candidates = [
    'C:\\Program Files\\Everything\\Everything.exe',
    'C:\\Program Files (x86)\\Everything\\Everything.exe',
    ...(process.env.LOCALAPPDATA
      ? [
          path.join(
            process.env.LOCALAPPDATA,
            'Programs',
            'Everything',
            'Everything.exe',
          ),
        ]
      : []),
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    const hit = probe(candidates[i], 'default path');
    if (hit) return hit;
  }
  if (lastExeProbe !== null) {
    lastExeProbe = null;
    logDebug(
      'warn',
      'Everything.exe not found (custom path, registry, default paths).',
    );
  }
  return undefined;
}

function findEsPath(): string | undefined {
  // 0. User-configured custom path (install dir, Everything.exe, es.exe or a
  //    legacy dll path)
  if (customEverythingPath) {
    const p = customEverythingPath;
    if (/\.exe$/i.test(p) && /^es(\.exe)?$/i.test(path.basename(p))) {
      if (fs.existsSync(p)) {
        logDebug('info', `Using custom es.exe: ${p}`);
        return p;
      }
    }
    let dir = p;
    if (/\.dll$/i.test(p) || /\.exe$/i.test(p)) {
      dir = path.dirname(p);
    }
    const custom = path.join(dir, 'es.exe');
    if (fs.existsSync(custom)) {
      logDebug('info', `Using es.exe from custom Everything path: ${custom}`);
      return custom;
    }
    logDebug('warn', `Custom Everything path set but no es.exe found: ${p}`);
  }

  // 1. Next to Everything.exe
  const exe = findEverythingExe();
  if (exe) {
    const candidate = path.join(path.dirname(exe), 'es.exe');
    if (fs.existsSync(candidate)) {
      if (lastEsProbe !== candidate) {
        lastEsProbe = candidate;
        logDebug('info', `es.exe found next to Everything.exe: ${candidate}`);
      }
      return candidate;
    }
  }

  // 2. Default install paths
  const candidates = [
    'C:\\Program Files\\Everything\\es.exe',
    'C:\\Program Files (x86)\\Everything\\es.exe',
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    if (fs.existsSync(candidates[i])) {
      if (lastEsProbe !== candidates[i]) {
        lastEsProbe = candidates[i];
        logDebug('info', `es.exe found at default path: ${candidates[i]}`);
      }
      return candidates[i];
    }
  }

  // 3. Bundled es.exe shipped with TagSpaces (many Everything installs do not
  //    include ES, so we carry our own copy).
  const bundled = [
    ...(getResourcesPath()
      ? [path.join(getResourcesPath() as string, 'everything', 'es.exe')]
      : []),
    path.join(process.cwd(), 'resources', 'everything', 'es.exe'), // dev
  ];
  for (let i = 0; i < bundled.length; i += 1) {
    if (fs.existsSync(bundled[i])) {
      if (lastEsProbe !== bundled[i]) {
        lastEsProbe = bundled[i];
        logDebug('info', `Using bundled es.exe: ${bundled[i]}`);
      }
      return bundled[i];
    }
  }

  if (lastEsProbe !== null) {
    lastEsProbe = null;
    logDebug(
      'error',
      'es.exe not found anywhere (install Everything or set a custom path).',
    );
  }
  return undefined;
}

export function setCustomEverythingPath(p?: string): void {
  const normalized = p && p.trim() ? p.trim() : undefined;
  if (normalized === customEverythingPath) return;
  customEverythingPath = normalized;
  logDebug('info', `Custom Everything path set: ${normalized ?? '(cleared)'}`);
  lastEsProbe = undefined;
  lastExeProbe = undefined;
  invalidateProbeCache();
}

// ---------------------------------------------------------------------------
// es.exe process handling
// ---------------------------------------------------------------------------

interface EsRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run es.exe with the given args. Resolves with exit code + output. `code`
 * is null if the process could not be spawned at all.
 */
function runEs(
  args: string[],
  timeoutMs = ES_TIMEOUT_MS,
): Promise<EsRunResult> {
  const es = findEsPath();
  if (!es) {
    return Promise.resolve({
      code: -1,
      stdout: '',
      stderr: 'es.exe not found',
    });
  }
  return new Promise((resolve) => {
    // -timeout gives the Everything DB a grace window while it loads.
    const child = spawn(es, ['-timeout', String(timeoutMs), ...args], {
      windowsHide: true,
    });
    const stdoutChunks: any[] = [];
    const stderrChunks: any[] = [];
    child.stdout.on('data', (d: Buffer) => {
      stdoutChunks.push(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      stderrChunks.push(d);
    });
    child.on('error', (err: any) => {
      logDebug('error', `es.exe spawn failed: ${err.message}`);
      resolve({ code: -1, stdout: '', stderr: err.message });
    });
    child.on('close', (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Auto-remediation: start Everything.exe when it is installed but not running
// ---------------------------------------------------------------------------

/**
 * Whether TagSpaces itself runs elevated (High Mandatory Level).
 * Relevant because Windows UIPI silently drops window messages sent to a MORE
 * privileged process — es.exe talks to Everything over the same window-message
 * IPC, so if Everything runs as admin and we do not, every query fails with
 * the IPC-not-found error. S-1-16-12288 = high integrity level SID.
 */
function isSelfElevated(): boolean {
  try {
    const output = execSync('whoami /groups', {
      encoding: 'utf8',
      windowsHide: true,
    });
    return /S-1-16-12288/.test(output);
  } catch {
    return false;
  }
}

/**
 * Launch Everything.exe and wait until es.exe can answer (database loaded).
 * Resolves true when the DB became ready within DB_LOAD_TIMEOUT_MS.
 */
async function startEverythingAndWait(): Promise<boolean> {
  const exe = findEverythingExe();
  if (!exe) {
    logDebug('error', 'Cannot auto-start: Everything.exe not found.');
    return false;
  }

  logDebug('info', `Auto-starting Everything: ${exe}`);
  const spawned = await new Promise<boolean>((resolve) => {
    try {
      const child = spawn(exe, ['-startup'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      // spawn failures (e.g. ERROR_ELEVATION_REQUIRED when Everything.exe is
      // marked "run as administrator") arrive as async error events, NOT
      // exceptions — without this listener they vanish silently.
      child.once('error', (err: any) => {
        logDebug('error', `spawn failed: ${err.message}`);
        resolve(false);
      });
      child.once('spawn', () => {
        logDebug('info', `Everything.exe spawned, pid=${child.pid}`);
        child.unref();
        resolve(true);
      });
    } catch (err: any) {
      logDebug('error', `spawn threw: ${err.message}`);
      resolve(false);
    }
  });

  if (!spawned) {
    // Fallback: cmd start goes through ShellExecute, which can show the UAC
    // prompt and launch elevated processes.
    try {
      exec(`cmd /c start "" /min "${exe}" -startup`, { windowsHide: true });
      logDebug(
        'info',
        'ShellExecute fallback issued (a UAC prompt may appear — please accept it).',
      );
    } catch (err: any) {
      logDebug('error', `ShellExecute fallback failed: ${err.message}`);
      return false;
    }
  }

  const deadline = Date.now() + DB_LOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // Polling requires a sequential await between probes.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, DB_POLL_MS);
    });
    // eslint-disable-next-line no-await-in-loop
    const probe = await runEs(
      ['-get-result-count', 'zz__es_probe', 'zz_nomatch_'],
      2000,
    );
    if (probe.code === 0) {
      logDebug('info', 'Everything database is loaded after auto-start.');
      return true;
    }
  }
  // Distinguish "process never came up" from "running but DB not ready".
  if (!isEverythingRunning()) {
    logDebug(
      'error',
      'Everything.exe is NOT running after the start attempt. If it is marked "run as administrator" or blocked by SmartScreen/AV, please start it manually once.',
    );
  } else {
    logDebug(
      'warn',
      `Everything is running but the DB was not ready within ${DB_LOAD_TIMEOUT_MS / 1000}s. First-run indexing or the Everything Service install prompt may be pending — check the Everything window/tray.`,
    );
  }
  return false;
}

/**
 * Throttled, in-flight-safe auto-start. Fired in the background whenever the
 * availability probe reports Everything is not reachable.
 */
function triggerAutoStart(): void {
  if (autoStartInFlight) return;
  if (Date.now() - lastAutoStartAt < AUTOSTART_THROTTLE_MS) return;
  lastAutoStartAt = Date.now();
  autoStartInFlight = startEverythingAndWait().finally(() => {
    autoStartInFlight = undefined;
  });
}

/**
 * Public, awaitable variant for the debug dialog "start Everything" button.
 */
export async function ensureEverythingRunning(): Promise<{
  success: boolean;
  message: string;
}> {
  const probe = await runEs(
    ['-get-result-count', 'zz__es_probe', 'zz_nomatch_'],
    2000,
  );
  if (probe.code === 0) {
    return { success: true, message: 'Everything is already running.' };
  }
  lastAutoStartAt = Date.now();
  const ok = await startEverythingAndWait();
  invalidateProbeCache();
  if (ok) {
    return { success: true, message: 'Everything started, database loaded.' };
  }
  return {
    success: false,
    message:
      'Everything.exe was launched but the database did not load in time. ' +
      'Check whether Everything is running (tray icon) and that it can index your drives (admin/service).',
  };
}

/**
 * Install Everything via winget (best effort, needs user consent in the UI).
 */
export function installEverything(): Promise<{
  success: boolean;
  output: string;
}> {
  return new Promise((resolve) => {
    logDebug('info', 'Attempting winget install of voidtools.Everything …');
    exec(
      'winget install --id voidtools.Everything -e --accept-source-agreements --accept-package-agreements --disable-interactivity',
      { windowsHide: true, timeout: 300000 },
      (error: any, stdout: string, stderr: string) => {
        const output = `${stdout || ''}\n${stderr || ''}`.trim();
        if (error) {
          logDebug(
            'error',
            `winget install failed: ${error.message}\n${output}`,
          );
          resolve({
            success: false,
            output:
              `${error.message}\n${output}\n\n` +
              'If winget is unavailable, download the installer manually from https://www.voidtools.com/downloads/',
          });
          return;
        }
        logDebug('info', `winget install finished.\n${output}`);
        // Re-probe exe after installation and try to start Everything
        // right away so the next search just works.
        lastExeProbe = undefined;
        invalidateProbeCache();
        lastAutoStartAt = 0;
        triggerAutoStart();
        resolve({ success: true, output });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Availability check (cached)
// ---------------------------------------------------------------------------

let esAvailable = false;
let availabilityCheckedAt = 0;
let availabilityError: string | undefined;

/**
 * Synchronous reachability probe: exit code 0 means es.exe could answer
 * Everything (DB loaded). Blocks the main process for a few ms at most.
 * Used by checkAvailability()/getDebugInfo() which run on a query/UI tick.
 */
function probeEsSync(): EsRunResult {
  const es = findEsPath();
  if (!es) {
    return { code: -1, stdout: '', stderr: 'es.exe not found' };
  }
  try {
    const out = execFileSync(
      es,
      ['-timeout', '1500', '-get-result-count', 'zz__es_probe', 'zz_nomatch_'],
      { encoding: 'buffer', windowsHide: true, timeout: 4000 },
    );
    return { code: 0, stdout: out.toString('utf8').trim(), stderr: '' };
  } catch (err: any) {
    const status = typeof err.status === 'number' ? err.status : -1;
    const stderr =
      err.stderr && Buffer.isBuffer(err.stderr)
        ? err.stderr.toString('utf8').trim()
        : err.message || '';
    return { code: status, stdout: '', stderr };
  }
}

function checkAvailability(): { available: boolean; error?: string } {
  const now = Date.now();
  if (now - availabilityCheckedAt < AVAILABILITY_CACHE_TTL_MS) {
    return { available: esAvailable, error: availabilityError };
  }

  availabilityCheckedAt = now;
  availabilityError = undefined;

  if (!findEsPath()) {
    esAvailable = false;
    return { available: false, error: availabilityError };
  }

  const probe = probeEsSync();
  if (probe.code === 0) {
    esAvailable = true;
    return { available: true };
  }
  esAvailable = false;
  // Don't cache this state — re-probe on the next call so the search
  // recovers as soon as Everything finishes loading its database.
  availabilityCheckedAt = 0;
  availabilityError =
    probe.stderr || `es.exe failed with exit code ${probe.code}`;
  logDebug('warn', `es.exe availability probe failed: ${availabilityError}`);
  if (probe.code === ES_EXIT_IPC_NOT_FOUND || probe.code === -1) {
    logDebug('warn', 'Everything not reachable — auto-start was triggered.');
    triggerAutoStart();
  }
  return { available: false, error: availabilityError };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Build the query es.exe should run, merging base query + options. */
function buildQuery(query: string, options: EverythingSearchOptions): string {
  let everythingQuery = query || '';

  if (options.pathPrefix) {
    let prefix = options.pathPrefix;
    if (!prefix.endsWith('\\') && !prefix.endsWith('/')) {
      prefix += '\\';
    }
    everythingQuery += ` path:"${prefix}"`;
  }

  if (options.extensions && options.extensions.length > 0) {
    everythingQuery += ` ext:${options.extensions.join(';')}`;
  }

  if (options.minSize !== undefined || options.maxSize !== undefined) {
    const min = options.minSize ?? 0;
    const max = options.maxSize ?? Number.MAX_SAFE_INTEGER;
    everythingQuery += ` size:${min}-${max}`;
  }

  if (
    options.modifiedAfter !== undefined ||
    options.modifiedBefore !== undefined
  ) {
    const after = options.modifiedAfter
      ? formatLocalDate(new Date(options.modifiedAfter))
      : '';
    const before = options.modifiedBefore
      ? formatLocalDate(new Date(options.modifiedBefore))
      : '';
    everythingQuery += ` dm:${after}-${before}`;
  }

  return everythingQuery.trim();
}

/** FILETIME (100ns since 1601) → epoch ms. */
function fileTimeToEpochMs(ft: bigint): number {
  return Number((ft - 116444736000000000n) / 10000n);
}

/**
 * Parse the UTF-8 TSV file es.exe -export-tsv wrote into EverythingResult[].
 * Column order (requested on the command line):
 *   [full path]  size  dm(FILETIME)  attributes
 */
function parseTsvFile(content: string): EverythingResult[] {
  const results: EverythingResult[] = [];
  const text = content.replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) {
      // eslint-disable-next-line no-continue -- skip blank trailing lines
      continue;
    }
    // Tab is never legal in a Windows filename, so split is safe.
    const [rawPath, sizeStr, dmStr, attrsStr] = line.split('\t');
    if (!rawPath) {
      // eslint-disable-next-line no-continue -- skip malformed rows
      continue;
    }
    // es.exe appends a trailing backslash to folder results.
    // eslint-disable-next-line no-bitwise -- FILE_ATTRIBUTE_DIRECTORY flag
    const isFolder = (Number(attrsStr) & 16) !== 0;
    let fullPath = rawPath;
    if (isFolder && (fullPath.endsWith('\\') || fullPath.endsWith('/'))) {
      fullPath = fullPath.slice(0, -1);
    }
    const normalisedPath = fullPath.replace(/\\/g, '/');
    results.push({
      path: normalisedPath,
      name: path.basename(normalisedPath),
      isFile: !isFolder,
      size: Number(sizeStr) || 0,
      lmdt: dmStr ? fileTimeToEpochMs(BigInt(dmStr.replace(/\s/g, ''))) : 0,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Serialised search queue
// ---------------------------------------------------------------------------

let queueTail = Promise.resolve<EverythingSearchResponse>({
  available: true,
  results: [],
});

function enqueueSearch(
  query: string,
  options: EverythingSearchOptions = {},
): Promise<EverythingSearchResponse> {
  const task = async (): Promise<EverythingSearchResponse> => {
    const avail = checkAvailability();
    if (!avail.available) {
      return { available: false, results: [], error: avail.error };
    }

    const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
    const everythingQuery = buildQuery(query, options);

    try {
      lastQuery = everythingQuery;
      lastQueryAt = Date.now();
      logDebug('info', `Query: "${everythingQuery}" (max ${maxResults})`);

      const tmpFile = path.join(
        os.tmpdir(),
        `tagspaces-everything-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}.tsv`,
      );

      // One es.exe run answers the query (export to a temp file — stdout
      // truncates non-ASCII); a second reports the un-capped match count.
      const resultsPromise = runEs([
        '-tsv',
        '-no-header',
        '-utf8-bom',
        '-size',
        '-dm',
        '-date-format',
        '2',
        '-attributes',
        '-n',
        String(maxResults),
        '-export-tsv',
        tmpFile,
        everythingQuery,
      ]);
      const countPromise = runEs(['-get-result-count', everythingQuery]);

      const [resultsRun, countRun] = await Promise.all([
        resultsPromise,
        countPromise,
      ]);

      if (resultsRun.code !== 0) {
        // Error 8 = Everything not reachable; anything else → query/io error.
        const msg =
          resultsRun.stderr.trim() ||
          `es.exe query failed with exit code ${resultsRun.code}`;
        lastError = msg;
        logDebug('error', lastError);
        if (
          resultsRun.code === null ||
          resultsRun.code === ES_EXIT_IPC_NOT_FOUND
        ) {
          triggerAutoStart();
        }
        try {
          fs.unlinkSync(tmpFile);
        } catch {
          /* already gone */
        }
        return { available: false, results: [], error: msg };
      }

      let results: EverythingResult[] = [];
      try {
        const content = fs.readFileSync(tmpFile, 'utf8');
        results = parseTsvFile(content);
      } catch (err: any) {
        lastError = `Failed to read es.exe output: ${err.message}`;
        logDebug('error', lastError);
        return { available: false, results: [], error: lastError };
      } finally {
        try {
          fs.unlinkSync(tmpFile);
        } catch {
          /* already gone */
        }
      }

      const totalCount =
        countRun.code === 0 && /^\d+$/.test(countRun.stdout.trim())
          ? Number(countRun.stdout.trim())
          : results.length;
      lastResultCount = results.length;
      lastError = undefined;
      logDebug(
        'info',
        `Query returned ${results.length}/${totalCount} results.`,
      );

      if (results.length > 0) {
        const first = results[0];
        logDebug(
          'info',
          `First result: path="${first.path}" name="${first.name}" isFile=${first.isFile} size=${first.size}`,
        );
      }

      return {
        available: true,
        results,
        totalCount,
      };
    } catch (err: any) {
      lastError = `Everything search error: ${err.message}`;
      logDebug('error', lastError);
      return {
        available: false,
        results: [],
        error: lastError,
      };
    }
  };

  queueTail = queueTail.then(task, task); // continue chain even on error
  return queueTail;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isEverythingAvailable(): {
  available: boolean;
  error?: string;
} {
  return checkAvailability();
}

export function searchEverything(
  query: string,
  options?: EverythingSearchOptions,
): Promise<EverythingSearchResponse> {
  return enqueueSearch(query, options);
}

// ---------------------------------------------------------------------------
// Debug info for the renderer debug dialog
// ---------------------------------------------------------------------------

export interface IpcProbeResult {
  windowFound: boolean;
  sendMessageOk: boolean;
  dbLoaded?: boolean;
  error?: string;
}

export interface EverythingDebugInfo {
  platform: string;
  esPath?: string;
  exePath?: string;
  customPath?: string;
  everythingInstalled: boolean;
  everythingRunning: boolean;
  tagspacesElevated: boolean;
  libraryLoaded: boolean;
  dbLoaded: boolean;
  available: boolean;
  availabilityError?: string;
  ipc?: IpcProbeResult;
  autoStartInFlight: boolean;
  lastAutoStartAt?: number;
  lastQuery?: string;
  lastQueryAt?: number;
  lastResultCount?: number;
  lastError?: string;
  log: EverythingDebugEntry[];
}

let lastEsProbeAt = 0;
let esPathCache: string | undefined;
// The debug dialog polls every second; cache the connection probe so we do
// not spawn es.exe 60x/minute while it is open.
let connectionCache: { at: number; ok: boolean; error?: string } | undefined;

function getProbeCached(): { exePath: string | undefined; running: boolean } {
  if (!probeCache || Date.now() - probeCache.at > PROBE_CACHE_TTL_MS) {
    probeCache = {
      at: Date.now(),
      exePath: findEverythingExe(),
      running: isEverythingRunning(),
    };
  }
  return probeCache;
}

function getConnectionCached(): { ok: boolean; error?: string } {
  if (
    !connectionCache ||
    Date.now() - connectionCache.at > PROBE_CACHE_TTL_MS
  ) {
    const probe = probeEsSync();
    connectionCache = {
      at: Date.now(),
      ok: probe.code === 0,
      error: probe.stderr || undefined,
    };
  }
  return { ok: connectionCache.ok, error: connectionCache.error };
}

export function getDebugInfo(): EverythingDebugInfo {
  const probe = getProbeCached();
  // esPath is cached once found; while missing, re-probe at most once per
  // TTL window instead of on every poll.
  if (!esPathCache && Date.now() - lastEsProbeAt > PROBE_CACHE_TTL_MS) {
    lastEsProbeAt = Date.now();
    esPathCache = findEsPath();
  }
  const connected = getConnectionCached();
  return {
    platform: process.platform,
    esPath: esPathCache,
    exePath: probe.exePath,
    customPath: customEverythingPath,
    everythingInstalled: !!probe.exePath,
    everythingRunning: probe.running,
    tagspacesElevated: isSelfElevated(),
    libraryLoaded: !!esPathCache,
    dbLoaded: connected.ok,
    available: connected.ok,
    availabilityError,
    ipc: {
      windowFound: probe.running,
      sendMessageOk: connected.ok,
      dbLoaded: connected.ok,
      error: connected.ok ? undefined : connected.error,
    },
    autoStartInFlight: !!autoStartInFlight,
    lastAutoStartAt: lastAutoStartAt || undefined,
    lastQuery,
    lastQueryAt,
    lastResultCount,
    lastError,
    log: [...debugLog],
  };
}
