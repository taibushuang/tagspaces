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
import { describe, expect, test, beforeEach } from '@playwright/test';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  IssueDatabase,
  deriveTagFromMachineId,
  ensureMachineTag,
  renderIssuesMarkdown,
} from '../../src/main/issueStore';

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-issues-'));
});

describe('IssueDatabase 校验', () => {
  test('create：标题必填、默认 bug/open/medium/ui', () => {
    const db = new IssueDatabase(path.join(dir, 'issues.json'));
    expect(() => db.create({ title: '  ' })).toThrow('Title is required');
    const item = db.create({ title: '删除时崩溃' });
    expect(item.type).toBe('bug');
    expect(item.status).toBe('open');
    expect(item.severity).toBe('medium');
    expect(item.source).toBe('ui');
    const f = db.create({ title: '想要批量重命名', type: 'feature' });
    expect(f.type).toBe('feature');
  });

  test('create：非法 type/severity/source 抛错', () => {
    const db = new IssueDatabase(path.join(dir, 'issues.json'));
    expect(() => db.create({ title: 'x', type: 'question' })).toThrow(
      'Invalid type',
    );
    expect(() =>
      db.create({ title: 'x', severity: 'critical' }),
    ).toThrow('Invalid severity');
    expect(() => db.create({ title: 'x', source: 'robot' })).toThrow(
      'Invalid source',
    );
  });

  test('长标题拒绝；description 截断到 5000', () => {
    const db = new IssueDatabase(path.join(dir, 'issues.json'));
    expect(() => db.create({ title: 'a'.repeat(201) })).toThrow(
      'Title too long',
    );
    const item = db.create({
      title: 'ok',
      description: 'x'.repeat(6000),
    });
    expect(item.description.length).toBe(5000);
  });

  test('context 字段逐个裁剪到 1024，空 context 不保存', () => {
    const db = new IssueDatabase(path.join(dir, 'issues.json'));
    const item = db.create({
      title: 'ok',
      context: {
        folderPath: '/x'.repeat(2000),
        locationName: 'Notes',
        platform: '',
      },
    });
    expect(item.context.folderPath.length).toBe(1024);
    expect(item.context.locationName).toBe('Notes');
    expect(item.context.platform).toBeUndefined();
    const empty = db.create({ title: 'no ctx', context: {} });
    expect(empty.context).toBeUndefined();
  });

  test('selectedEntries：截断到 10 条、单条路径截断到 256', () => {
    const db = new IssueDatabase(path.join(dir, 'issues.json'));
    const paths = Array.from(
      { length: 12 },
      (_, i) => '/root/' + 'f'.repeat(300) + i + '.txt',
    );
    const item = db.create({
      title: 'sel',
      context: { selectedEntries: paths },
    });
    expect(item.context.selectedEntries).toHaveLength(10);
    expect(item.context.selectedEntries[0].length).toBe(256);
  });

  test('lastToolError：error 必填，args 截断 500', () => {
    const db = new IssueDatabase(path.join(dir, 'issues.json'));
    const item = db.create({
      title: 'evidence',
      context: {
        lastToolError: {
          tool: 'delete_files',
          args: 'a'.repeat(600),
          error: 'EPERM: operation not permitted',
          at: 1697000000000,
        },
      },
    });
    expect(item.context.lastToolError.tool).toBe('delete_files');
    expect(item.context.lastToolError.args.length).toBe(500);
    expect(item.context.lastToolError.error).toContain('EPERM');
    // 无 error 字段时整个 lastToolError 丢弃
    const noError = db.create({
      title: 'evidence2',
      context: { lastToolError: { tool: 'x' } },
    });
    expect(noError.context).toBeUndefined(); // 无其他字段则整个 context 为空
  });
});

describe('IssueDatabase 生命周期', () => {
  test('update：状态流转写 resolvedAt；source 不可被改写、context 可补写', () => {
    const db = new IssueDatabase(path.join(dir, 'issues.json'));
    const item = db.create({
      title: 't',
      source: 'agent',
      context: { locationName: 'A' },
    });
    const done = db.update(item.id, {
      status: 'done',
      source: 'ui',
      context: { locationName: 'B', appVersion: '6.18.0' },
    });
    expect(done.status).toBe('done');
    expect(done.resolvedAt).toBeTruthy();
    expect(done.source).toBe('agent'); // immutable
    expect(done.context.locationName).toBe('B'); // context patchable
    expect(done.context.appVersion).toBe('6.18.0');
    const reopened = db.update(item.id, { status: 'open' });
    expect(reopened.resolvedAt).toBeUndefined();
  });

  test('update/remove：未知 id 抛错或返回 0', () => {
    const db = new IssueDatabase(path.join(dir, 'issues.json'));
    expect(() => db.update('nope', { status: 'done' })).toThrow('not found');
    expect(db.remove('nope')).toBe(0);
  });

  test('list：过滤 + newest-first + stats', () => {
    const db = new IssueDatabase(path.join(dir, 'issues.json'));
    const a = db.create({ title: 'aaa bug', type: 'bug' });
    db.create({ title: 'bbb feature', type: 'feature' });
    db.update(a.id, { status: 'done' });
    expect(db.list({ type: 'bug' }).items).toHaveLength(1);
    expect(db.list({ status: 'open' }).items[0].title).toBe('bbb feature');
    expect(db.list({ keyword: 'BBB' }).items).toHaveLength(1);
    const stats = db.list().stats;
    expect(stats).toEqual({ total: 2, open: 1, done: 1 });
  });
});

describe('IssueDatabase 持久化', () => {
  test('重开实例数据还在（原子写）', () => {
    const file = path.join(dir, 'issues.json');
    const db = new IssueDatabase(file);
    db.create({ title: 'persisted' });
    const db2 = new IssueDatabase(file);
    const res = db2.load();
    expect(res.ok).toBe(true);
    expect(res.recoveredFromBackup).toBe(false);
    expect(db2.list().items).toHaveLength(1);
  });

  test('主文件损坏时从备份恢复', () => {
    const file = path.join(dir, 'issues.json');
    const db = new IssueDatabase(file);
    db.create({ title: 'keep me' });
    db.update(db.list().items[0].id, { status: 'done' }); // 触发第二次写 → 生成 .bak.0
    fs.writeFileSync(file, '{corrupt', 'utf8');
    const db2 = new IssueDatabase(file);
    const res = db2.load();
    expect(res.ok).toBe(true);
    expect(res.recoveredFromBackup).toBe(true);
    expect(db2.list().items).toHaveLength(1);
  });

  test('exportMarkdown 写出文件', () => {
    const file = path.join(dir, 'issues.json');
    const db = new IssueDatabase(file);
    db.create({ title: 'a bug', type: 'bug', severity: 'high' });
    db.create({ title: 'a feature', type: 'feature' });
    const target = path.join(dir, 'out', 'issues.md');
    expect(db.exportMarkdown(target)).toBe(2);
    const md = fs.readFileSync(target, 'utf8');
    expect(md).toContain('# 需求与缺陷收集');
    expect(md).toContain('a bug');
    expect(md).toContain('a feature');
  });
});

describe('renderIssuesMarkdown', () => {
  test('全量交付文档：编号 / 环境快照 / 相关文件 / 工具错误现场', () => {
    const md = renderIssuesMarkdown([
      {
        id: '1',
        type: 'bug',
        title: '崩溃',
        description: '点击导出后无响应\n--- structured repro info ---\n期望行为:\n列表应少一项',
        severity: 'high',
        status: 'open',
        source: 'agent',
        context: {
          appVersion: '6.18.0',
          platform: 'darwin',
          osVersion: '24.3.0',
          appLanguage: 'zh-CN',
          locationName: 'Notes',
          locationPath: '/Users/demo/Notes',
          folderPath: '/Users/demo/Notes/work',
          selectedEntries: ['/Users/demo/Notes/work/a.txt'],
          lastToolError: {
            tool: 'delete_files',
            args: '{"paths":["/root/a.txt"]}',
            error: 'EPERM: operation not permitted',
            at: 1697000000000,
          },
        },
        createdAt: '2026-10-19T10:00:00.000Z',
        updatedAt: '2026-10-19T10:00:00.000Z',
      },
      {
        id: '2',
        type: 'feature',
        title: '批量改名',
        severity: 'medium',
        status: 'done',
        source: 'ui',
        createdAt: '2026-10-18T10:00:00.000Z',
        updatedAt: '2026-10-19T10:00:00.000Z',
        resolvedAt: '2026-10-19T11:00:00.000Z',
      },
    ]);
    // 头部统计
    expect(md).toContain('# 需求与缺陷收集');
    expect(md).toContain('共 2 条（待处理 1 / 已处理 1）');
    // 编号（分组内 newest-first）
    expect(md).toContain('### [BUG-001] 崩溃');
    expect(md).toContain('### [REQ-001] 批量改名');
    // 元信息
    expect(md).toContain('待处理 (open) | 类型: bug | 严重程度: high | 来源: AI Agent 上报');
    expect(md).toContain('已处理 (done) | 类型: feature');
    expect(md).toContain('处理时间: 2026-10-19 11:00:00');
    // 环境快照 + 场景
    expect(md).toContain('- 环境: 应用 v6.18.0 · darwin (24.3.0) · 语言 zh-CN');
    expect(md).toContain('- 场景: 位置 Notes (/Users/demo/Notes) · 文件夹 /Users/demo/Notes/work');
    // 详情原文（含结构化复现信息）
    expect(md).toContain('期望行为:\n列表应少一项');
    // 相关文件 + 工具错误现场
    expect(md).toContain('#### 相关文件');
    expect(md).toContain('- /Users/demo/Notes/work/a.txt');
    expect(md).toContain('#### 最近工具错误（缺陷现场）');
    expect(md).toContain('- 工具: delete_files');
    expect(md).toContain('- 参数: `{"paths":["/root/a.txt"]}`');
    expect(md).toContain('- 错误: EPERM: operation not permitted');
    expect(md).toContain('- 时间: 2023-10-');
  });
});

describe('ensureMachineTag（机器标识）', () => {
  test('硬件机器 id 派生：确定性且写入文件复用', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-machtag-'));
    const tag1 = ensureMachineTag(dir, () => 'IO-UUID-ABCD');
    const tag2 = ensureMachineTag(dir, () => 'IO-UUID-ABCD');
    expect(tag1).toBe(tag2);
    expect(tag1).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
    // 同一硬件 id 在另一个空目录也得到相同 tag（跨目录确定性）
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-machtag-'));
    expect(ensureMachineTag(dir2, () => 'IO-UUID-ABCD')).toBe(tag1);
    // 文件内容就是该 tag
    expect(
      fs.readFileSync(path.join(dir, 'machine.tag'), 'utf8').trim(),
    ).toBe(tag1);
  });

  test('不同硬件 id → 不同 tag', () => {
    const a = deriveTagFromMachineId('uuid-one');
    const b = deriveTagFromMachineId('uuid-two');
    expect(a).not.toBe(b);
  });

  test('已有合法 tag 文件优先（保持已导出文档编号稳定）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-machtag-'));
    fs.writeFileSync(path.join(dir, 'machine.tag'), 'Z9Z9', 'utf8');
    expect(ensureMachineTag(dir, () => 'whatever')).toBe('Z9Z9');
  });

  test('损坏的 tag 文件重新生成', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-machtag-'));
    fs.writeFileSync(path.join(dir, 'machine.tag'), '00I1', 'utf8'); // 含非法字符
    const tag = ensureMachineTag(dir, () => 'IO-UUID-ABCD');
    expect(tag).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
    expect(tag).not.toBe('00I1');
  });

  test('硬件 id 不可用时回退随机 tag（仍写入文件）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-machtag-'));
    const tag = ensureMachineTag(dir, () => undefined);
    expect(tag).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
    expect(
      fs.readFileSync(path.join(dir, 'machine.tag'), 'utf8').trim(),
    ).toBe(tag);
  });
});

describe('IssueDatabase.updateMany（批量标记）', () => {
  test('批量状态流转：未知 id 报 missing、重复 id 去重、单次落盘', () => {
    const db = new IssueDatabase(path.join(dir, 'issues.json'));
    const a = db.create({ title: 'a' });
    const b = db.create({ title: 'b' });
    const res = db.updateMany([a.id, b.id, a.id, 'ghost'], {
      status: 'done',
    });
    expect(res).toEqual({ updated: 2, missing: ['ghost'] });
    expect(db.list({ status: 'done' }).items).toHaveLength(2);
  });
});

describe('ref 稳定编号（create 分配、落库不变）', () => {
  test('create 分配 {tag}-{BUG|REQ}-NNN，计数器跨删除不复用', () => {
    const db = new IssueDatabase(path.join(dir, 'issues.json'), () => 'A7F3');
    const a = db.create({ title: 'a', type: 'bug' });
    const b = db.create({ title: 'b', type: 'bug' });
    const f = db.create({ title: 'f', type: 'feature' });
    expect(a.ref).toBe('A7F3-BUG-001');
    expect(b.ref).toBe('A7F3-BUG-002');
    expect(f.ref).toBe('A7F3-REQ-001');
    db.remove(b.id);
    const c = db.create({ title: 'c', type: 'bug' });
    expect(c.ref).toBe('A7F3-BUG-003'); // 不复用已删编号
  });

  test('update 不可改写 ref', () => {
    const db = new IssueDatabase(path.join(dir, 'issues.json'), () => 'A7F3');
    const a = db.create({ title: 'a' });
    const done = db.update(a.id, { ref: 'A7F3-BUG-999', status: 'done' });
    expect(done.ref).toBe('A7F3-BUG-001');
  });

  test('legacy 数据（无 ref）load 时回填，计数器接续', () => {
    const file = path.join(dir, 'issues.json');
    // 模拟旧版本落库：两条 bug 无 ref
    fs.writeJsonSync(file, {
      schemaVersion: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      issues: [
        {
          id: 'x1',
          type: 'bug',
          title: 'old-1',
          severity: 'medium',
          status: 'open',
          source: 'ui',
          createdAt: '2026-01-01T00:00:01.000Z',
          updatedAt: '2026-01-01T00:00:01.000Z',
        },
        {
          id: 'x2',
          type: 'bug',
          title: 'old-2',
          severity: 'medium',
          status: 'open',
          source: 'agent',
          createdAt: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
    });
    const db = new IssueDatabase(file, () => 'A7F3');
    db.load();
    // 回填按 newest-first：old-2 → 001，old-1 → 002
    const byTitle = new Map(db.list().items.map((i) => [i.title, i.ref]));
    expect(byTitle.get('old-2')).toBe('A7F3-BUG-001');
    expect(byTitle.get('old-1')).toBe('A7F3-BUG-002');
    // 新条目接续计数器
    expect(db.create({ title: 'new' }).ref).toBe('A7F3-BUG-003');
  });

  test('list 过滤不影响 ref（ref 是条目属性）', () => {
    const db = new IssueDatabase(path.join(dir, 'issues.json'), () => 'A7F3');
    db.create({ title: 'aaa', type: 'bug' });
    db.create({ title: 'bbb', type: 'bug' });
    const onlyBbb = db.list({ keyword: 'bbb' }).items;
    expect(onlyBbb[0].ref).toBe('A7F3-BUG-002');
  });
});

describe('导出编号带机器标识', () => {
  test('renderIssuesMarkdown 使用 machineTag 前缀', () => {
    const items = [
      {
        id: '1',
        type: 'bug',
        title: '崩溃',
        severity: 'high',
        status: 'open',
        source: 'ui',
        createdAt: '2026-10-19T10:00:00.000Z',
        updatedAt: '2026-10-19T10:00:00.000Z',
      },
    ];
    const md = renderIssuesMarkdown(items, 'A7F3');
    expect(md).toContain('### [A7F3-BUG-001] 崩溃');
    expect(md).toContain('机器标识: A7F3');
    // 无 tag 时退回裸编号（兼容旧调用）
    const mdNoTag = renderIssuesMarkdown(items);
    expect(mdNoTag).toContain('### [BUG-001] 崩溃');
  });
});
