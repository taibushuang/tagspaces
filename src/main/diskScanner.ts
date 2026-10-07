/**
 * TagSpaces - universal file and folder organizer
 * Copyright (C) 2024-present TagSpaces GmbH
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License (version 3) as
 * published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type DiskScanProfile =
  | 'programming'
  | 'office'
  | 'design'
  | 'academic'
  | 'mixed'
  | 'other';

export type DirSummary = {
  path: string;
  fileCount: number;
  totalSize: number;
  topExts: Array<{ ext: string; count: number }>;
};

export type DiskScanResult = {
  dirs: DirSummary[];
  extHistogram: Array<{ ext: string; count: number }>;
  largestDirs: Array<{ path: string; totalSize: number }>;
  truncated: boolean;
  scannedRoots: string[];
  platform: 'win32' | 'darwin' | 'linux' | string;
  error?: string;
};

export type DiskScanOptions = {
  roots?: string[];
  profile?: DiskScanProfile;
  depth?: number;
  maxEntries?: number;
  maxDirs?: number;
  /** Wall clock budget in ms. Exceeding it stops the scan early (truncated). */
  timeoutMs?: number;
};

export const DEFAULT_MAX_ENTRIES = 2000;
export const DEFAULT_MAX_DIRS = 50;
export const DEFAULT_DEPTH = 4;
export const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * Extensions that are always counted regardless of the work profile:
 * archives / installers (the stuff that piles up in Downloads) + common media.
 */
export const ALWAYS_COUNT_EXTS = [
  'zip',
  'rar',
  '7z',
  'gz',
  'tar',
  'exe',
  'msi',
  'dmg',
  'pkg',
  'iso',
  'torrent',
  'jpg',
  'jpeg',
  'png',
  'heic',
  'webp',
  'mp4',
  'mov',
  'mp3',
  'wav',
];

/**
 * Directories that must never be opened, even if the user points a root at
 * them: credentials, keychains, browser profiles, chat databases.
 */
export const SENSITIVE_DIRS = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.config/gh',
  '.kube',
  'Library/Keychains',
  'Library/Application Support/Google/Chrome',
  'Library/Application Support/BraveSoftware',
  'Library/Application Support/Firefox',
  'Library/Application Support/Microsoft Edge',
  'Library/Messages',
  'Library/Containers/com.tencent.xinWeChat',
  'Library/Group Containers/group.com.tencent.xinWeChat',
  'AppData/Local/Microsoft/Edge',
  'AppData/Local/Google/Chrome',
  'AppData/Roaming/Telegram Desktop',
  'AppData/Local/WhatsApp',
]);

export const SKIP_DIR_PATTERNS = [
  '/System',
  '/private/var/db',
  '/private/var/folders',
  '/Library/Caches',
  '/Volumes',
  '/.Trashes',
  '/.Spotlight-V100',
  '/proc',
  '/sys',
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  'C:\\Users\\Default',
  'node_modules',
  '.git',
  '__pycache__',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
];

/** Test helper: should this directory be pruned from the traversal? */
export function shouldSkipDir(dirPath: string): boolean {
  const lower = dirPath.toLowerCase();
  for (const p of SKIP_DIR_PATTERNS) {
    if (lower.includes(p.toLowerCase())) return true;
  }
  const base = path.basename(dirPath);
  if (base.startsWith('.') && base !== '.ts' && base !== '.tagspaces') {
    return true;
  }
  return false;
}

/** Test helper: does this path touch a sensitive area? */
export function isSensitiveDir(dirPath: string): boolean {
  const norm = dirPath.replace(/\\/g, '/');
  for (const s of SENSITIVE_DIRS) {
    if (norm.includes(`/${s}`) || norm.endsWith(`/${s}`) || norm === s) {
      return true;
    }
  }
  return false;
}

export function getProfileExts(profile: DiskScanProfile | undefined): string[] {
  switch (profile) {
    case 'programming':
      return [
        'ts',
        'tsx',
        'js',
        'jsx',
        'py',
        'go',
        'rs',
        'java',
        'c',
        'cpp',
        'h',
        'json',
        'toml',
        'yaml',
        'yml',
        'md',
      ];
    case 'office':
      return [
        'doc',
        'docx',
        'xls',
        'xlsx',
        'ppt',
        'pptx',
        'pdf',
        'txt',
        'md',
        'csv',
      ];
    case 'design':
      return [
        'psd',
        'ai',
        'sketch',
        'fig',
        'png',
        'jpg',
        'jpeg',
        'webp',
        'svg',
        'xcf',
      ];
    case 'academic':
      return ['pdf', 'docx', 'tex', 'bib', 'txt', 'md', 'csv'];
    case 'mixed':
    case 'other':
    default:
      return [
        'pdf',
        'docx',
        'xlsx',
        'pptx',
        'txt',
        'md',
        'js',
        'ts',
        'py',
        'json',
      ];
  }
}

type DirBucket = {
  fileCount: number;
  totalSize: number;
  topExts: Map<string, number>;
};

/** Normalise to forward slashes without a trailing slash. */
function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

function countSegments(p: string): number {
  const norm = normalizeSlashes(p);
  return norm.split('/').filter(Boolean).length;
}

/**
 * Every recorded file is attributed to its parent directory *and* to the
 * ancestors below the scan root, so that both leaf folders ("Documents/Work/ClientA")
 * and broad ones ("Documents") surface in the result. The caller can then pick a
 * sensible granularity instead of seeing only deep leaves.
 */
function ancestorsUpTo(
  filePath: string,
  root: string,
  maxLevels: number,
): string[] {
  const normRoot = normalizeSlashes(root).toLowerCase();
  const out: string[] = [];
  let cur = path.dirname(normalizeSlashes(filePath));
  let levels = 0;
  while (cur && levels < maxLevels) {
    out.push(cur);
    if (normalizeSlashes(cur).toLowerCase() === normRoot) {
      break;
    }
    const parent = path.dirname(cur);
    if (parent === cur) {
      break;
    }
    cur = parent;
    levels += 1;
  }
  return out;
}

export async function scanDisks(
  options: DiskScanOptions = {},
): Promise<DiskScanResult> {
  const platform = process.platform;
  const roots =
    options.roots && options.roots.length > 0 ? options.roots : [os.homedir()];
  const depth = options.depth ?? DEFAULT_DEPTH;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxDirs = options.maxDirs ?? DEFAULT_MAX_DIRS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  const profileExts = new Set(
    getProfileExts(options.profile).map((e) => e.toLowerCase()),
  );
  const allExts = new Set([...profileExts, ...ALWAYS_COUNT_EXTS]);

  const extMap = new Map<string, number>();
  const dirMap = new Map<string, DirBucket>();
  let recorded = 0;
  let truncated = false;

  function record(filePath: string, size: number, ext: string, dir: string) {
    let bucket = dirMap.get(dir);
    if (!bucket) {
      bucket = { fileCount: 0, totalSize: 0, topExts: new Map() };
      dirMap.set(dir, bucket);
    }
    bucket.fileCount += 1;
    bucket.totalSize += size;
    bucket.topExts.set(ext, (bucket.topExts.get(ext) ?? 0) + 1);
    extMap.set(ext, (extMap.get(ext) ?? 0) + 1);
  }

  function recordWithAncestors(
    filePath: string,
    size: number,
    ext: string,
    root: string,
  ) {
    // ancestorsUpTo starts at the file's own parent, so this covers the
    // direct parent plus every ancestor up to the scan root.
    for (const ancestor of ancestorsUpTo(filePath, root, depth)) {
      record(filePath, size, ext, ancestor);
    }
  }

  function timedOut(): boolean {
    if (Date.now() > deadline) {
      truncated = true;
      return true;
    }
    return false;
  }

  if (platform === 'win32') {
    // Windows: targeted Everything (es.exe) query goes here — aggregation of
    // results into this same dirMap. Left empty until validated on a Windows
    // machine; until then Windows reports an explicit not-implemented error
    // instead of silently doing a full-disk walk.
    return {
      dirs: [],
      extHistogram: [],
      largestDirs: [],
      truncated: false,
      scannedRoots: roots,
      platform,
      error:
        'disk scan on Windows is not implemented yet (Everything integration pending); please run this on macOS or wait for a Windows build with es.exe support',
    };
  }
  {
    async function processDir(
      dir: string,
      currentDepth: number,
      scanRoot: string,
    ) {
      if (truncated) return;
      if (timedOut()) return;
      if (isSensitiveDir(dir) || shouldSkipDir(dir)) return;
      if (currentDepth > depth) return;
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (truncated) break;
          if (timedOut()) break;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            await processDir(full, currentDepth + 1, scanRoot);
          } else if (e.isFile()) {
            // Targeted scan: only files matching the work profile (plus
            // archives/media) are stat-ed and counted. Directory listings are
            // still enumerated (unavoidable for traversal), but unrelated files
            // are never recorded or returned.
            const ext =
              path.extname(full).replace('.', '').toLowerCase() || 'unknown';
            if (!allExts.has(ext)) continue;
            recorded += 1;
            if (recorded > maxEntries) {
              truncated = true;
              break;
            }
            try {
              const st = await fs.promises.stat(full);
              recordWithAncestors(full, st.size, ext, scanRoot);
            } catch {
              // EPERM/EACCES or a broken symlink — skip this one file.
            }
          }
        }
      } catch {
        // EPERM/EACCES on the directory itself (TCC prompts on macOS): give up
        // on this branch silently. The caller tells the user to grant access.
        return;
      }
    }

    for (const r of roots) {
      if (timedOut()) break;
      try {
        const st = await fs.promises.stat(r);
        if (st.isDirectory()) await processDir(r, 0, r);
      } catch {
        // root missing or unreadable — skip
      }
    }
  }

  const dirsArr: DirSummary[] = Array.from(dirMap.entries())
    .sort((a, b) => b[1].totalSize - a[1].totalSize)
    .slice(0, maxDirs)
    .map(([p, d]) => ({
      path: p,
      fileCount: d.fileCount,
      totalSize: d.totalSize,
      topExts: Array.from(d.topExts.entries())
        .sort((x, y) => y[1] - x[1])
        .slice(0, 5)
        .map(([ext, count]) => ({ ext, count })),
    }));

  const extHistogram = Array.from(extMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([ext, count]) => ({ ext, count }));

  const largestDirs = dirsArr.map((d) => ({
    path: d.path,
    totalSize: d.totalSize,
  }));

  return {
    dirs: dirsArr,
    extHistogram,
    largestDirs,
    truncated,
    scannedRoots: roots,
    platform,
  };
}
