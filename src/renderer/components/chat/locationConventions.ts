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
 * Convention-file loading for the AI agent (DESIGN-office-ai-workflow §4 #5,
 * official "CLAUDE.md pattern"): the user documents how their location is
 * organized (folder rules, tag conventions, personal instructions) in a
 * convention file at the location root; the agent reads it on every run and
 * injects it into the system prompt. Missing files are silently skipped —
 * conventions are optional.
 */
import { TS } from '-/tagspaces.namespace';

export const CONVENTION_FILE_NAMES = ['CLAUDE.md', 'AGENTS.md'];
const MAX_CONVENTION_CHARS = 4000;

/**
 * Minimal structural shape — the real Location type in ChatProvider /
 * AgentPanel satisfies this.
 */
type ConventionLocation = {
  path?: string;
  getDirSeparator?: () => string;
  loadTextFilePromise: (path: string) => Promise<string>;
};

/**
 * Load the first convention file found at the location root.
 * Returns '' when none exists or reading fails — never throws.
 */
export async function loadLocationConventions(
  location: ConventionLocation | undefined,
): Promise<string> {
  if (!location || !location.path) {
    return '';
  }
  const separator = location.getDirSeparator ? location.getDirSeparator() : '/';
  for (const name of CONVENTION_FILE_NAMES) {
    try {
      const content = await location.loadTextFilePromise(
        `${location.path}${separator}${name}`,
      );
      if (content && content.trim()) {
        return content.slice(0, MAX_CONVENTION_CHARS);
      }
    } catch (e) {
      // file missing or unreadable — try the next candidate
    }
  }
  return '';
}
