/**
 * TagSpaces - universal file and folder organizer
 * Copyright (C) 2017-present TagSpaces GmbH
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

import { TS } from '-/tagspaces.namespace';
import {
  extractFileNameWithoutExt,
  extractFileExtension,
  extractContainingDirectoryPath,
} from '@tagspaces/tagspaces-common/paths';

export interface FileVersionGroup {
  baseName: string; // 去掉版本后缀的基础文件名
  extension: string; // 文件扩展名
  files: TS.FileSystemEntry[]; // 组内所有文件，按版本号降序
  toKeep: TS.FileSystemEntry[]; // 最新两个版本
  toDelete: TS.FileSystemEntry[]; // 待删除的旧版本
}

// Version suffix pattern: matches trailing -v1, _v2, ' v3', (v1), -V1.2 and
// (guarded below) bare numbers like '-2' / ' (3)'.
// Group 1 = optional 'v' prefix, group 2 = the version number.
const VERSION_PATTERN = /[-_\s(](v)?(\d+(?:\.\d+)*)[-_\s)]?$/i;

// Version cleanup targets edited office documents only. This alone excludes
// the classic false positives: photo sequences (IMG_0001.jpg), logs, data
// files, etc.
const ELIGIBLE_EXTENSIONS = new Set([
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx', // MS Office
  'wps',
  'et',
  'dps', // WPS Office
  'odt',
  'ods',
  'odp', // OpenDocument
]);

// Short stems like "IMG", "a", "b" are almost never versioned documents.
// CJK characters count double so that e.g. 6 Chinese characters
// ("月度经营分析报告") pass the threshold the same way 12 ASCII chars do.
const MIN_BASE_NAME_WEIGHTED_LENGTH = 12;
const CJK_CHAR = /[\u2E80-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/;

function weightedLength(text: string): number {
  let weight = 0;
  for (const ch of text) {
    weight += CJK_CHAR.test(ch) ? 2 : 1;
  }
  return weight;
}

interface ParsedFileName {
  baseName: string;
  version: number[];
  versionString: string;
}

/**
 * 从文件名中解析版本信息
 * 返回 null 表示文件名不包含版本模式
 */
function parseVersionFromName(
  fileNameWithoutExt: string,
): ParsedFileName | null {
  const match = fileNameWithoutExt.match(VERSION_PATTERN);
  if (!match) return null;

  const hasVPrefix = !!match[1];
  const versionString = match[2];

  if (!hasVPrefix) {
    // Leading zeros indicate a sequence number (IMG_0001, scan_0042), not a
    // version — nobody writes "v0001".
    if (/^0\d/.test(versionString)) return null;
    // A bare 4-digit year ("report-2024", "budget (2024)") marks parallel
    // yearly files, not an evolving version series. With an explicit 'v'
    // prefix ("report-v2024") the author's intent is clear, so it passes.
    if (/^(19|20)\d{2}$/.test(versionString)) return null;
  }

  const version = versionString.split('.').map(Number);
  const baseName = fileNameWithoutExt.slice(0, match.index).trim();

  if (weightedLength(baseName) < MIN_BASE_NAME_WEIGHTED_LENGTH) return null;

  return { baseName, version, versionString };
}

/**
 * 比较两个版本号数组，返回负数表示 a < b，0 表示相等，正数表示 a > b
 */
function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const va = a[i] || 0;
    const vb = b[i] || 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/**
 * 将文件列表按版本模式分组
 * @param entries 文件系统条目列表（通常来自搜索结果）
 * @param keepCount 每组保留的最新版本数，默认为 2
 * @returns 版本分组数组，只返回包含 2 个及以上文件的组
 */
export function groupFileVersions(
  entries: TS.FileSystemEntry[],
  keepCount: number = 2,
): FileVersionGroup[] {
  // 只处理文件
  const files = entries.filter((e) => e.isFile);

  // 按 基础名+扩展名 分组
  const groups = new Map<
    string,
    { entry: TS.FileSystemEntry; parsed: ParsedFileName }[]
  >();

  for (const file of files) {
    const ext = extractFileExtension(file.name).toLowerCase();
    if (!ELIGIBLE_EXTENSIONS.has(ext)) continue;

    const nameWithoutExt = extractFileNameWithoutExt(file.name);
    const parsed = parseVersionFromName(nameWithoutExt);
    if (!parsed) continue;

    const key = `${parsed.baseName.toLowerCase()}.${ext}`;

    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push({ entry: file, parsed });
  }

  // 构建结果
  const result: FileVersionGroup[] = [];

  for (const [key, groupFiles] of groups) {
    if (groupFiles.length < 2) continue; // 跳过只有一个文件的组

    // 按版本号降序排列
    groupFiles.sort((a, b) => {
      const cmp = compareVersions(b.parsed.version, a.parsed.version);
      if (cmp !== 0) return cmp;
      // 版本号相同则按修改时间降序
      return (b.entry.lmdt || 0) - (a.entry.lmdt || 0);
    });

    const sortedEntries = groupFiles.map((g) => g.entry);
    const ext = extractFileExtension(sortedEntries[0].name);

    result.push({
      baseName: groupFiles[0].parsed.baseName,
      extension: ext,
      files: sortedEntries,
      toKeep: sortedEntries.slice(0, keepCount),
      toDelete: sortedEntries.slice(keepCount),
    });
  }

  // 按组内文件数量降序排列
  result.sort((a, b) => b.files.length - a.files.length);

  return result;
}
