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
import { afterEach, describe, expect, test } from '@playwright/test';
import { EventEmitter } from 'events';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  buildExportArgs,
  createSerialTaskQueue,
  defaultExeCandidates,
  hasRootRowSync,
  parseWizTreeExport,
  runExport,
  validateScanTarget,
} from '../../src/main/wiztree';

const HEADER = 'File Name,Size,Allocated,Modified,Attributes,Files,Folders';
const MODIFIED = '2024/01/01 10:00:00';

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) {
    fs.removeSync(tmpDirs.pop());
  }
});

function writeFixture(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-wiztree-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'export.csv');
  fs.writeFileSync(file, lines.join('\r\n'));
  return { dir, file };
}

function fakeChild() {
  const emitter = new EventEmitter();
  emitter.pid = undefined;
  return emitter;
}

const TIMING = {
  pollMs: 5,
  stableTicks: 2,
  graceMs: 100,
  headerGraceMs: 300,
  timeoutMs: 3000,
};

describe('wiztree buildExportArgs', () => {
  test('默认参数：admin=1、按大小排序、不导出文件', () => {
    expect(
      buildExportArgs('C:\\', 'C:\\tmp\\export.csv', { path: 'C:' }),
    ).toEqual([
      'C:\\',
      '/export=C:\\tmp\\export.csv',
      '/admin=1',
      '/sortby=1',
      '/exportfolders=1',
      '/exportfiles=0',
    ]);
  });

  test('includeFiles / filter / admin=false / 带空格路径保持单个参数', () => {
    const target = 'D:\\Data With Space';
    const args = buildExportArgs(target, 'D:\\tmp\\e.csv', {
      path: target,
      includeFiles: true,
      filter: ' *.mp4|*.mkv ',
      admin: false,
    });
    expect(args[0]).toBe(target);
    expect(args).toContain('/admin=0');
    expect(args).toContain('/exportfiles=1');
    expect(args).toContain('/filter=*.mp4|*.mkv');
  });
});

describe('wiztree CSV 解析', () => {
  test('引号逗号路径、文件夹行、根行 totals、硬链接标记', async () => {
    const { file } = writeFixture([
      HEADER,
      '"C:\\",1000,900,2024/01/01 10:00:00,..D...,12,4',
      '"C:\\Users\\me\\",600,500,2024/01/01 10:00:00,..D...,8,2',
      '"C:\\Users\\me\\Big, Folder\\",400,300,2024/01/01 10:00:00,..D...,3,1',
      '"C:\\Users\\me\\a.txt",100,0064,2024/01/02 11:22:33,...A...,,',
      '"C:\\Users\\me\\b.txt",50,50,2024/01/02 11:22:33,...A...,,',
    ]);
    const parsed = await parseWizTreeExport(file, 'C:\\', 20, true);

    expect(parsed.totalSize).toBe(1000);
    expect(parsed.totalAllocated).toBe(900);
    expect(parsed.totalFiles).toBe(12);
    expect(parsed.totalFolders).toBe(3);
    expect(parsed.topFolders.map((e) => e.path)).toEqual([
      'C:\\Users\\me',
      'C:\\Users\\me\\Big, Folder',
    ]);
    expect(parsed.topFiles.map((e) => e.path)).toEqual([
      'C:\\Users\\me\\a.txt',
      'C:\\Users\\me\\b.txt',
    ]);
    const hardLink = parsed.topFiles.find((e) =>
      e.path.endsWith('a.txt'),
    );
    expect(hardLink.isHardLink).toBe(true);
    expect(hardLink.allocated).toBe(64);
    expect(parsed.topFiles.find((e) => e.path.endsWith('b.txt')).isHardLink)
      .toBeUndefined();
  });

  test('硬链接文件夹行 allocated 按 0 参与 totals，字段保留原值', async () => {
    const { file } = writeFixture([
      HEADER,
      '"C:\\A\\",600,0500,2024/01/01 10:00:00,..D...,5,1',
      '"C:\\B\\",400,300,2024/01/01 10:00:00,..D...,5,1',
    ]);
    const parsed = await parseWizTreeExport(file, 'C:\\Missing', 10, false);
    const folderA = parsed.topFolders.find((e) => e.path === 'C:\\A');
    expect(folderA.isHardLink).toBe(true);
    expect(folderA.allocated).toBe(500);
    expect(parsed.totalAllocated).toBe(300);
    expect(parsed.totalSize).toBe(600);
  });

  test('topN 截断后按 size 降序（堆替换正确）', async () => {
    const rows = [HEADER];
    for (let i = 1; i <= 25; i += 1) {
      rows.push(
        `"C:\\Dir${i}\\",${i * 100},${i * 100},${MODIFIED},..D...,${i},1`,
      );
    }
    const { file } = writeFixture(rows);
    const parsed = await parseWizTreeExport(file, 'C:\\Missing', 3, false);
    expect(parsed.topFolders).toHaveLength(3);
    expect(parsed.topFolders.map((e) => e.size)).toEqual([2500, 2400, 2300]);
  });

  test('解析超时抛错并带已解析行数', async () => {
    const { file } = writeFixture([
      HEADER,
      `"C:\\A\\",1,1,${MODIFIED},..D...,1,0`,
    ]);
    await expect(parseWizTreeExport(file, 'C:\\', 10, false, 0)).rejects.toThrow(
      /timed out.*rows parsed/,
    );
  });
});

describe('wiztree CSV 头部探测', () => {
  test('表头 + 扫描根行 → true', () => {
    const { file } = writeFixture([
      HEADER,
      `"C:\\",100,90,${MODIFIED},..D...,1,0`,
    ]);
    expect(hasRootRowSync(file, 'C:\\')).toBe(true);
  });

  test('只有表头/其他行 → false', () => {
    const { file } = writeFixture([
      HEADER,
      `"C:\\Other\\",100,90,${MODIFIED},..D...,1,0`,
    ]);
    expect(hasRootRowSync(file, 'C:\\')).toBe(false);
  });

  test('没有表头、文件不存在 → false', () => {
    const { file } = writeFixture([
      `"C:\\",100,90,${MODIFIED},..D...,1,0`,
    ]);
    expect(hasRootRowSync(file, 'C:\\')).toBe(false);
    expect(hasRootRowSync(path.join(path.dirname(file), 'nope.csv'), 'C:\\'))
      .toBe(false);
  });
});

describe('wiztree 完成判定', () => {
  test('① 进程 close 且 CSV 已存在 → 完成', async () => {
    const { file } = writeFixture([
      HEADER,
      `"C:\\",100,90,${MODIFIED},..D...,1,0`,
    ]);
    const child = fakeChild();
    const promise = runExport('WizTree64.exe', 'C:\\', file, { path: 'C:' }, TIMING, {
      spawnFn: () => child,
      kill: () => {},
    });
    child.emit('close', 0);
    await expect(promise).resolves.toEqual({ ok: true });
  });

  test('② close 时 CSV 为空 → 宽限期内提权实例写入 CSV → 完成', async () => {
    const { dir } = writeFixture([]);
    const file = path.join(dir, 'export.csv');
    const child = fakeChild();
    const promise = runExport('WizTree64.exe', 'C:\\', file, { path: 'C:' }, TIMING, {
      spawnFn: () => child,
      kill: () => {},
    });
    child.emit('close', 0);
    setTimeout(() => {
      fs.writeFileSync(
        file,
        `${HEADER}\r\n"C:\\",100,90,${MODIFIED},..D...,1,0`,
      );
    }, 20);
    await expect(promise).resolves.toEqual({ ok: true });
  });

  test('③ 宽限期耗尽仍无 CSV → 报错（提示 UAC）', async () => {
    const { dir } = writeFixture([]);
    const file = path.join(dir, 'missing.csv');
    const child = fakeChild();
    const promise = runExport(
      'WizTree64.exe',
      'C:\\',
      file,
      { path: 'C:' },
      { ...TIMING, graceMs: 30 },
      { spawnFn: () => child, kill: () => {} },
    );
    child.emit('close', 0);
    const outcome = await promise;
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('UAC');
  });

  test('④ CSV 稳定但头部无根行 → 继续轮询，根行出现后完成', async () => {
    const { file } = writeFixture([HEADER]);
    const child = fakeChild();
    let headerChecks = 0;
    const promise = runExport('WizTree64.exe', 'C:\\', file, { path: 'C:' }, TIMING, {
      spawnFn: () => child,
      kill: () => {},
      hasRootRow: () => {
        headerChecks += 1;
        return headerChecks >= 3;
      },
    });
    await expect(promise).resolves.toEqual({ ok: true });
    expect(headerChecks).toBeGreaterThanOrEqual(3);
  });

  test('⑤ CSV 稳定 + 头部根行存在 → 完成', async () => {
    const { file } = writeFixture([
      HEADER,
      `"C:\\",100,90,${MODIFIED},..D...,1,0`,
    ]);
    const child = fakeChild();
    const started = Date.now();
    const promise = runExport('WizTree64.exe', 'C:\\', file, { path: 'C:' }, TIMING, {
      spawnFn: () => child,
      kill: () => {},
    });
    await expect(promise).resolves.toEqual({ ok: true });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('wiztree 并发队列', () => {
  test('第二次任务在第一次 resolve 后才开始', async () => {
    const enqueue = createSerialTaskQueue();
    const events = [];
    let release;
    const first = enqueue(async () => {
      events.push('first:start');
      await new Promise((resolve) => {
        release = resolve;
      });
      events.push('first:end');
      return 1;
    });
    const second = enqueue(async () => {
      events.push('second:start');
      return 2;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(['first:start']);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });
});

describe('wiztree path 校验', () => {
  test('目录通过、文件被拒、缺失路径报错', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-wiztree-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'x');

    expect(validateScanTarget(dir)).toEqual({
      targetPath: dir,
      driveOnly: false,
    });
    expect(validateScanTarget(`  ${dir}  `)).toEqual({
      targetPath: dir,
      driveOnly: false,
    });
    expect(validateScanTarget(file).error).toContain('not a directory');
    expect(validateScanTarget(path.join(dir, 'missing')).error).toContain(
      'not found',
    );
    expect(validateScanTarget('').error).toContain('required');
  });

  test('盘符直接放行并归一为盘符根', () => {
    expect(validateScanTarget('C:')).toEqual({
      targetPath: 'C:\\',
      driveOnly: true,
    });
    expect(validateScanTarget('d:')).toEqual({
      targetPath: 'd:\\',
      driveOnly: true,
    });
  });
});

describe('wiztree exe 候选顺序', () => {
  test('同目录同时存在时优先 WizTree64.exe', () => {
    const candidates = defaultExeCandidates({
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    });
    const dir = path.join('C:\\Program Files', 'WizTree');
    const x64 = candidates.indexOf(path.join(dir, 'WizTree64.exe'));
    const x86 = candidates.indexOf(path.join(dir, 'WizTree.exe'));
    expect(x64).toBeGreaterThanOrEqual(0);
    expect(x64).toBeLessThan(x86);
  });

  test('WIZTREE_PATH 指向目录时 64 位优先', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-wiztree-'));
    tmpDirs.push(dir);
    const candidates = defaultExeCandidates({ WIZTREE_PATH: dir });
    expect(path.basename(candidates[0])).toBe('WizTree64.exe');
    expect(path.basename(candidates[1])).toBe('WizTree.exe');
  });
});
