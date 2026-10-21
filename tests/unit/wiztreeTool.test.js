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

const wiztreeTool = () =>
  createAgentTools({}).find((t) => t.name === 'wiztree_scan');

describe('wiztree_scan', () => {
  test('非 Electron 环境返回 error', async () => {
    globalThis.window = { localStorage: globalThis.localStorage };
    const result = await wiztreeTool().execute({ path: 'C:' });
    expect(result.error).toContain('desktop app');
    expect(result.ok).toBeUndefined();
  });

  test('透传主进程结果并转发参数', async () => {
    const calls = [];
    const payload = {
      ok: true,
      scannedPath: 'C:\\',
      durationMs: 4200,
      totalFiles: 1200,
      totalFolders: 80,
      totalSize: 512000,
      topFolders: [{ path: 'C:\\Windows', size: 400000, allocated: 400000 }],
    };
    globalThis.window = {
      localStorage: globalThis.localStorage,
      electronIO: {
        ipcRenderer: {
          invoke: (channel, args) => {
            calls.push({ channel, args });
            return Promise.resolve(payload);
          },
        },
      },
    };
    const args = { path: 'C:', topN: 5, includeFiles: true };
    const result = await wiztreeTool().execute(args);
    expect(calls).toEqual([{ channel: 'wiztreeScan', args }]);
    expect(result).toEqual(payload);
  });

  test('ipc 失败时返回 error 而不是抛出', async () => {
    globalThis.window = {
      localStorage: globalThis.localStorage,
      electronIO: {
        ipcRenderer: {
          invoke: () => Promise.reject(new Error('ipc down')),
        },
      },
    };
    const result = await wiztreeTool().execute({ path: 'C:' });
    expect(result).toEqual({ error: 'ipc down' });
  });
});
