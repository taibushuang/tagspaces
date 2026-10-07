import { describe, expect, test } from '@playwright/test';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  DEFAULT_MAX_DIRS,
  getProfileExts,
  isSensitiveDir,
  scanDisks,
  shouldSkipDir,
} from '../../src/main/diskScanner';

/**
 * Builds a small fixture tree in the OS temp dir:
 *
 * root/
 *   code.ts            (programming)
 *   photo.jpg          (always-counted media)
 *   noise.log          (never counted)
 *   a/
 *     deep.py          (programming)
 *     report.docx      (office only)
 *     a/b/
 *       notes.md       (programming)
 *   .git/
 *     config.json      (skipped dir)
 *   node_modules/
 *     lib/index.js     (skipped dir)
 */
async function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-scan-'));
  const dirs = [
    '',
    'a',
    path.join('a', 'b'),
    '.git',
    path.join('node_modules', 'lib'),
  ];
  for (const d of dirs) {
    fs.ensureDirSync(path.join(root, d));
  }
  const files = [
    ['code.ts', 'export const x = 1;'],
    ['photo.jpg', 'not-a-real-image'],
    ['noise.log', 'irrelevant'],
    [path.join('a', 'deep.py'), 'print(1)'],
    [path.join('a', 'report.docx'), 'office doc'],
    [path.join('a', 'b', 'notes.md'), '# notes'],
    [path.join('.git', 'config.json'), '{}'],
    [path.join('node_modules', 'lib', 'index.js'), 'module.exports = 1;'],
  ];
  for (const [rel, content] of files) {
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

describe('diskScanner.getProfileExts', () => {
  test('maps each profile to its extension set', () => {
    expect(getProfileExts('programming')).toContain('ts');
    expect(getProfileExts('programming')).toContain('py');
    expect(getProfileExts('office')).toContain('docx');
    expect(getProfileExts('office')).toContain('pdf');
    expect(getProfileExts('design')).toContain('psd');
    expect(getProfileExts('academic')).toContain('tex');
    expect(getProfileExts('mixed')).toContain('pdf');
    expect(getProfileExts('other')).toContain('md');
  });

  test('falls back to a sensible default for unknown profiles', () => {
    const fallback = getProfileExts(undefined);
    expect(fallback.length).toBeGreaterThan(0);
    expect(fallback).toContain('pdf');
  });
});

describe('diskScanner.shouldSkipDir', () => {
  test('skips build/dependency/system directories', () => {
    expect(shouldSkipDir('/proj/node_modules')).toBe(true);
    expect(shouldSkipDir('/proj/.git')).toBe(true);
    expect(shouldSkipDir('/proj/__pycache__')).toBe(true);
    expect(shouldSkipDir('/proj/dist')).toBe(true);
    expect(shouldSkipDir('/System/Library')).toBe(true);
    expect(shouldSkipDir('C:\\Windows\\System32')).toBe(true);
  });

  test('skips hidden directories', () => {
    expect(shouldSkipDir('/home/u/.cache')).toBe(true);
    expect(shouldSkipDir('/home/u/.Trash')).toBe(true);
  });

  test('keeps TagSpaces metadata directories', () => {
    expect(shouldSkipDir('/home/u/files/.ts')).toBe(false);
    expect(shouldSkipDir('/home/u/files/.tagspaces')).toBe(false);
  });

  test('keeps normal directories', () => {
    expect(shouldSkipDir('/home/u/Documents/Work')).toBe(false);
  });
});

describe('diskScanner.isSensitiveDir', () => {
  test('flags credentials, keychains and browser/chat profiles', () => {
    expect(isSensitiveDir('/home/u/.ssh')).toBe(true);
    expect(isSensitiveDir('/Users/u/Library/Keychains')).toBe(true);
    expect(
      isSensitiveDir('/Users/u/Library/Application Support/Google/Chrome'),
    ).toBe(true);
    expect(isSensitiveDir('C:\\Users\\u\\AppData\\Local\\Google\\Chrome')).toBe(
      true,
    );
    expect(isSensitiveDir('/home/u/Library/Messages')).toBe(true);
  });

  test('leaves normal directories alone', () => {
    expect(isSensitiveDir('/home/u/Documents')).toBe(false);
    expect(isSensitiveDir('/home/u/Downloads')).toBe(false);
  });
});

describe('diskScanner.scanDisks', () => {
  test('aggregates matching files into each ancestor directory', async () => {
    const root = await makeFixture();
    try {
      const result = await scanDisks({
        roots: [root],
        profile: 'programming',
        depth: 4,
      });
      expect(result.error).toBeUndefined();
      expect(result.scannedRoots).toEqual([root]);

      const byPath = new Map(result.dirs.map((d) => [d.path, d]));
      // Ancestor aggregation: the root bucket sums everything beneath it —
      // code.ts + photo.jpg at the root, plus deep.py and notes.md below.
      expect(byPath.get(root)?.fileCount).toBe(4);
      // deep.py + notes.md attributed to 'a' via ancestor aggregation
      expect(byPath.get(path.join(root, 'a'))?.fileCount).toBe(2);
      expect(byPath.get(path.join(root, 'a', 'b'))?.fileCount).toBe(1);

      // noise.log is not in the programming profile and not always-counted
      const allPaths = result.dirs.map((d) => d.path);
      expect(allPaths).not.toContain(path.join(root, 'noise.log'));
    } finally {
      fs.removeSync(root);
    }
  });

  test('skips sensitive and ignored directories', async () => {
    const root = await makeFixture();
    try {
      const result = await scanDisks({
        roots: [root],
        profile: 'programming',
      });
      const allPaths = result.dirs.map((d) => d.path);
      expect(allPaths).not.toContain(path.join(root, '.git'));
      expect(allPaths).not.toContain(path.join(root, 'node_modules'));
      // config.json / index.js live in skipped dirs — they must not be counted;
      // the root bucket still aggregates the 4 files below it.
      const rootBucket = result.dirs.find((d) => d.path === root);
      expect(rootBucket?.fileCount).toBe(4);
      expect(result.extHistogram.map((e) => e.ext)).not.toContain('json');
    } finally {
      fs.removeSync(root);
    }
  });

  test('respects the profile filter (office does not pick up code)', async () => {
    const root = await makeFixture();
    try {
      const result = await scanDisks({
        roots: [root],
        profile: 'office',
      });
      const exts = result.extHistogram.map((e) => e.ext);
      expect(exts).toContain('docx');
      expect(exts).not.toContain('ts');
      expect(exts).not.toContain('py');
    } finally {
      fs.removeSync(root);
    }
  });

  test('always counts archives and media regardless of profile', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-scan-'));
    try {
      fs.writeFileSync(path.join(root, 'installer.dmg'), 'x');
      fs.writeFileSync(path.join(root, 'archive.zip'), 'y');
      fs.writeFileSync(path.join(root, 'clip.mp4'), 'z');
      const result = await scanDisks({
        roots: [root],
        profile: 'academic',
      });
      const exts = result.extHistogram.map((e) => e.ext);
      expect(exts).toContain('dmg');
      expect(exts).toContain('zip');
      expect(exts).toContain('mp4');
    } finally {
      fs.removeSync(root);
    }
  });

  test('truncates when maxEntries is exceeded', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-scan-'));
    try {
      for (let i = 0; i < 20; i += 1) {
        fs.writeFileSync(path.join(root, `f${i}.md`), 'x');
      }
      const result = await scanDisks({
        roots: [root],
        profile: 'programming',
        maxEntries: 5,
      });
      expect(result.truncated).toBe(true);
    } finally {
      fs.removeSync(root);
    }
  });

  test('caps the number of reported directories at maxDirs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-scan-'));
    try {
      for (let i = 0; i < DEFAULT_MAX_DIRS + 5; i += 1) {
        const dir = path.join(root, `d${i}`);
        fs.ensureDirSync(dir);
        fs.writeFileSync(path.join(dir, 'file.md'), 'x');
      }
      const result = await scanDisks({
        roots: [root],
        profile: 'programming',
      });
      expect(result.dirs.length).toBeLessThanOrEqual(DEFAULT_MAX_DIRS);
    } finally {
      fs.removeSync(root);
    }
  });

  test('ignores a missing root without failing', async () => {
    const result = await scanDisks({
      roots: [path.join(os.tmpdir(), 'disk-scan-does-not-exist')],
      profile: 'programming',
    });
    expect(result.error).toBeUndefined();
    expect(result.dirs).toEqual([]);
  });
});
