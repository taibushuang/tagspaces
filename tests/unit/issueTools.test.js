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
import { describe, expect, test, beforeAll } from '@playwright/test';
import { createAgentTools } from '-/components/chat/AgentTools';

// Mock the main-process issue store behind the IPC bridge.
const issueRows = [];
let idSeq = 0;
const counters = { bug: 0, feature: 0 };
const handlers = {
  'issue:list': (filter = {}) => {
    let items = [...issueRows];
    if (filter.type) items = items.filter((i) => i.type === filter.type);
    if (filter.status) items = items.filter((i) => i.status === filter.status);
    if (filter.keyword) {
      items = items.filter((i) =>
        `${i.title} ${i.description || ''}`
          .toLowerCase()
          .includes(filter.keyword.toLowerCase()),
      );
    }
    return {
      items,
      stats: {
        total: issueRows.length,
        open: issueRows.filter((i) => i.status === 'open').length,
        done: issueRows.filter((i) => i.status === 'done').length,
      },
    };
  },
  'issue:create': (input) => {
    if (!input.title || !input.title.trim()) throw new Error('Title is required');
    if (input.type && !['bug', 'feature'].includes(input.type)) {
      throw new Error('Invalid type (expected bug or feature)');
    }
    // deterministic increasing createdAt so newest-first ordering is stable;
    // ref mirrors the main process: assigned once at create, per-type counter
    const type = input.type || 'bug';
    counters[type] = (counters[type] || 0) + 1;
    const item = {
      id: 'iss-' + idSeq,
      ref: `A7F3-${type === 'bug' ? 'BUG' : 'REQ'}-${String(counters[type]).padStart(3, '0')}`,
      type,
      title: input.title,
      description: input.description,
      severity: input.severity || 'medium',
      status: 'open',
      context: input.context,
      source: input.source || 'ui',
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, idSeq)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, idSeq)).toISOString(),
    };
    idSeq += 1;
    issueRows.push(item);
    return item;
  },
  'issue:update': (id, patch) => {
    const item = issueRows.find((i) => i.id === id);
    if (!item) throw new Error('Issue not found');
    Object.assign(item, patch, { updatedAt: new Date().toISOString() });
    return item;
  },
  'issue:updateMany': (ids, patch) => {
    let updated = 0;
    const missing = [];
    for (const id of new Set(ids)) {
      const item = issueRows.find((i) => i.id === id);
      if (item) {
        item.status = patch.status;
        updated += 1;
      } else {
        missing.push(id);
      }
    }
    return { updated, missing };
  },
  'issue:getPath': () => ({
    file: '/userData/issues/issues.json',
    dir: '/userData/issues',
    version: '6.18.0',
    platform: 'darwin',
    osVersion: '24.0.0',
    appLanguage: 'zh-CN',
    machineTag: 'A7F3',
  }),
};

beforeAll(() => {
  globalThis.window = {
    electronIO: {
      ipcRenderer: {
        invoke: (channel, ...args) => {
          if (!handlers[channel]) {
            return Promise.reject(new Error(`unknown channel ${channel}`));
          }
          return Promise.resolve(handlers[channel](...args));
        },
      },
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
  };
});

const deps = {
  agentSearch: async () => [],
  getIndex: () => undefined,
  findEntry: async () => undefined,
  listChildren: async () => [],
  listLocations: () => [{ name: 'Notes', path: '/Users/demo/Notes' }],
  kbList: async () => [],
  kbRead: async () => '',
  kbWrite: async () => ({ id: 'x', path: '' }),
  currentLocationName: 'Notes',
  currentLocationPath: '/Users/demo/Notes',
  currentDirectoryPath: '/Users/demo/Notes/work',
  selectedEntries: [],
  addTagsToFsEntry: async (e) => e,
  removeTagsFromEntry: async () => '',
  loadTextFile: async () => '',
  readFileBytes: async () => new ArrayBuffer(0),
  currentLocationPath: '/Users/demo/Notes',
  moveFile: async () => true,
  moveToPath: async () => true,
  copyFile: async () => true,
  deleteEntries: async () => [],
  requestDeleteConfirmation: async () => true,
  getDescription: async () => '',
  setDescription: async () => true,
  writeTextFile: async () => undefined,
  createLocation: async () => ({}),
};

const tool = (name) => createAgentTools(deps).find((t) => t.name === name);

describe('report_issue / list_issues 工具链（mock IPC）', () => {
  test('report_issue 自动携带 location/folder 上下文并补写版本+OS+语言', async () => {
    const res = await tool('report_issue').execute({
      type: 'bug',
      title: '导出失败',
      description: '点击导出后无响应',
      severity: 'high',
    });
    expect(res.ok).toBe(true);
    const row = issueRows[0];
    expect(row.source).toBe('agent');
    expect(row.context.locationName).toBe('Notes');
    expect(row.context.folderPath).toBe('/Users/demo/Notes/work');
    expect(row.context.appVersion).toBe('6.18.0');
    expect(row.context.platform).toBe('darwin');
    expect(row.context.osVersion).toBe('24.0.0');
    expect(row.context.appLanguage).toBe('zh-CN');
    expect(row.severity).toBe('high');
  });

  test('结构化复现信息拼进 description，relatedPaths+选中文件合并去重', async () => {
    const res = await tool('report_issue').execute({
      type: 'bug',
      title: '删除后列表不刷新',
      expected: '列表应少一项',
      observed: 'TypeError: cannot read null',
      steps: '1. 打开 /root/a\n2. 点删除',
      relatedPaths: ['/root/a.txt'],
    });
    expect(res.ok).toBe(true);
    expect(res.withReproInfo).toBe(true);
    const row = issueRows[issueRows.length - 1];
    expect(row.description).toContain('--- structured repro info ---');
    expect(row.description).toContain('复现步骤:\n1. 打开 /root/a');
    expect(row.description).toContain('期望行为:\n列表应少一项');
    expect(row.description).toContain('实际行为:\nTypeError');
    expect(row.description).toContain('- /root/a.txt');
    // relatedPaths 优先并去重合并 deps 里的选中文件
    expect(row.context.selectedEntries).toEqual(['/root/a.txt']);
  });

  test('feature 不接受 severity 和复现字段', async () => {
    const res = await tool('report_issue').execute({
      type: 'feature',
      title: '批量重命名',
      severity: 'high',
    });
    expect(res.error).toContain('severity');
    const res2 = await tool('report_issue').execute({
      type: 'feature',
      title: '批量重命名',
      steps: '1. 2. 3.',
    });
    expect(res2.error).toContain('bug-repro');
  });

  test('list_issues 过滤 + report 前查重 + ref 为落库稳定编号', async () => {
    const all = await tool('list_issues').execute({});
    expect(all.stats.total).toBe(2);
    expect(all.machineTag).toBe('A7F3');
    // ref 是 create 时分配的持久编号（与过滤无关，不受 keyword/status 影响）
    const byTitle = new Map(all.items.map((i) => [i.title, i.ref]));
    expect(byTitle.get('导出失败')).toBe('A7F3-BUG-001');
    expect(byTitle.get('删除后列表不刷新')).toBe('A7F3-BUG-002');
    // 过滤后的子集 ref 不重排
    const filtered = await tool('list_issues').execute({ keyword: '导出' });
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0].ref).toBe('A7F3-BUG-001');
    const none = await tool('list_issues').execute({ keyword: '不存在' });
    expect(none.items).toHaveLength(0);
  });

  test('标题缺失时报错', async () => {
    const res = await tool('report_issue').execute({ type: 'bug' });
    expect(res.error).toContain('title');
  });
});
