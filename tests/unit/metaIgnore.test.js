/**
 * Unit tests for the `.ts-ignore` marker feature: pure helpers in
 * src/renderer/utils/metaIgnore.ts and the filesystem scanner in
 * src/main/metaIgnore.ts.
 */
import { describe, expect, test, beforeEach } from '@playwright/test';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  META_IGNORE_FILE,
  getMetaIgnoreFilePath,
  escapeGlobPath,
  metaIgnoreDirToPatterns,
} from '../../src/renderer/utils/metaIgnore';
import {
  findMetaIgnoreDirs,
  isMetaIgnoredDir,
  clearMetaIgnoreCaches,
  stripMetaLoadModes,
} from '../../src/main/metaIgnore';

let root;

function mark(dir) {
  fs.writeFileSync(path.join(dir, META_IGNORE_FILE), '');
}

beforeEach(() => {
  clearMetaIgnoreCaches();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-ignore-'));
});

describe('metaIgnore pure helpers', () => {
  test('marker file name and path builder', () => {
    expect(META_IGNORE_FILE).toBe('.ts-ignore');
    expect(getMetaIgnoreFilePath('/a/b', '/')).toBe('/a/b/.ts-ignore');
    expect(getMetaIgnoreFilePath('/a/b', '\\')).toBe('/a/b\\.ts-ignore');
  });

  test('escapeGlobPath escapes glob metacharacters only', () => {
    expect(escapeGlobPath('/a/b/node_modules')).toBe('/a/b/node_modules');
    expect(escapeGlobPath('/a/my (proj)[v1]/node_modules')).toBe(
      '/a/my \\(proj\\)\\[v1\\]/node_modules',
    );
    expect(escapeGlobPath('/a/b*?')).toBe('/a/b\\*\\?');
  });

  test('metaIgnoreDirToPatterns covers dir and descendants', () => {
    const patterns = metaIgnoreDirToPatterns('/a/b/node_modules', '/');
    expect(patterns).toEqual([
      '/a/b/node_modules',
      '/a/b/node_modules/**',
    ]);
    // Windows paths: backslashes are glob-escaped so the pattern still
    // matches a literal backslash path (deep `**` matching across `\` is a
    // pre-existing picomatch/posix limitation of the walker).
    expect(metaIgnoreDirToPatterns('C:\\proj\\node_modules', '\\')).toEqual([
      'C:\\\\proj\\\\node_modules',
      'C:\\\\proj\\\\node_modules\\**',
    ]);
  });
});

describe('findMetaIgnoreDirs', () => {
  test('returns empty when no marker exists', async () => {
    fs.mkdirpSync(path.join(root, 'a', 'b'));
    expect(await findMetaIgnoreDirs(root)).toEqual([]);
  });

  test('finds a marked directory inside the tree', async () => {
    const nm = path.join(root, 'node_modules');
    fs.mkdirpSync(path.join(nm, 'pkg', 'deep'));
    mark(nm);
    expect(await findMetaIgnoreDirs(root)).toEqual([nm]);
  });

  test('stops descending at a marked directory', async () => {
    const marked = path.join(root, 'a', 'b');
    fs.mkdirpSync(path.join(marked, 'c', 'd'));
    mark(marked);
    const dirs = await findMetaIgnoreDirs(root);
    expect(dirs).toEqual([marked]);
  });

  test('returns the root itself when it is marked', async () => {
    fs.mkdirpSync(path.join(root, 'sub'));
    mark(root);
    expect(await findMetaIgnoreDirs(root)).toEqual([root]);
  });

  test('returns the whole subtree when an ancestor is marked', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-ignore-par-'));
    mark(parent);
    const inner = path.join(parent, 'proj');
    fs.mkdirpSync(path.join(inner, 'node_modules'));
    try {
      expect(await findMetaIgnoreDirs(inner)).toEqual([inner]);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  test('skips hidden directories (incl .ts itself)', async () => {
    const hidden = path.join(root, '.git');
    fs.mkdirpSync(hidden);
    mark(hidden);
    // even a marked hidden dir must not be reported (we never descend there)
    expect(await findMetaIgnoreDirs(root)).toEqual([]);
  });
});

describe('stripMetaLoadModes', () => {
  test('removes the modes that would create the .ts folder', () => {
    expect(stripMetaLoadModes(['extractThumbPath'])).toEqual([]);
    expect(stripMetaLoadModes(['loadMeta'])).toEqual([]);
    expect(stripMetaLoadModes(['loadMeta', 'extractThumbPath'])).toEqual([]);
  });

  test('keeps unrelated modes', () => {
    expect(
      stripMetaLoadModes(['loadMeta', 'extractTextContent', 'extractLinks']),
    ).toEqual(['extractTextContent', 'extractLinks']);
  });

  test('a missing mode collapses to [] so the reader default cannot kick in', () => {
    // io-fsclient defaults to ['extractThumbPath'] when mode is undefined,
    // which would load (and therefore create) the .ts folder.
    expect(stripMetaLoadModes(undefined)).toEqual([]);
    expect(stripMetaLoadModes(null)).toEqual([]);
    expect(stripMetaLoadModes('extractThumbPath')).toEqual([]);
  });

  test('an empty mode list stays empty', () => {
    expect(stripMetaLoadModes([])).toEqual([]);
  });
});

describe('isMetaIgnoredDir', () => {
  test('false when no marker anywhere', async () => {
    fs.mkdirpSync(path.join(root, 'a', 'b'));
    expect(await isMetaIgnoredDir(path.join(root, 'a', 'b'))).toBe(false);
  });

  test('true when the directory itself is marked', async () => {
    fs.mkdirpSync(path.join(root, 'node_modules'));
    mark(path.join(root, 'node_modules'));
    expect(await isMetaIgnoredDir(path.join(root, 'node_modules'))).toBe(true);
  });

  test('true for descendants of a marked directory', async () => {
    const nm = path.join(root, 'node_modules');
    fs.mkdirpSync(path.join(nm, 'pkg', 'deep'));
    mark(nm);
    expect(await isMetaIgnoredDir(path.join(nm, 'pkg', 'deep'))).toBe(true);
  });

  test('true when an ancestor is marked', async () => {
    const nm = path.join(root, 'node_modules');
    fs.mkdirpSync(nm);
    mark(root);
    expect(await isMetaIgnoredDir(nm)).toBe(true);
  });
});
