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
 * Pure helpers for the Notes perspective: note-file detection, auto naming
 * and date bucketing. Kept free of React/i18n dependencies so they are
 * directly unit-testable (see tests/unit/notesGrouping.test.js).
 */

export type NoteGroupKey =
  | 'today'
  | 'yesterday'
  | 'thisWeek'
  | 'thisMonth'
  | 'earlier';

/** File extensions rendered as notes in the Notes perspective. */
const NOTE_EXTENSIONS = ['md', 'markdown', 'txt'];

export function isNoteFile(fileName: string): boolean {
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === fileName.length - 1) {
    return false;
  }
  return NOTE_EXTENSIONS.includes(fileName.slice(dotIndex + 1).toLowerCase());
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/** Auto name for a fresh note: note-YYYYMMDD-HHmmss (seconds → collision-safe). */
export function newNoteBaseName(now: Date = new Date()): string {
  return (
    'note-' +
    now.getFullYear() +
    pad2(now.getMonth() + 1) +
    pad2(now.getDate()) +
    '-' +
    pad2(now.getHours()) +
    pad2(now.getMinutes()) +
    pad2(now.getSeconds())
  );
}

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Monday-based start of the calendar week containing `date`. */
function startOfWeek(date: Date): Date {
  const d = startOfDay(date);
  const day = d.getDay(); // 0 = Sunday
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return d;
}

function startOfMonth(date: Date): Date {
  const d = startOfDay(date);
  d.setDate(1);
  return d;
}

/**
 * Bucket entries (pre-sorted by lmdt descending) into date groups. The
 * returned groups follow newest-to-oldest bucket order; empty buckets are
 * omitted and the relative order of entries inside a bucket is preserved.
 */
export function groupNotesByDate<T extends { lmdt: number }>(
  entries: T[],
  now: Date = new Date(),
): { key: NoteGroupKey; entries: T[] }[] {
  const today = startOfDay(now).getTime();
  const yesterday = today - 24 * 60 * 60 * 1000;
  const week = startOfWeek(now).getTime();
  const month = startOfMonth(now).getTime();

  const buckets: Record<NoteGroupKey, T[]> = {
    today: [],
    yesterday: [],
    thisWeek: [],
    thisMonth: [],
    earlier: [],
  };

  for (const entry of entries) {
    if (entry.lmdt >= today) {
      buckets.today.push(entry);
    } else if (entry.lmdt >= yesterday) {
      buckets.yesterday.push(entry);
    } else if (entry.lmdt >= week) {
      buckets.thisWeek.push(entry);
    } else if (entry.lmdt >= month) {
      buckets.thisMonth.push(entry);
    } else {
      buckets.earlier.push(entry);
    }
  }

  const order: NoteGroupKey[] = [
    'today',
    'yesterday',
    'thisWeek',
    'thisMonth',
    'earlier',
  ];
  return order
    .map((key) => ({ key, entries: buckets[key] }))
    .filter((group) => group.entries.length > 0);
}
