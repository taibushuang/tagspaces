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

export const MAX_OPENED_FILE_TABS = 10;

/** Lightweight per-file record kept for the document tab strip. */
export interface OpenedFileTab {
  path: string;
  name: string;
  locationID: string;
  extension: string;
  isFile: boolean;
  lmdt: number;
}

/**
 * Tab identity is locationID + path: plain path collides across locations
 * (two cloud locations can host the same key), which would make tabs
 * overwrite each other and open files from the wrong location.
 */
export function tabKey(tab: { path: string; locationID?: string }): string {
  return (tab.locationID || '') + '|' + (tab.path || '');
}

export function toOpenedFileTab(
  entry: TS.FileSystemEntry,
): OpenedFileTab | undefined {
  if (!entry || !entry.path || !entry.isFile) {
    return undefined;
  }
  return {
    path: entry.path,
    name: entry.name,
    locationID: entry.locationID,
    extension: entry.extension,
    isFile: entry.isFile,
    lmdt: entry.lmdt,
  };
}

/**
 * Adds a file to the tab list (or refreshes it in place when already there).
 * Oldest tabs are dropped once the list grows beyond `max`.
 */
export function upsertOpenedFileTab(
  tabs: OpenedFileTab[],
  entry: TS.FileSystemEntry,
  max: number = MAX_OPENED_FILE_TABS,
): OpenedFileTab[] {
  const tab = toOpenedFileTab(entry);
  if (!tab) {
    return tabs;
  }
  const key = tabKey(tab);
  const existingIndex = tabs.findIndex((t) => tabKey(t) === key);
  if (existingIndex >= 0) {
    const next = [...tabs];
    next[existingIndex] = { ...next[existingIndex], ...tab };
    return next;
  }
  const next = [...tabs, tab];
  return next.length > max ? next.slice(next.length - max) : next;
}

export function removeOpenedFileTab(
  tabs: OpenedFileTab[],
  key: string,
): OpenedFileTab[] {
  return tabs.filter((t) => tabKey(t) !== key);
}

/**
 * Neighbor to activate after closing `closedKey` — the tab that took its
 * place, or the last remaining one when the closed tab was at the end.
 */
export function findNeighborTab(
  tabs: OpenedFileTab[],
  closedKey: string,
): OpenedFileTab | undefined {
  const index = tabs.findIndex((t) => tabKey(t) === closedKey);
  if (index < 0) {
    return undefined;
  }
  const remaining = removeOpenedFileTab(tabs, closedKey);
  if (remaining.length === 0) {
    return undefined;
  }
  return remaining[Math.min(index, remaining.length - 1)];
}
