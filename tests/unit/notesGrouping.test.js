import { describe, expect, test } from '@playwright/test';
import {
  groupNotesByDate,
  isNoteFile,
  newNoteBaseName,
} from '-/utils/notesGrouping';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Fixed "now": Wed 2026-11-04 15:30 local time. */
const NOW = new Date(2026, 10, 4, 15, 30, 0);

const note = (id, lmdt) => ({ id, lmdt });

describe('isNoteFile', () => {
  test('accepts md/markdown/txt case-insensitively', () => {
    expect(isNoteFile('a.md')).toBe(true);
    expect(isNoteFile('b.MD')).toBe(true);
    expect(isNoteFile('c.Markdown')).toBe(true);
    expect(isNoteFile('d.txt')).toBe(true);
  });

  test('rejects other extensions and extensionless names', () => {
    expect(isNoteFile('photo.jpg')).toBe(false);
    expect(isNoteFile('archive.tar.gz')).toBe(false);
    expect(isNoteFile('noextension')).toBe(false);
    expect(isNoteFile('dot.')).toBe(false);
  });
});

describe('newNoteBaseName', () => {
  test('formats note-YYYYMMDD-HHmmss', () => {
    const d = new Date(2026, 0, 2, 3, 4, 5);
    expect(newNoteBaseName(d)).toBe('note-20260102-030405');
  });

  test('matches the gateway-free charset ^[A-Za-z0-9_-]+$', () => {
    expect(newNoteBaseName(NOW)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('groupNotesByDate', () => {
  const today = new Date(2026, 10, 4, 9, 0).getTime();
  const yesterday = new Date(2026, 10, 3, 22, 0).getTime();
  const thisWeek = new Date(2026, 10, 2, 12, 0).getTime(); // Monday
  const thisMonth = new Date(2026, 10, 1, 8, 0).getTime(); // Sunday
  const earlier = new Date(2025, 0, 15).getTime();

  test('buckets by recency, newest group first', () => {
    const entries = [
      note('a', earlier),
      note('b', thisMonth),
      note('c', thisWeek),
      note('d', yesterday),
      note('e', today),
    ];
    const groups = groupNotesByDate(entries, NOW);
    expect(groups.map((g) => g.key)).toEqual([
      'today',
      'yesterday',
      'thisWeek',
      'thisMonth',
      'earlier',
    ]);
    expect(groups[0].entries.map((n) => n.id)).toEqual(['e']);
  });

  test('omits empty buckets and preserves input order inside a bucket', () => {
    const entries = [
      note('recent1', NOW.getTime() - HOUR),
      note('recent2', NOW.getTime() - 2 * HOUR),
      note('old', earlier),
    ];
    const groups = groupNotesByDate(entries, NOW);
    expect(groups.map((g) => g.key)).toEqual(['today', 'earlier']);
    expect(groups[0].entries.map((n) => n.id)).toEqual(['recent1', 'recent2']);
  });

  test('yesterday wins over calendar-week for a Monday "now"', () => {
    // NOW is Wednesday; yesterday (Tue) is inside the same week — covered.
    // A note from Sunday Nov 1 23:00 with now=Mon Nov 2 00:30 must be
    // "yesterday", not "thisWeek" (week bucket starts Monday 00:00).
    const mondayNoon = new Date(2026, 10, 2, 0, 30);
    const groups = groupNotesByDate(
      [note('sun', new Date(2026, 10, 1, 23, 0).getTime())],
      mondayNoon,
    );
    expect(groups.map((g) => g.key)).toEqual(['yesterday']);
  });

  test('boundary: exactly start-of-today counts as today', () => {
    const groups = groupNotesByDate(
      [note('midnight', new Date(2026, 10, 4, 0, 0).getTime())],
      NOW,
    );
    expect(groups.map((g) => g.key)).toEqual(['today']);
  });

  test('empty input yields no groups', () => {
    expect(groupNotesByDate([], NOW)).toEqual([]);
  });

  test('relative offsets from a moving now stay consistent', () => {
    const groups = groupNotesByDate(
      [note('n', NOW.getTime() - 63 * HOUR)],
      NOW,
    );
    // 63h ago on Wed 15:30 → Mon 00:30 → calendar week bucket
    expect(groups[0].key).toBe('thisWeek');
  });
});
