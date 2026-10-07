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
import { describe, expect, test } from '@playwright/test';
import {
  ORGANIZE_DEFAULT_CONFIG,
  fingerprint,
  planOrganize,
  sameFingerprint,
  uniqueTargetName,
  validateMovePlan,
  validateOrganizeConfig,
} from '-/utils/fileOrganizer';

const file = (name, overrides = {}) => ({
  name,
  path: '/root/' + name,
  isFile: true,
  size: 1024,
  lmdt: 1000,
  ...overrides,
});

describe('validateOrganizeConfig', () => {
  test('undefined → default config', () => {
    const c = validateOrganizeConfig(undefined);
    expect(c.categories.Documents.extensions).toContain('.pdf');
    expect(c.categories.Other.extensions).toEqual([]);
    expect(c.categories.Folders.extensions).toEqual(['__FOLDER__']);
    expect(c.excludedExtensions).toContain('.lnk');
  });

  test('复合扩展名 .tar.gz 保留且最长后缀优先（tar.gz 命中 Archives 而非 .gz）', () => {
    const { planOrganize: plan } = { planOrganize };
    const res = plan('/root', [file('a.tar.gz')]);
    expect(res.organizable[0].category).toBe('Archives');
    expect(res.organizable[0].targetPath).toBe('/root/Archives/a.tar.gz');
  });

  test('重复扩展名跨分类 → 抛错', () => {
    expect(() =>
      validateOrganizeConfig({
        categories: {
          A: { extensions: ['.pdf'] },
          B: { extensions: ['.pdf'] },
          Other: { extensions: [] },
        },
      }),
    ).toThrow(/同时属于/);
  });

  test('两个空扩展名兜底分类 → 抛错', () => {
    expect(() =>
      validateOrganizeConfig({
        categories: {
          A: { extensions: ['.pdf'] },
          X: { extensions: [] },
          Y: { extensions: [] },
        },
      }),
    ).toThrow(/只能有一个空扩展名分类/);
  });

  test('缺 Other/Folders 自动补齐', () => {
    const c = validateOrganizeConfig({
      categories: { A: { extensions: ['.pdf'] } },
    });
    expect(c.categories.Other).toBeTruthy();
    expect(c.categories.Folders.extensions).toEqual(['__FOLDER__']);
  });

  test('非法分类名 → 抛错', () => {
    expect(() =>
      validateOrganizeConfig({
        categories: { 'a/b': { extensions: ['.pdf'] } },
      }),
    ).toThrow(/路径符号/);
    expect(() =>
      validateOrganizeConfig({
        categories: { CON: { extensions: ['.pdf'] } },
      }),
    ).toThrow(/保留名称/);
  });

  test('负数大小上限 → 抛错', () => {
    expect(() =>
      validateOrganizeConfig({ maxFileSizeMb: -1 }),
    ).toThrow(/大小上限/);
  });
});

describe('planOrganize 分类', () => {
  test('docx→Documents, png→Images, mp3→Audio, exe→Apps', () => {
    const res = planOrganize('/root', [
      file('report.docx'),
      file('photo.png'),
      file('song.mp3'),
      file('setup.exe'),
    ]);
    const byName = Object.fromEntries(res.organizable.map((r) => [r.name, r.category]));
    expect(byName['report.docx']).toBe('Documents');
    expect(byName['photo.png']).toBe('Images');
    expect(byName['song.mp3']).toBe('Audio');
    expect(byName['setup.exe']).toBe('Apps');
  });

  test('未知扩展名落入兜底 Other', () => {
    const res = planOrganize('/root', [file('mystery.xyz')]);
    expect(res.organizable[0].category).toBe('Other');
  });

  test('扩展名大小写不敏感', () => {
    const res = planOrganize('/root', [file('Photo.PNG')]);
    expect(res.organizable[0].category).toBe('Images');
  });

  test('跳过：隐藏项 / desktop.ini / 符号链接', () => {
    const res = planOrganize('/root', [
      file('.DS_Store'),
      file('desktop.ini'),
      file('link.pdf', { isSymbolicLink: true }),
    ]);
    expect(res.organizable).toHaveLength(0);
    expect(res.skipped.map((r) => r.reason)).toEqual([
      '系统或隐藏项',
      '系统或隐藏项',
      '符号链接，跳过',
    ]);
  });

  test('跳过：排除扩展名 .lnk / 超过大小上限', () => {
    const res = planOrganize('/root', [
      file('shortcut.lnk'),
      file('huge.bin', { size: 200 * 1024 * 1024 }),
    ]);
    expect(res.organizable).toHaveLength(0);
    expect(res.skipped[0].reason).toContain('排除的扩展名');
    expect(res.skipped[1].reason).toContain('大小上限');
  });

  test('默认跳过文件夹；已是分类文件夹单独标记；includeFolders 时归入 Folders', () => {
    const res = planOrganize('/root', [
      { name: 'Documents', path: '/root/Documents', isFile: false },
      { name: 'random-dir', path: '/root/random-dir', isFile: false },
    ]);
    expect(res.skipped.map((r) => [r.name, r.reason])).toEqual([
      ['Documents', '已是分类文件夹'],
      ['random-dir', '默认保留文件夹'],
    ]);
    const withFolders = planOrganize(
      '/root',
      [{ name: 'random-dir', path: '/root/random-dir', isFile: false }],
      { includeFolders: true },
    );
    expect(withFolders.organizable[0].category).toBe('Folders');
  });
});

describe('uniqueTargetName', () => {
  test('冲突时追加 (1) (2)，大小写不敏感', () => {
    // Contract: reserved holds lowercased full paths (as planOrganize builds it).
    const reserved = new Set(['/root/a/a.pdf']);
    expect(uniqueTargetName('/root/A/a.pdf', reserved)).toBe('/root/A/a (1).pdf');
    reserved.add('/root/a/a (1).pdf'.toLocaleLowerCase());
    expect(uniqueTargetName('/root/A/a.pdf', reserved)).toBe('/root/A/a (2).pdf');
  });
  test('无冲突原样返回', () => {
    const reserved = new Set(['/root/A/b.pdf']);
    expect(uniqueTargetName('/root/A/a.pdf', reserved)).toBe('/root/A/a.pdf');
  });
});

describe('fingerprint', () => {
  test('sameFingerprint 判断一致/变化', () => {
    const a = fingerprint({ size: 10, lmdt: 100 });
    expect(sameFingerprint(a, fingerprint({ size: 10, lmdt: 100 }))).toBe(true);
    expect(sameFingerprint(a, fingerprint({ size: 11, lmdt: 100 }))).toBe(false);
    expect(sameFingerprint(a, fingerprint({ size: 10, lmdt: 200 }))).toBe(false);
  });
});

describe('validateMovePlan', () => {
  test('合法 moves 通过', () => {
    const { valid, invalid } = validateMovePlan('/root', [
      { from: '/root/a.pdf', to: '/root/Documents/a.pdf' },
      { from: '/root/b.png', to: '/root/Images/b.png' },
    ]);
    expect(valid).toHaveLength(2);
    expect(invalid).toHaveLength(0);
  });

  test('路径逃逸 / 非直接子项 / 目标层级错误 / 自移动 被拒', () => {
    const { valid, invalid } = validateMovePlan('/root', [
      { from: '/root/sub/a.pdf', to: '/root/Documents/a.pdf' }, // 非直接子项
      { from: '/root/a.pdf', to: '/root/../escaped.pdf' }, // .. 逃逸
      { from: '/root/a.pdf', to: '/root/Documents/Deep/a.pdf' }, // 目标三层
      { from: '/root/a.pdf', to: '/root/a.pdf' }, // 自移动
    ]);
    expect(valid).toHaveLength(0);
    expect(invalid).toHaveLength(4);
    expect(invalid.map((m) => m.reason)).toEqual([
      '源必须是目录的直接子项',
      '路径含 .. 逃逸',
      '目标必须是 <root>/<分类文件夹>/<文件名>',
      '源与目标相同',
    ]);
  });
});

test('默认配置可直接序列化（JSON 安全）', () => {
  expect(() => JSON.stringify(ORGANIZE_DEFAULT_CONFIG)).not.toThrow();
  expect(JSON.parse(JSON.stringify(ORGANIZE_DEFAULT_CONFIG)).categories.Other).toBeTruthy();
});
