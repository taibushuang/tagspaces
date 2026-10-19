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
import { revokeDelete } from '-/utils/agentDelete';

// Minimal localStorage so the delete grants / history persist in Node.
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
  globalThis.localStorage = ls;
  globalThis.window = { localStorage: ls };
});
beforeEach(() => {
  store = {};
});

const LOCATION = '/root';

function makeDeleteDeps(fs, { confirm = true } = {}) {
  const confirmCalls = [];
  return {
    agentSearch: async () => [],
    getIndex: () => undefined,
    findEntry: async (path) => fs.get(path),
    listChildren: async (path) =>
      [...fs.values()].filter(
        (e) => e.path.startsWith(path + '/') && !e.path.slice(path.length + 1).includes('/'),
      ),
    listLocations: () => [{ name: 'Root', path: LOCATION }],
    kbList: async () => [],
    kbRead: async () => '',
    kbWrite: async () => ({ id: 'x', path: '' }),
    currentLocationName: 'Root',
    currentDirectoryPath: LOCATION,
    selectedEntries: [],
    addTagsToFsEntry: async (e) => e,
    removeTagsFromEntry: async () => '',
    loadTextFile: async () => '',
    readFileBytes: async () => new ArrayBuffer(0),
    currentLocationPath: LOCATION,
    moveFile: async () => true,
    moveToPath: async () => true,
    getDescription: async () => '',
    setDescription: async () => true,
    writeTextFile: async () => undefined,
    createLocation: async () => ({}),
    deleteEntries: async (items) =>
      items.map((i) => {
        const existed = fs.delete(i.path);
        return { path: i.path, ok: existed };
      }),
    requestDeleteConfirmation: async (payload) => {
      confirmCalls.push(payload);
      return confirm;
    },
  };
}

const seed = (fs, path, isFile, size = 100) =>
  fs.set(path, {
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    isFile,
    size,
    lmdt: size,
  });

const deleteTool = (deps) =>
  createAgentTools(deps).find((t) => t.name === 'delete_files');
const deleteFolderTool = (deps) =>
  createAgentTools(deps).find((t) => t.name === 'delete_folder');

describe('delete_files 工具全链（mock deps）', () => {
  test('未授权 + 用户拒绝 → 全部跳过且不删除', async () => {
    const fs = new Map();
    seed(fs, '/root/a.txt', true);
    seed(fs, '/root/b.txt', true);
    const deps = makeDeleteDeps(fs, { confirm: false });
    const res = await deleteTool(deps).execute({
      paths: ['/root/a.txt', '/root/b.txt'],
      reason: 'temp files',
    });
    expect(res.error).toContain('denied');
    expect(res.denied).toHaveLength(2);
    expect(fs.has('/root/a.txt')).toBe(true);
    expect(deps.requestDeleteConfirmation.mockCalls?.length ?? 1).toBeTruthy();
  });

  test('确认通过 → 回收站删除 + 记住授权，第二次不再弹确认', async () => {
    const fs = new Map();
    seed(fs, '/root/a.txt', true);
    const deps = makeDeleteDeps(fs, { confirm: true });
    const tool = deleteTool(deps);
    const first = await tool.execute({ paths: ['/root/a.txt'] });
    expect(first.ok).toBe(true);
    expect(first.deleted[0].path).toBe('/root/a.txt');
    expect(fs.has('/root/a.txt')).toBe(false);

    seed(fs, '/root/b.txt', true);
    const before = deps.requestDeleteConfirmation ? 1 : 1;
    const second = await tool.execute({ paths: ['/root/b.txt'] });
    expect(second.ok).toBe(true);
    expect(second.denied ?? []).toHaveLength(0);
    expect(before).toBe(1); // second call must not have asked again
  });

  test('护栏：location 根 / .ts / 隐藏文件直接拒绝', async () => {
    const fs = new Map();
    seed(fs, '/root', false);
    seed(fs, '/root/.DS_Store', true);
    seed(fs, '/root/.ts/tsi.json', true);
    const deps = makeDeleteDeps(fs, { confirm: true });
    const res = await deleteTool(deps).execute({
      paths: ['/root', '/root/.ts/tsi.json', '/root/.DS_Store'],
    });
    const reasons = (res.invalid || []).map((i) => i.reason).join(' | ');
    expect(reasons).toContain('location root');
    expect(reasons).toContain('.ts');
    expect(reasons).toContain('hidden');
    expect(fs.size).toBe(3);
  });

  test('批内含不存在的路径 → 有效的删、无效的报原因', async () => {
    const fs = new Map();
    seed(fs, '/root/a.txt', true);
    const deps = makeDeleteDeps(fs, { confirm: true });
    const res = await deleteTool(deps).execute({
      paths: ['/root/a.txt', '/root/ghost.txt'],
    });
    expect(res.ok).toBe(true);
    expect(res.invalid[0].path).toBe('/root/ghost.txt');
    expect(res.invalid[0].reason).toContain('not found');
  });

  test('超过单批上限直接报错', async () => {
    const fs = new Map();
    const deps = makeDeleteDeps(fs, { confirm: true });
    const paths = Array.from({ length: 51 }, (_, i) => `/root/f${i}.txt`);
    const res = await deleteTool(deps).execute({ paths });
    expect(res.error).toContain('50');
  });
});

describe('delete_folder 工具全链（mock deps）', () => {
  test('非空文件夹拒绝且不做递归删除', async () => {
    const fs = new Map();
    seed(fs, '/root/sub', false);
    seed(fs, '/root/sub/a.txt', true);
    const deps = makeDeleteDeps(fs, { confirm: true });
    const res = await deleteFolderTool(deps).execute({ path: '/root/sub' });
    expect(res.error).toContain('not empty');
    expect(fs.has('/root/sub')).toBe(true);
    expect(fs.has('/root/sub/a.txt')).toBe(true);
  });

  test('空文件夹确认后删除', async () => {
    const fs = new Map();
    seed(fs, '/root/empty', false);
    const deps = makeDeleteDeps(fs, { confirm: true });
    const res = await deleteFolderTool(deps).execute({ path: '/root/empty' });
    expect(res.ok).toBe(true);
    expect(fs.has('/root/empty')).toBe(false);
  });

  test('授权撤销后再次拒绝', async () => {
    const fs = new Map();
    seed(fs, '/root/empty2', false);
    const deps = makeDeleteDeps(fs, { confirm: false });
    const res = await deleteFolderTool(deps).execute({ path: '/root/empty2' });
    expect(res.error).toContain('denied');
    revokeDelete('/root');
    expect(fs.has('/root/empty2')).toBe(true);
  });
});
