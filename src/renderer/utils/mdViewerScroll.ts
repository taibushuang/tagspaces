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

import { MD_VIEWER_SCROLL_ROOT } from '-/utils/mdViewerOverrides';
import { OpenedFileTab, tabKey } from '-/utils/openedFileTabs';

/**
 * Per-document scroll memory for the md viewer tab strip. Switching tabs
 * reloads the viewer iframe (its src changes), which resets the scroll —
 * this keeps the last scrollTop per document so switching back restores
 * the reading position. Module-level (per renderer window) on purpose:
 * the tab list itself is session-scoped too.
 */
const scrollMemory = new Map<string, number>();

/**
 * Reads the current scroll position of the viewer's scroll container and
 * remembers it for the given document. No-op when the viewer iframe isn't
 * accessible (cross-origin / not loaded / non-md extension without the
 * expected container).
 */
export function saveViewerScroll(
  iframe: HTMLIFrameElement | null,
  entry: { path: string; locationID?: string } | undefined,
) {
  try {
    if (!iframe || !entry) return;
    const el = iframe.contentDocument?.querySelector(MD_VIEWER_SCROLL_ROOT);
    if (el && el.scrollHeight > 0) {
      scrollMemory.set(tabKey(entry), el.scrollTop);
    }
  } catch (ex) {
    console.debug('saveViewerScroll skipped:', ex);
  }
}

export function clearViewerScroll(
  entry: { path: string; locationID?: string } | undefined,
) {
  if (entry) {
    scrollMemory.delete(tabKey(entry));
  }
}

/**
 * Restores the remembered scroll position for the given document. The md
 * editor renders asynchronously after the iframe loads (content arrives via
 * postMessage), so retry until the document is tall enough to hold the
 * position, or the budget runs out.
 */
export function restoreViewerScroll(
  iframe: HTMLIFrameElement | null,
  entry: { path: string; locationID?: string } | undefined,
) {
  if (!iframe || !entry) return;
  const top = scrollMemory.get(tabKey(entry));
  if (!top || top <= 0) return;
  const started = Date.now();
  const attempt = () => {
    try {
      const doc = iframe.contentDocument;
      const el = doc?.querySelector(MD_VIEWER_SCROLL_ROOT);
      if (!el) return;
      if (el.scrollHeight >= top + el.clientHeight) {
        el.scrollTop = top;
        return;
      }
    } catch (ex) {
      console.debug('restoreViewerScroll skipped:', ex);
      return;
    }
    if (Date.now() - started < 3000) {
      setTimeout(attempt, 150);
    }
  };
  setTimeout(attempt, 150);
}
