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
import { describe, expect, test } from '@playwright/test';
import './domMatrixStub';
import {
  createAgentTools,
  normalizeInboxes,
  readDiskInitState,
} from '-/components/chat/AgentTools';

// Node test env has no localStorage — provide a minimal in-memory stub.
if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    clear: () => mem.clear(),
  };
}

const toolByName = (name) =>
  createAgentTools({}).find((t) => t.name === name);

const run = (name, args) => toolByName(name).execute(args);

const stored = () => JSON.parse(localStorage.getItem('tsDiskInitState'));

describe('normalizeInboxes', () => {
  test('upgrades legacy plain-string inboxes to move mode', () => {
    expect(normalizeInboxes(['/Users/x/Downloads'])).toEqual([
      { path: '/Users/x/Downloads', mode: 'move' },
    ]);
  });

  test('preserves explicit modes', () => {
    expect(
      normalizeInboxes([
        { path: '/Users/x/Downloads', mode: 'move' },
        { path: '/Users/x/Desktop', mode: 'copy' },
      ]),
    ).toEqual([
      { path: '/Users/x/Downloads', mode: 'move' },
      { path: '/Users/x/Desktop', mode: 'copy' },
    ]);
  });

  test('falls back to move for unknown modes and drops empty paths', () => {
    expect(
      normalizeInboxes([
        { path: '/a', mode: 'bogus' },
        { path: '  ' },
        { mode: 'copy' },
        '  /b  ',
      ]),
    ).toEqual([
      { path: '/a', mode: 'move' },
      { path: '/b', mode: 'move' },
    ]);
  });

  test('ignores non-arrays', () => {
    expect(normalizeInboxes(undefined)).toEqual([]);
    expect(normalizeInboxes(null)).toEqual([]);
  });
});

describe('readDiskInitState', () => {
  test('normalizes a legacy state on read', () => {
    localStorage.setItem(
      'tsDiskInitState',
      JSON.stringify({
        done: true,
        at: 1,
        inboxes: ['/Users/x/Downloads', '/Users/x/Desktop'],
      }),
    );
    expect(readDiskInitState().inboxes).toEqual([
      { path: '/Users/x/Downloads', mode: 'move' },
      { path: '/Users/x/Desktop', mode: 'move' },
    ]);
  });
});

describe('finish_disk_init', () => {
  test('accepts inbox objects with modes and plain strings', async () => {
    const res = await run('finish_disk_init', {
      inboxes: [
        { path: '/Users/x/Downloads', mode: 'copy' },
        { path: '/Users/x/Desktop' },
      ],
      locations: [{ name: 'Work', path: '/Users/x/Work' }],
    });
    expect(res.ok).toBe(true);
    expect(stored().inboxes).toEqual([
      { path: '/Users/x/Downloads', mode: 'copy' },
      { path: '/Users/x/Desktop', mode: 'move' },
    ]);
    expect(stored().locations).toEqual([
      { name: 'Work', path: '/Users/x/Work' },
    ]);
  });

  test('requires at least one inbox', async () => {
    const res = await run('finish_disk_init', { inboxes: [] });
    expect(res.error).toContain('at least one inbox');
  });
});

describe('update_disk_init', () => {
  test('switches the mode of an already-registered inbox', async () => {
    await run('finish_disk_init', {
      inboxes: [{ path: '/Users/x/Downloads', mode: 'move' }],
    });
    const res = await run('update_disk_init', {
      addInboxes: [{ path: '/Users/x/Downloads', mode: 'copy' }],
    });
    expect(res.ok).toBe(true);
    expect(res.state.inboxes).toEqual([
      { path: '/Users/x/Downloads', mode: 'copy' },
    ]);
  });

  test('adds a new inbox with a mode and keeps existing ones', async () => {
    await run('finish_disk_init', {
      inboxes: [{ path: '/Users/x/Downloads', mode: 'move' }],
    });
    const res = await run('update_disk_init', {
      addInboxes: [{ path: '/Users/x/Desktop', mode: 'copy' }],
    });
    expect(res.state.inboxes).toEqual([
      { path: '/Users/x/Downloads', mode: 'move' },
      { path: '/Users/x/Desktop', mode: 'copy' },
    ]);
  });

  test('removes an inbox and refuses to remove the last one', async () => {
    await run('finish_disk_init', {
      inboxes: [
        { path: '/Users/x/Downloads', mode: 'move' },
        { path: '/Users/x/Desktop', mode: 'copy' },
      ],
    });
    let res = await run('update_disk_init', {
      removeInboxes: ['/Users/x/Desktop'],
    });
    expect(res.state.inboxes).toEqual([
      { path: '/Users/x/Downloads', mode: 'move' },
    ]);
    res = await run('update_disk_init', {
      removeInboxes: ['/Users/x/Downloads'],
    });
    expect(res.error).toContain('refusing to remove the last inbox');
  });

  test('rejects adjustments before initialization', async () => {
    localStorage.removeItem('tsDiskInitState');
    const res = await run('update_disk_init', {
      addInboxes: [{ path: '/Users/x/Desktop' }],
    });
    expect(res.error).toContain('has not been run yet');
  });
});
