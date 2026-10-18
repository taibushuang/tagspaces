/**
 * Main-process support for `.ts-ignore` markers.
 *
 * Provides:
 *  - `findMetaIgnoreDirs(root)` — scan a tree for marked directories (used to
 *    build index ignore patterns so the walker never descends into marked
 *    subtrees, which would otherwise get auto-created `.ts` folders).
 *  - `isMetaIgnoredDir(dir)` — true when `dir` itself or any ancestor carries
 *    the marker (used to suppress `.ts` creation at write points).
 *
 * Scans are cached for a short TTL: markers are rare, deliberate edits and the
 * indexer is invoked repeatedly by agent tool loops, so re-scanning a large
 * tree on every call would be wasteful.
 */
import fs from 'fs-extra';
import path from 'path';
import { META_IGNORE_FILE } from '../renderer/utils/metaIgnore';

const SCAN_CACHE_TTL_MS = 60_000;
const CHECK_CACHE_TTL_MS = 30_000;
const scanCache = new Map<string, { ts: number; dirs: string[] }>();
const checkCache = new Map<string, { ts: number; ignored: boolean }>();

async function dirHasMarker(dir: string): Promise<boolean> {
  try {
    return await fs.pathExists(path.join(dir, META_IGNORE_FILE));
  } catch {
    return false;
  }
}

/**
 * Return the directories (absolute paths) that must not get a `.ts` meta
 * folder, scanning `rootPath` and everything below it. A marked directory
 * suppresses its whole subtree, so the scan does not descend past a marker.
 * If an ancestor of `rootPath` is marked, the whole `rootPath` subtree is
 * suppressed and `[rootPath]` is returned.
 */
export async function findMetaIgnoreDirs(rootPath: string): Promise<string[]> {
  const root = path.resolve(rootPath);
  const cached = scanCache.get(root);
  if (cached && Date.now() - cached.ts < SCAN_CACHE_TTL_MS) {
    return cached.dirs;
  }

  let dirs: string[];

  // Ancestor check: a marker above the root suppresses the whole subtree.
  let cur = path.dirname(root);
  let ancestorMarked = false;
  while (cur !== path.dirname(cur)) {
    // eslint-disable-next-line no-await-in-loop -- sequential filesystem walk
    if (await dirHasMarker(cur)) {
      ancestorMarked = true;
      break;
    }
    cur = path.dirname(cur);
  }

  if (ancestorMarked) {
    dirs = [root];
  } else {
    dirs = [];
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop();
      let entries;
      try {
        // eslint-disable-next-line no-await-in-loop -- sequential filesystem walk
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        // not readable / not a directory
      }
      if (entries) {
        // A marker in this directory suppresses the whole subtree — do not
        // descend any further.
        if (entries.some((entry) => entry.name === META_IGNORE_FILE)) {
          dirs.push(dir);
        } else {
          for (let i = 0; i < entries.length; i += 1) {
            const entry = entries[i];
            // Skip hidden dirs (incl. `.ts` itself) and symlinks (Dirent for
            // a symlink is not a directory, which also avoids symlink loops).
            if (entry.isDirectory() && !entry.name.startsWith('.')) {
              stack.push(path.join(dir, entry.name));
            }
          }
        }
      }
    }
  }

  scanCache.set(root, { ts: Date.now(), dirs });
  return dirs;
}

/**
 * True when `dirPath` itself or any of its ancestors carries the marker.
 */
export async function isMetaIgnoredDir(dirPath: string): Promise<boolean> {
  const key = path.resolve(dirPath);
  const cached = checkCache.get(key);
  if (cached && Date.now() - cached.ts < CHECK_CACHE_TTL_MS) {
    return cached.ignored;
  }

  let ignored = false;
  let cur = key;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- sequential ancestor walk
    if (await dirHasMarker(cur)) {
      ignored = true;
      break;
    }
    const parent = path.dirname(cur);
    if (parent === cur) {
      break;
    }
    cur = parent;
  }

  checkCache.set(key, { ts: Date.now(), ignored });
  return ignored;
}

/**
 * Drop the directory-reading modes that touch the `.ts` folder.
 *
 * `io-fsclient.listDirectoryPromise` loads the folder metadata when the mode
 * contains `loadMeta` or `extractThumbPath`, and that load *creates* `.ts` when
 * it is missing (`listMetaDirectoryPromise` -> `ensureDirSync`). Nothing is
 * read from or written to `.ts` in a marked directory anyway, so removing those
 * modes keeps the tree clean while the remaining modes (e.g. text extraction)
 * keep working.
 *
 * `undefined` collapses to `[]` on purpose: the readers treat a missing mode as
 * "use my default", which includes `extractThumbPath`, so passing `undefined`
 * through would make this guard a no-op.
 */
export function stripMetaLoadModes(mode?: string[]): string[] {
  if (!Array.isArray(mode)) {
    return [];
  }
  return mode.filter(
    (dirMode) => dirMode !== 'loadMeta' && dirMode !== 'extractThumbPath',
  );
}

/** Clear the TTL caches — used by unit tests that mutate the filesystem. */
export function clearMetaIgnoreCaches(): void {
  scanCache.clear();
  checkCache.clear();
}
