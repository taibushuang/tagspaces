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

/**
 * Folder-organization engine ported from moli-xia/desktop-cleaner (MIT) —
 * its cleaner_core.py classification rules and planning logic, adapted to
 * TagSpaces entries. Pure functions, no electron / IO / renderer deps, so the
 * whole planning logic is unit-testable.
 *
 * Semantics kept from the original:
 * - categories map extensions → target sub-folder; a category whose extension
 *   list contains `__FOLDER__` owns folders; the single category with an EMPTY
 *   extension list is the catch-all "other" bucket (must exist, exactly one);
 * - compound extensions (.tar.gz) and longest-suffix-first matching;
 * - planning never mutates anything — it only computes destinations, and
 *   skipping rules protect system/hidden/oversized files and existing
 *   category folders;
 * - execution (moves) must never overwrite: conflicts are skipped and
 *   reported, or restored under a unique name ("name (1).ext").
 */

/** Marker extension inside a category: that category owns folders. */
export const FOLDER_MARKER = '__FOLDER__';
const DEFAULT_MAX_FILE_SIZE_MB = 100;

export type OrganizeCategory = {
  /** Lowercase extensions with a leading dot, or [FOLDER_MARKER] for folders, or [] for the catch-all. */
  extensions: string[];
  icon?: string;
};

export type OrganizeConfig = {
  excludedExtensions: string[];
  maxFileSizeMb: number;
  /** Whether plain folders are organized too (they go to the FOLDER_MARKER category). */
  includeFolders: boolean;
  categories: Record<string, OrganizeCategory>;
};

/** Minimal structural view of an entry — FileSystemEntry is structurally compatible. */
export type OrganizeEntry = {
  name: string;
  path: string;
  isFile: boolean;
  size?: number;
  lmdt?: number;
  isSymbolicLink?: boolean;
};

export type Fingerprint = { size: number; lmdt: number };

export type OrganizeRow = {
  path: string;
  name: string;
  size: number;
  isFolder: boolean;
  /** Destination category ('' for skipped rows). */
  category: string;
  /** Absolute destination path ('' for skipped rows). */
  targetPath: string;
  fingerprint: Fingerprint;
  /** Empty when organizable; otherwise the skip reason (user-facing). */
  reason: string;
};

export const ORGANIZE_DEFAULT_CONFIG: OrganizeConfig = {
  excludedExtensions: ['.lnk', '.url'],
  maxFileSizeMb: DEFAULT_MAX_FILE_SIZE_MB,
  includeFolders: false,
  categories: {
    Documents: {
      extensions: [
        '.txt',
        '.doc',
        '.docx',
        '.pdf',
        '.xls',
        '.xlsx',
        '.ppt',
        '.pptx',
        '.md',
        '.csv',
        '.rtf',
        '.odt',
      ],
      icon: '📄',
    },
    Images: {
      extensions: [
        '.jpg',
        '.jpeg',
        '.png',
        '.gif',
        '.bmp',
        '.svg',
        '.ico',
        '.webp',
        '.heic',
      ],
      icon: '🖼️',
    },
    Videos: {
      extensions: ['.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv', '.webm'],
      icon: '🎬',
    },
    Audio: {
      extensions: ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.wma', '.m4a'],
      icon: '🎵',
    },
    Archives: {
      extensions: ['.zip', '.rar', '.7z', '.tar', '.gz', '.tar.gz'],
      icon: '📦',
    },
    Apps: {
      extensions: ['.exe', '.msi', '.deb', '.dmg'],
      icon: '💻',
    },
    Folders: { extensions: [FOLDER_MARKER], icon: '📂' },
    Other: { extensions: [], icon: '📁' },
  },
};

function normalizeExtensions(value: string | string[]): string[] {
  let list: string[];
  if (typeof value === 'string') {
    list = value
      .split(/[,，;；\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (Array.isArray(value)) {
    list = value;
  } else {
    throw new Error('扩展名必须是列表或逗号分隔的文本');
  }
  const result: string[] = [];
  for (let ext of list) {
    if (typeof ext !== 'string') throw new Error('扩展名必须是文本');
    ext = ext.trim().toLowerCase();
    if (!ext) continue;
    if (ext === '__folder__') ext = FOLDER_MARKER;
    else {
      ext = '.' + ext.replace(/^\./, '');
      if (!/^\.[\w+-]+(?:\.[\w+-]+)*$/.test(ext)) {
        throw new Error('无效的扩展名：' + ext);
      }
    }
    if (!result.includes(ext)) result.push(ext);
  }
  return result;
}

const WINDOWS_RESERVED = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 10 }, (_, i) => `COM${i}`),
  ...Array.from({ length: 10 }, (_, i) => `LPT${i}`),
]);

function validCategoryName(name: string): void {
  if (typeof name !== 'string' || !name.trim() || name !== name.trim()) {
    throw new Error('分类名称不能为空或带有首尾空格');
  }
  if (
    name.length > 80 ||
    /[<>:"/\\|?*\x00-\x1f]/.test(name) ||
    name.endsWith('.')
  ) {
    throw new Error('分类名称不能包含路径符号、控制字符或结尾句点');
  }
  if (WINDOWS_RESERVED.has(name.split('.')[0].toUpperCase())) {
    throw new Error('不能使用 Windows 保留名称');
  }
}

/**
 * Deep-merge raw config over the defaults and validate. Throws on invalid
 * input. Returns a fully normalized config (lowercased extensions, deduped,
 * guaranteed one folder category and exactly one catch-all category).
 */
export function validateOrganizeConfig(raw: unknown): OrganizeConfig {
  if (!raw || typeof raw !== 'object')
    return structuredClone(ORGANIZE_DEFAULT_CONFIG);
  const r = raw as Record<string, unknown>;
  const result: OrganizeConfig = {
    excludedExtensions: normalizeExtensions(
      (r.excludedExtensions as string | string[] | undefined) ??
        ORGANIZE_DEFAULT_CONFIG.excludedExtensions,
    ),
    maxFileSizeMb:
      (r.maxFileSizeMb as number | undefined) ??
      ORGANIZE_DEFAULT_CONFIG.maxFileSizeMb,
    includeFolders:
      (r.includeFolders as boolean | undefined) ??
      ORGANIZE_DEFAULT_CONFIG.includeFolders,
    categories: {},
  };
  const max = result.maxFileSizeMb;
  if (
    typeof max === 'boolean' ||
    typeof max !== 'number' ||
    !Number.isFinite(max) ||
    max < 0
  ) {
    throw new Error('大小上限必须为非负数；0 表示不限大小');
  }
  const rawCategories =
    (r.categories as Record<string, unknown> | undefined) ?? {};
  const catKeys = Object.keys(rawCategories).length
    ? rawCategories
    : ORGANIZE_DEFAULT_CONFIG.categories;
  const seenExt: Record<string, string> = {};
  const seenNames = new Set<string>();
  for (const [name, info] of Object.entries(catKeys)) {
    validCategoryName(name);
    const lower = name.toLocaleLowerCase();
    if (seenNames.has(lower)) throw new Error('分类名称重复：' + name);
    seenNames.add(lower);
    let cat: OrganizeCategory;
    if (Array.isArray(info)) {
      cat = { extensions: normalizeExtensions(info), icon: '📁' };
    } else if (info && typeof info === 'object') {
      const ci = info as Record<string, unknown>;
      if (!Array.isArray(ci.extensions))
        throw new Error('分类缺少扩展名：' + name);
      cat = {
        extensions: normalizeExtensions(ci.extensions),
        icon: typeof ci.icon === 'string' ? ci.icon : '📁',
      };
    } else {
      throw new Error('分类缺少扩展名：' + name);
    }
    for (const ext of cat.extensions) {
      if (ext in seenExt) {
        throw new Error(`扩展名 ${ext} 同时属于 ${seenExt[ext]} 和 ${name}`);
      }
      seenExt[ext] = name;
    }
    result.categories[name] = cat;
  }
  // Guarantee a catch-all (single empty-extensions category).
  const fallbacks = Object.entries(result.categories).filter(
    ([, c]) => c.extensions.length === 0,
  );
  if (fallbacks.length === 0) {
    result.categories.Other = { extensions: [], icon: '📁' };
  } else if (fallbacks.length > 1) {
    throw new Error('必须且只能有一个空扩展名分类，用于接收其他文件');
  }
  if (!(FOLDER_MARKER in seenExt)) {
    result.categories.Folders = { extensions: [FOLDER_MARKER], icon: '📂' };
  }
  return result;
}

export function fingerprint(
  entry: Pick<OrganizeEntry, 'size' | 'lmdt'>,
): Fingerprint {
  return { size: Number(entry.size) || 0, lmdt: Number(entry.lmdt) || 0 };
}

export function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return a.size === b.size && a.lmdt === b.lmdt;
}

export function isHiddenName(name: string): boolean {
  const lower = name.toLocaleLowerCase();
  return (
    name.startsWith('.') || lower === 'desktop.ini' || lower === 'thumbs.db'
  );
}

/**
 * Unique destination name: if `path` is already taken (in `reserved`, case
 * insensitive), append " (1)", " (2)", … like desktop-cleaner.
 */
export function uniqueTargetName(path: string, reserved: Set<string>): string {
  let candidate = path;
  let n = 1;
  const sep = path.includes('\\') ? '\\' : '/';
  while (reserved.has(candidate.toLocaleLowerCase())) {
    const dot = path.lastIndexOf('.');
    const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    if (dot > slash + 1) {
      candidate = `${path.slice(0, dot)} (${n})${path.slice(dot)}`;
    } else {
      candidate = `${path} (${n})`;
    }
    n += 1;
  }
  reserved.add(candidate.toLocaleLowerCase());
  return candidate;
}

function joinPath(root: string, name: string): string {
  const sep = root.includes('\\') ? '\\' : '/';
  return root.endsWith(sep) ? root + name : root + sep + name;
}

/**
 * Compute the organization plan for the direct children of `root` (pure).
 * Entries come from listChildren; nothing is read from disk and nothing is
 * moved. Returns organizable rows (sorted, non-skipped first) and skipped rows.
 */
export function planOrganize(
  root: string,
  entries: OrganizeEntry[],
  configInput?: unknown,
): { organizable: OrganizeRow[]; skipped: OrganizeRow[] } {
  const config = validateOrganizeConfig(configInput);
  const categories = config.categories;
  const folderCategory = Object.entries(categories).find(([, c]) =>
    c.extensions.includes(FOLDER_MARKER),
  )?.[0];
  const fallback = Object.entries(categories).find(
    ([, c]) => c.extensions.length === 0,
  )?.[0];
  // Rules sorted by extension length (longest suffix first) so .tar.gz wins over .gz.
  const rules = Object.entries(categories)
    .flatMap(([name, c]) =>
      c.extensions
        .filter((e) => e !== FOLDER_MARKER)
        .map((e) => [e, name] as const),
    )
    .sort((a, b) => b[0].length - a[0].length);

  const reserved = new Set<string>();
  const organizable: OrganizeRow[] = [];
  const skipped: OrganizeRow[] = [];
  const categoryNames = new Set(
    Object.keys(categories).map((n) => n.toLocaleLowerCase()),
  );

  for (const entry of entries) {
    const row: OrganizeRow = {
      path: entry.path,
      name: entry.name,
      size: entry.isFile ? Number(entry.size) || 0 : 0,
      isFolder: !entry.isFile,
      category: '',
      targetPath: '',
      fingerprint: fingerprint(entry),
      reason: '',
    };
    const lower = entry.name.toLocaleLowerCase();
    if (entry.isSymbolicLink) {
      row.reason = '符号链接，跳过';
    } else if (isHiddenName(entry.name)) {
      row.reason = '系统或隐藏项';
    } else if (!entry.isFile) {
      if (categoryNames.has(lower)) {
        row.reason = '已是分类文件夹';
      } else if (!config.includeFolders) {
        row.reason = '默认保留文件夹';
      } else if (folderCategory) {
        row.category = folderCategory;
      } else {
        row.reason = '未配置文件夹分类';
      }
    } else if (config.excludedExtensions.some((e) => lower.endsWith(e))) {
      row.reason = '排除的扩展名';
    } else if (
      config.maxFileSizeMb > 0 &&
      row.size > config.maxFileSizeMb * 1024 * 1024
    ) {
      row.reason = `超过大小上限（${config.maxFileSizeMb}MB）`;
    } else {
      const match = rules.find(([ext]) => lower.endsWith(ext));
      row.category = match ? match[1] : fallback || 'Other';
    }

    if (!row.category || row.reason) {
      if (row.reason) {
        skipped.push(row);
      } else {
        row.reason = '无匹配分类';
        skipped.push(row);
      }
      continue;
    }
    row.targetPath = uniqueTargetName(
      joinPath(joinPath(root, row.category), entry.name),
      reserved,
    );
    organizable.push(row);
  }

  const sorted = [...organizable].sort((a, b) =>
    a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase()),
  );
  return { organizable: sorted, skipped };
}

export type OrganizeMove = { from: string; to: string; reason?: string };

/**
 * Validate an execution plan: `from` must be a direct child of `root` and `to`
 * must be `<root>/<one-level category folder>/<name>`. Returns the valid moves
 * plus the rejected ones (with reasons) — callers skip the invalid ones.
 */
export function validateMovePlan(
  root: string,
  moves: Array<{ from: string; to: string }>,
): { valid: OrganizeMove[]; invalid: OrganizeMove[] } {
  const sep = root.includes('\\') ? '\\' : '/';
  const norm = (p: string) => String(p || '').replace(/[\\/]+$/, '');
  const rootNorm = norm(root);
  const valid: OrganizeMove[] = [];
  const invalid: OrganizeMove[] = [];
  for (const mv of moves || []) {
    const from = norm(mv.from);
    const to = norm(mv.to);
    const reject = (reason: string) => invalid.push({ from, to, reason });
    if (!from || !to) {
      reject('路径为空');
      continue;
    }
    if (from.toLocaleLowerCase() === to.toLocaleLowerCase()) {
      reject('源与目标相同');
      continue;
    }
    const fromIsChild =
      from.startsWith(rootNorm + sep) &&
      from.slice(rootNorm.length + 1).split(/[\\/]/).length === 1;
    if (!fromIsChild) {
      reject('源必须是目录的直接子项');
      continue;
    }
    const rel = to.slice(rootNorm.length + 1);
    const parts = rel.split(/[\\/]/);
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      reject('目标必须是 <root>/<分类文件夹>/<文件名>');
      continue;
    }
    if (/\.\./.test(rel)) {
      reject('路径含 .. 逃逸');
      continue;
    }
    valid.push({ from, to });
  }
  return { valid, invalid };
}
