/**
 * Meta-folder suppression via a `.ts-ignore` marker file.
 *
 * A `.ts-ignore` file present in a directory tells TagSpaces to NOT create its
 * meta folder (`.ts` by default) in that directory or any of its descendants.
 * It is meant for code projects — e.g. dropping `.ts-ignore` inside
 * `node_modules` keeps TagSpaces from scattering empty `.ts` folders into a
 * tree that is consumed by build tools.
 *
 * This module is pure (no Electron / window / fs access) so it can be shared
 * by the main process (filesystem scanner) and the renderer (pattern builders).
 */
import { normalizePath } from '@tagspaces/tagspaces-common/paths';

export const META_IGNORE_FILE = '.ts-ignore';

export function getMetaIgnoreFilePath(
  dirPath: string,
  dirSeparator = '/',
): string {
  return normalizePath(dirPath + dirSeparator + META_IGNORE_FILE);
}

/**
 * Escape picomatch glob metacharacters so a real path matches literally.
 */
export function escapeGlobPath(p: string): string {
  return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert a marked directory into ignore patterns covering the directory
 * itself and all of its descendants. The native separator is preserved so the
 * patterns line up with the OS paths produced by the index walker.
 */
export function metaIgnoreDirToPatterns(
  markedDir: string,
  dirSeparator = '/',
): string[] {
  const escaped = escapeGlobPath(markedDir);
  return [escaped, `${escaped}${dirSeparator}**`];
}
