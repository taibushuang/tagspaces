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
import { describe, expect, test, beforeAll, beforeEach } from '@playwright/test';
import { createAgentTools } from '-/components/chat/AgentTools';
import { inboxLastOrganizedMs } from '-/utils/inboxOrganize';

// Minimal localStorage so the organize history journal can persist in Node.
let store = {};
beforeAll(() => {
  const ls = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
    },
    removeItem: (k) => {
      delete store[k];
    },
  };
  globalThis.localStorage = ls; // AgentTools.readDiskInitState reads bare localStorage
  globalThis.window = { localStorage: ls };
});
beforeEach(() => {
  store = {};
});

const baseName = (p) =>
  p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);

function makeDeps(overrides = {}) {
  return {
    agentSearch: async () => [],
    getIndex: () => undefined,
    findEntry: async () => undefined,
    listChildren: async () => [],
    listLocations: () => [],
    kbList: async () => [],
    kbRead: async () => '',
    kbWrite: async () => ({ id: 'x', path: '' }),
    currentLocationName: '',
    currentDirectoryPath: '',
    selectedEntries: [],
    addTagsToFsEntry: async (e) => e,
    removeTagsFromEntry: async () => '',
    loadTextFile: async () => '',
    readFileBytes: async () => new ArrayBuffer(0),
    currentLocationPath: '',
    moveFile: async () => true,
    moveToPath: async () => true,
    getDescription: async () => '',
    setDescription: async () => true,
    writeTextFile: async () => undefined,
    createLocation: async () => ({}),
    ...overrides,
  };
}

describe('organize 工具全链（mock deps）', () => {
  test('preview → apply → history → undo', async () => {
    // Virtual FS so findEntry reflects moves.
    const fs = new Map();
    const seed = (name, size) => {
      const e = { name, path: '/root/' + name, isFile: true, size, lmdt: size };
      fs.set(e.path, e);
    };
    seed('a.pdf', 100);
    seed('b.PNG', 200);
    seed('.DS_Store', 3);

    const deps = makeDeps({
      currentDirectoryPath: '/root',
      listChildren: async () => [...fs.values()],
      findEntry: async (p) => fs.get(p),
      moveToPath: async (from, to) => {
        const e = fs.get(from);
        if (!e) throw new Error('source missing');
        fs.delete(from);
        fs.set(to, { ...e, path: to, name: baseName(to) });
        return true;
      },
    });
    const tools = createAgentTools(deps);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    // preview: 2 files classified, .DS_Store skipped
    const preview = await byName.organize_preview.execute({});
    expect(preview.root).toBe('/root');
    expect(preview.organizable).toHaveLength(2);
    expect(preview.skipped.map((s) => s.name)).toEqual(['.DS_Store']);
    expect(preview.organizable.map((o) => o.category).sort()).toEqual([
      'Documents',
      'Images',
    ]);

    // apply: move both
    const apply = await byName.organize_apply.execute({
      root: '/root',
      moves: preview.organizable.map((o) => ({ from: o.path, to: o.targetPath })),
    });
    expect(apply.status).toBe('done');
    expect(apply.moved).toHaveLength(2);
    expect(fs.has('/root/a.pdf')).toBe(false);
    expect(fs.has('/root/Documents/a.pdf')).toBe(true);
    expect(fs.has('/root/Images/b.PNG')).toBe(true);

    // history: one record, movedCount 2
    const hist = await byName.organize_history.execute({});
    expect(hist).toHaveLength(1);
    expect(hist[0].movedCount).toBe(2);

    // undo: restore both to original paths
    const undo = await byName.organize_undo.execute({ recordId: hist[0].id });
    expect(undo.restored).toHaveLength(2);
    expect(fs.has('/root/a.pdf')).toBe(true);
    expect(fs.has('/root/b.PNG')).toBe(true);
    expect(fs.has('/root/Documents/a.pdf')).toBe(false);
  });

  test('organize_apply 拒绝非法 moves（validateMovePlan 生效）', async () => {
    const deps = makeDeps({ currentDirectoryPath: '/root' });
    const tools = createAgentTools(deps);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const apply = await byName.organize_apply.execute({
      root: '/root',
      moves: [
        { from: '/root/sub/a.pdf', to: '/root/Documents/a.pdf' },
        { from: '/root/a.pdf', to: '/root/../escape.pdf' },
      ],
    });
    expect(apply.error).toContain('no valid moves');
    expect(apply.invalid).toHaveLength(2);
  });

  test('organize_undo 无记录时给友好错误', async () => {
    const deps = makeDeps({ currentDirectoryPath: '/root' });
    const tools = createAgentTools(deps);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const undo = await byName.organize_undo.execute({});
    expect(undo.error).toContain('no matching organize record');
  });

  test('mark_inbox_organized 标记全部收件箱并写入 marker', async () => {
    window.localStorage.setItem(
      'tsDiskInitState',
      JSON.stringify({
        done: true,
        inboxes: [
          { path: '/inbox/Downloads', mode: 'move' },
          { path: '/inbox/Desktop', mode: 'copy' },
        ],
      }),
    );
    const deps = makeDeps({});
    const tools = createAgentTools(deps);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const res = await byName.mark_inbox_organized.execute({});
    expect(res.marked).toEqual(['/inbox/Downloads', '/inbox/Desktop']);
    expect(inboxLastOrganizedMs('/inbox/Downloads')).toBeGreaterThan(0);
    expect(inboxLastOrganizedMs('/inbox/Desktop')).toBeGreaterThan(0);
  });

  test('mark_inbox_organized 指定单个收件箱；无 inbox 时不报错', async () => {
    window.localStorage.setItem(
      'tsDiskInitState',
      JSON.stringify({
        done: true,
        inboxes: [{ path: '/inbox/Downloads', mode: 'move' }],
      }),
    );
    const deps = makeDeps({});
    const tools = createAgentTools(deps);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const res = await byName.mark_inbox_organized.execute({
      inboxPath: '/inbox/Downloads',
    });
    expect(res.marked).toEqual(['/inbox/Downloads']);
    expect(inboxLastOrganizedMs('/inbox/Downloads')).toBeGreaterThan(0);
    expect(inboxLastOrganizedMs('/inbox/Other')).toBe(0);

    // no disk-init inboxes → empty marked, no error
    window.localStorage.removeItem('tsDiskInitState');
    const res2 = await byName.mark_inbox_organized.execute({});
    expect(res2.marked).toEqual([]);
    expect(res2.ok).toBe(true);
  });
});
