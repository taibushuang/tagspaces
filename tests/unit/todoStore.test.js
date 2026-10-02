import { describe, expect, test } from '@playwright/test';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  TodoDatabase,
  renderTodosMarkdown,
} from '../../src/main/todoStore';

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-store-'));
  const db = new TodoDatabase(path.join(dir, 'todos.json'));
  db.load();
  return { db, dir };
}

describe('TodoDatabase', () => {
  describe('create validation', () => {
    test('requires a title', () => {
      const { db } = makeDb();
      expect(() => db.create({ title: '   ' })).toThrow('Title is required');
      expect(() => db.create({ title: '' })).toThrow('Title is required');
    });

    test('rejects over-long titles', () => {
      const { db } = makeDb();
      expect(() => db.create({ title: 'x'.repeat(201) })).toThrow('too long');
    });

    test('rejects invalid enum values', () => {
      const { db } = makeDb();
      expect(() => db.create({ title: 't', status: 'bogus' })).toThrow(
        'Invalid status',
      );
      expect(() =>
        db.create({ title: 't', priority: 'urgent' }),
      ).toThrow('Invalid priority');
    });

    test('rejects malformed dueDate and dueTime', () => {
      const { db } = makeDb();
      expect(() =>
        db.create({ title: 't', dueDate: '2026/10/01' }),
      ).toThrow('Invalid dueDate');
      expect(() =>
        db.create({ title: 't', dueDate: '2026-10-01', dueTime: '25:99' }),
      ).toThrow('Invalid dueTime');
    });

    test('applies defaults for optional fields', () => {
      const { db } = makeDb();
      const item = db.create({ title: 'hello' });
      expect(item.status).toBe('open');
      expect(item.priority).toBe('medium');
      expect(item.tags).toEqual([]);
      expect(item.archived).toBe(false);
      expect(item.source).toBe('manual');
      expect(item.recurrence).toBeNull();
      expect(item.createdAt).toBeTruthy();
      expect(item.updatedAt).toBeTruthy();
      expect(item.completedAt).toBeUndefined();
    });

    test('normalizes tags (dedupe, trim, lowercase)', () => {
      const { db } = makeDb();
      const item = db.create({
        title: 't',
        tags: ['Work', ' work ', '', 'Work'],
      });
      expect(item.tags).toEqual(['work']);
    });
  });

  describe('list filtering and sorting', () => {
    test('returns stats across all active todos', () => {
      const { db } = makeDb();
      db.create({ title: 'a' });
      db.create({ title: 'b', status: 'doing' });
      db.create({ title: 'c', status: 'done' });
      const { stats } = db.list();
      expect(stats).toEqual({ total: 3, open: 1, doing: 1, done: 1 });
    });

    test('keeps open/doing before done and honors manual order', () => {
      const { db } = makeDb();
      const done = db.create({ title: 'old', status: 'done', order: 1 });
      const first = db.create({ title: 'first', order: 2 });
      const doing = db.create({ title: 'mid', status: 'doing', order: 3 });
      const items = db.list().items;
      expect(items.map((i) => i.id)).toEqual([first.id, doing.id, done.id]);
    });

    test('sorts by priority within the same status', () => {
      const { db } = makeDb();
      db.create({ title: 'low', priority: 'low' });
      db.create({ title: 'high', priority: 'high' });
      db.create({ title: 'mid', priority: 'medium' });
      const items = db.list({ sort: 'priority' }).items;
      expect(items.map((i) => i.title)).toEqual(['high', 'mid', 'low']);
    });

    test('filters by status, tag, project and keyword', () => {
      const { db } = makeDb();
      db.create({ title: 'report', tags: ['work'], project: 'office' });
      db.create({ title: 'milk', tags: ['home'] });
      db.create({ title: 'report v2', status: 'done', tags: ['work'] });

      expect(db.list({ status: 'done' }).items.map((i) => i.title)).toEqual([
        'report v2',
      ]);
      expect(db.list({ tag: 'work' }).items).toHaveLength(2);
      expect(db.list({ project: 'office' }).items).toHaveLength(1);
      expect(db.list({ keyword: 'milk' }).items).toHaveLength(1);
      expect(db.list({ keyword: 'REPORT' }).items).toHaveLength(2);
    });

    test('excludes archived unless requested', () => {
      const { db } = makeDb();
      const a = db.create({ title: 'a' });
      db.create({ title: 'b', archived: true });
      expect(db.list().items.map((i) => i.id)).toEqual([a.id]);
      expect(db.list({ includeArchived: true }).items).toHaveLength(2);
    });
  });

  describe('update lifecycle', () => {
    test('sets completedAt on done and clears it when restored', () => {
      const { db } = makeDb();
      const item = db.create({ title: 't' });
      const done = db.update(item.id, { status: 'done' });
      expect(done.completedAt).toBeTruthy();
      expect(done.updatedAt >= item.updatedAt).toBe(true);
      const restored = db.update(item.id, { status: 'open' });
      expect(restored.completedAt).toBeUndefined();
    });

    test('throws when updating a missing todo', () => {
      const { db } = makeDb();
      expect(() => db.update('nope', { title: 'x' })).toThrow('not found');
    });

    test('keeps createdAt stable across updates', () => {
      const { db } = makeDb();
      const item = db.create({ title: 't' });
      const updated = db.update(item.id, { title: 't2' });
      expect(updated.createdAt).toBe(item.createdAt);
      expect(updated.title).toBe('t2');
    });
  });

  describe('remove', () => {
    test('removes an existing todo', () => {
      const { db } = makeDb();
      const item = db.create({ title: 't' });
      expect(db.remove(item.id)).toBe(1);
      expect(db.list().items).toHaveLength(0);
      expect(db.remove(item.id)).toBe(0);
    });
  });

  describe('persistence', () => {
    test('survives a reload from disk', () => {
      const { db, dir } = makeDb();
      db.create({ title: 'persist me', tags: ['disk'] });
      const reloaded = new TodoDatabase(path.join(dir, 'todos.json'));
      const { ok } = reloaded.load();
      expect(ok).toBe(true);
      expect(reloaded.list().items).toHaveLength(1);
      expect(reloaded.list().items[0].title).toBe('persist me');
    });

    test('rotates backups on each write', () => {
      const { db, dir } = makeDb();
      for (let i = 0; i < 12; i += 1) {
        db.create({ title: `item-${i}` });
      }
      const backups = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith('todos.json.bak.'));
      expect(backups).toHaveLength(10);
      expect(fs.existsSync(path.join(dir, 'todos.json.bak.9'))).toBe(true);
      // Newest snapshot is always .bak.0 and matches the previous head.
      const head = db.list().items.map((i) => i.title);
      const bak0 = JSON.parse(
        fs.readFileSync(path.join(dir, 'todos.json.bak.0'), 'utf8'),
      );
      expect(bak0.todos.map((i) => i.title)).toEqual(head.slice(0, -1));
    });

    test('recovers from a corrupt primary file via backup', () => {
      const { db, dir } = makeDb();
      db.create({ title: 'first' });
      db.create({ title: 'safe' });
      fs.writeFileSync(path.join(dir, 'todos.json'), '{ not json !!!');
      const reloaded = new TodoDatabase(path.join(dir, 'todos.json'));
      const { ok, recoveredFromBackup } = reloaded.load();
      expect(ok).toBe(true);
      expect(recoveredFromBackup).toBe(true);
      // .bak.0 holds the state before the last write, which still contains 'first'.
      expect(reloaded.list().items.map((i) => i.title)).toEqual(['first']);
    });
  });

  describe('renderTodosMarkdown', () => {
    test('renders the repo checklist syntax', () => {
      const { db } = makeDb();
      const open = db.create({ title: 'write plan', priority: 'high', dueDate: '2026-10-05', tags: ['plan'], project: 'office' });
      const doing = db.create({ title: 'review', status: 'doing' });
      const done = db.create({ title: 'shipped', status: 'done' });

      const md = renderTodosMarkdown(db.list({ includeArchived: true }).items, false);
      expect(md).toContain('- [ ] write plan — high, 2026-10-05, office, #plan');
      expect(md).toContain('- [~] review');
      expect(md).not.toContain('shipped');

      const all = renderTodosMarkdown(db.list({ includeArchived: true }).items, true);
      expect(all).toContain('- [x] shipped');
      expect(open.id).toBeTruthy();
      expect(doing.id).toBeTruthy();
      expect(done.id).toBeTruthy();
    });

    test('exportMarkdown writes the file', () => {
      const { db, dir } = makeDb();
      db.create({ title: 'exported' });
      const target = path.join(dir, 'out.md');
      const count = db.exportMarkdown(target);
      expect(count).toBe(1);
      expect(fs.readFileSync(target, 'utf8')).toContain('- [ ] exported');
    });
  });
});
