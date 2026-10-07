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
 * Per-inbox "last organized" markers + new-file counting, the completion hook
 * for the daily inbox pass. The agent calls mark_inbox_organized at the end of
 * a pass; the AgentPanel CTA shows an inbox only when it has files newer than
 * that marker, so the reminder resets until new files arrive.
 *
 * Pure + localStorage-only (guarded), unit-testable.
 */
import { isHiddenName, OrganizeEntry } from '-/utils/fileOrganizer';

const INBOX_LAST_KEY = 'tsInboxLastOrganized';
const MAX_ENTRIES = 50;

export function getInboxLastOrganized(): Record<string, string> {
  if (typeof window === 'undefined' || !window.localStorage) return {};
  try {
    const raw = window.localStorage.getItem(INBOX_LAST_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function writeInboxLastOrganized(map: Record<string, string>): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(INBOX_LAST_KEY, JSON.stringify(map));
  } catch {
    /* storage full / unavailable — keep in-memory only */
  }
}

/**
 * Record an inbox as organized "now". Returns the stored ISO timestamp.
 * Keeps at most MAX_ENTRIES markers, dropping the oldest by insertion order.
 */
export function markInboxOrganized(inboxPath: string): string {
  const map = getInboxLastOrganized();
  const at = new Date().toISOString();
  map[inboxPath] = at;
  const entries = Object.entries(map);
  if (entries.length > MAX_ENTRIES) {
    const sorted = entries.sort((a, b) =>
      (a[1] || '').localeCompare(b[1] || ''),
    );
    for (let i = 0; i < sorted.length - MAX_ENTRIES; i += 1) {
      delete map[sorted[i][0]];
    }
  }
  writeInboxLastOrganized(map);
  return at;
}

/** Epoch ms of the last organize for an inbox; 0 when never organized. */
export function inboxLastOrganizedMs(inboxPath: string): number {
  const iso = getInboxLastOrganized()[inboxPath];
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * The entries of an inbox that are new since `sinceMs`: files (not folders)
 * whose last-modified time is strictly after the threshold and whose name is
 * not a system/hidden name. Pure — feed it the result of listChildren.
 */
export function newEntriesSince(
  entries: OrganizeEntry[],
  sinceMs: number,
): OrganizeEntry[] {
  if (!Array.isArray(entries)) return [];
  return entries.filter(
    (e) =>
      e && e.isFile && !isHiddenName(e.name) && (Number(e.lmdt) || 0) > sinceMs,
  );
}
