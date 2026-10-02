/**
 * TodoDatabase — file-backed store for the Todo feature.
 *
 * Design follows TagSpaces' own indexing philosophy (JSON file + in-memory
 * copy, see .ts/tsi.json): a small data-access layer on the main process with
 * validation, querying, atomic writes and rotating backups. No database
 * engine, no native deps — the JSON file is the database.
 *
 * This module is deliberately free of any `electron` import so it can be unit
 * tested in a plain Node environment. The IPC wiring lives in todoStoreIpc.ts.
 */

import { randomUUID } from 'crypto';
import fs from 'fs-extra';
import path from 'path';

export type TodoStatus = 'open' | 'doing' | 'done';
export type TodoPriority = 'high' | 'medium' | 'low';
export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface TodoRecurrence {
  frequency: RecurrenceFrequency;
  interval: number;
}

export interface TodoItem {
  id: string;
  title: string;
  description?: string;
  status: TodoStatus;
  priority: TodoPriority;
  tags: string[];
  project?: string;
  dueDate?: string;
  dueTime?: string;
  recurrence: TodoRecurrence | null;
  reminderAt?: string;
  order: number;
  archived: boolean;
  source: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  // Reserved for future task-tree / estimation support (not surfaced in v1).
  parentId?: string;
  estimateMinutes?: number;
}

export type TodoSortKey =
  | 'priority'
  | 'dueDate'
  | 'createdAt'
  | 'updatedAt'
  | 'manual';

export interface TodoFilter {
  status?: TodoStatus;
  tag?: string;
  project?: string;
  keyword?: string;
  sort?: TodoSortKey;
  includeArchived?: boolean;
}

export interface TodoStats {
  total: number;
  open: number;
  doing: number;
  done: number;
}

export interface TodoListResult {
  items: TodoItem[];
  stats: TodoStats;
}

export type TodoCreateInput = Pick<TodoItem, 'title'> &
  Partial<
    Omit<TodoItem, 'id' | 'title' | 'createdAt' | 'updatedAt' | 'completedAt'>
  >;

export type TodoUpdateInput = Partial<Omit<TodoItem, 'id' | 'createdAt'>>;

export const TODO_STATUSES: TodoStatus[] = ['open', 'doing', 'done'];
export const TODO_PRIORITIES: TodoPriority[] = ['high', 'medium', 'low'];
export const TODO_RECURRENCE_FREQUENCIES: RecurrenceFrequency[] = [
  'daily',
  'weekly',
  'monthly',
  'yearly',
];

const SCHEMA_VERSION = 1;
const MAX_BACKUPS = 10;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_SOURCE = 'manual';

const STATUS_WEIGHT: Record<TodoStatus, number> = {
  open: 0,
  doing: 1,
  done: 2,
};
const PRIORITY_WEIGHT: Record<TodoPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

function isTodoStatus(v: unknown): v is TodoStatus {
  return typeof v === 'string' && TODO_STATUSES.includes(v as TodoStatus);
}

function isTodoPriority(v: unknown): v is TodoPriority {
  return typeof v === 'string' && TODO_PRIORITIES.includes(v as TodoPriority);
}

function isRecurrenceFrequency(v: unknown): v is RecurrenceFrequency {
  return (
    typeof v === 'string' &&
    TODO_RECURRENCE_FREQUENCIES.includes(v as RecurrenceFrequency)
  );
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  tags.forEach((raw) => {
    if (typeof raw !== 'string') return;
    const tag = raw.trim().toLowerCase();
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  });
  return out;
}

function normalizeOptionalString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed || undefined;
}

/**
 * Build a valid partial TodoItem from loose user input. Throws with a
 * human-readable message on invalid input so the caller can surface it
 * without persisting. `requireTitle` enforces a non-empty title on create.
 */
function sanitizeTodoInput(
  input: TodoCreateInput | TodoUpdateInput,
  requireTitle: boolean,
): Partial<TodoItem> {
  const out: Partial<TodoItem> = {};

  if (input.title !== undefined) {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title) throw new Error('Title is required');
    if (title.length > 200) throw new Error('Title too long (max 200 chars)');
    out.title = title;
  }

  if (input.description !== undefined) {
    out.description = normalizeOptionalString(input.description);
  }

  if (input.status !== undefined) {
    if (!isTodoStatus(input.status)) throw new Error('Invalid status');
    out.status = input.status;
  }

  if (input.priority !== undefined) {
    if (!isTodoPriority(input.priority)) throw new Error('Invalid priority');
    out.priority = input.priority;
  }

  if (input.tags !== undefined) {
    out.tags = normalizeTags(input.tags);
  }

  if (input.project !== undefined) {
    out.project = normalizeOptionalString(input.project);
  }

  if (input.dueDate !== undefined) {
    if (input.dueDate !== null && input.dueDate !== '') {
      if (typeof input.dueDate !== 'string' || !DATE_RE.test(input.dueDate)) {
        throw new Error('Invalid dueDate (expected YYYY-MM-DD)');
      }
      out.dueDate = input.dueDate;
    } else {
      out.dueDate = undefined;
    }
  }

  if (input.dueTime !== undefined) {
    if (input.dueTime !== null && input.dueTime !== '') {
      if (typeof input.dueTime !== 'string' || !TIME_RE.test(input.dueTime)) {
        throw new Error('Invalid dueTime (expected HH:mm)');
      }
      out.dueTime = input.dueTime;
    } else {
      out.dueTime = undefined;
    }
  }

  if (input.recurrence !== undefined) {
    const r = input.recurrence;
    if (r === null) {
      out.recurrence = null;
    } else if (
      typeof r === 'object' &&
      r !== null &&
      isRecurrenceFrequency(r.frequency) &&
      Number.isInteger(r.interval) &&
      r.interval >= 1 &&
      r.interval <= 365
    ) {
      out.recurrence = { frequency: r.frequency, interval: r.interval };
    } else {
      throw new Error('Invalid recurrence');
    }
  }

  if (input.reminderAt !== undefined) {
    out.reminderAt =
      typeof input.reminderAt === 'string' && input.reminderAt
        ? input.reminderAt
        : undefined;
  }

  if (input.order !== undefined) {
    if (!Number.isFinite(input.order)) throw new Error('Invalid order');
    out.order = input.order;
  }

  if (input.archived !== undefined) {
    out.archived = Boolean(input.archived);
  }

  if (input.source !== undefined) {
    out.source = normalizeOptionalString(input.source) ?? DEFAULT_SOURCE;
  }

  if (input.parentId !== undefined) {
    out.parentId = normalizeOptionalString(input.parentId);
  }

  if (input.estimateMinutes !== undefined) {
    if (
      input.estimateMinutes !== null &&
      !Number.isFinite(input.estimateMinutes)
    ) {
      throw new Error('Invalid estimateMinutes');
    }
    out.estimateMinutes = input.estimateMinutes;
  }

  if (requireTitle && !out.title) throw new Error('Title is required');
  return out;
}

function statusMark(status: TodoStatus): string {
  if (status === 'done') return '[x]';
  if (status === 'doing') return '[~]';
  return '[ ]';
}

/** Render todos as a Markdown checklist (same syntax as the repo TODO-*.md files). */
export function renderTodosMarkdown(
  items: TodoItem[],
  includeDone: boolean,
): string {
  const lines = ['# Todo', ''];
  const visible = items.filter((i) => includeDone || i.status !== 'done');
  const sorted = [...visible].sort((a, b) => {
    const w = STATUS_WEIGHT[a.status] - STATUS_WEIGHT[b.status];
    if (w !== 0) return w;
    const p = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
    if (p !== 0) return p;
    return (a.dueDate || '').localeCompare(b.dueDate || '');
  });
  sorted.forEach((item) => {
    const mark = statusMark(item.status);
    const title = item.title.replace(/\r?\n/g, ' ');
    const meta: string[] = [];
    if (item.priority !== 'medium') meta.push(item.priority);
    if (item.dueDate) meta.push(item.dueDate);
    if (item.project) meta.push(item.project);
    if (item.tags.length > 0) meta.push(`#${item.tags.join(' #')}`);
    const suffix = meta.length > 0 ? ` — ${meta.join(', ')}` : '';
    lines.push(`- ${mark} ${title}${suffix}`);
  });
  lines.push('');
  return lines.join('\n');
}

function isValidTodoItem(t: unknown): t is TodoItem {
  if (!t || typeof t !== 'object') return false;
  const item = t as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    typeof item.title === 'string' &&
    isTodoStatus(item.status) &&
    isTodoPriority(item.priority) &&
    Array.isArray(item.tags) &&
    typeof item.order === 'number' &&
    typeof item.archived === 'boolean' &&
    typeof item.createdAt === 'string' &&
    typeof item.updatedAt === 'string'
  );
}

function compareBy(sort: TodoSortKey) {
  switch (sort) {
    case 'priority':
      return (a: TodoItem, b: TodoItem) =>
        PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority] ||
        (a.dueDate || '').localeCompare(b.dueDate || '');
    case 'dueDate':
      return (a: TodoItem, b: TodoItem) =>
        (a.dueDate || '').localeCompare(b.dueDate || '') ||
        PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
    case 'createdAt':
      return (a: TodoItem, b: TodoItem) =>
        a.createdAt.localeCompare(b.createdAt);
    case 'updatedAt':
      return (a: TodoItem, b: TodoItem) =>
        b.updatedAt.localeCompare(a.updatedAt);
    case 'manual':
    default:
      return (a: TodoItem, b: TodoItem) => a.order - b.order;
  }
}

export class TodoDatabase {
  private todos: TodoItem[] = [];

  private filePath: string;

  constructor(filePath: string) {
    if (!filePath) throw new Error('TodoDatabase requires a file path');
    this.filePath = filePath;
  }

  getPath(): string {
    return this.filePath;
  }

  /** Load the store from disk. Returns true when a previous file existed and parsed OK. */
  load(): { ok: boolean; recoveredFromBackup: boolean } {
    fs.ensureDirSync(path.dirname(this.filePath));
    const candidates = [this.filePath];
    for (let i = 0; i < MAX_BACKUPS; i += 1) {
      candidates.push(this.backupPath(i));
    }
    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      if (fs.existsSync(candidate)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
          const todos =
            parsed && Array.isArray(parsed.todos) ? parsed.todos : [];
          this.todos = todos.filter((t) => isValidTodoItem(t));
          return { ok: true, recoveredFromBackup: i > 0 };
        } catch (err) {
          // Try the next backup; a corrupt file must never wipe the store.
        }
      }
    }
    this.todos = [];
    return { ok: false, recoveredFromBackup: false };
  }

  list(filter: TodoFilter = {}): TodoListResult {
    const {
      status,
      tag,
      project,
      keyword,
      sort = 'manual',
      includeArchived = false,
    } = filter;

    const items = this.todos.filter((item) => {
      if (!includeArchived && item.archived) return false;
      if (status && item.status !== status) return false;
      if (tag && !item.tags.includes(tag)) return false;
      if (project && item.project !== project) return false;
      if (keyword) {
        const hay = `${item.title} ${item.description ?? ''}`.toLowerCase();
        if (!hay.includes(keyword.toLowerCase())) return false;
      }
      return true;
    });

    const bySort = compareBy(sort);
    items.sort((a, b) => {
      const w = STATUS_WEIGHT[a.status] - STATUS_WEIGHT[b.status];
      if (w !== 0) return w;
      return bySort(a, b);
    });

    return { items, stats: this.computeStats() };
  }

  create(input: TodoCreateInput): TodoItem {
    const sanitized = sanitizeTodoInput(input, true);
    const now = new Date().toISOString();
    const item: TodoItem = {
      id: randomUUID(),
      title: sanitized.title!,
      description: sanitized.description,
      status: sanitized.status ?? 'open',
      priority: sanitized.priority ?? 'medium',
      tags: sanitized.tags ?? [],
      project: sanitized.project,
      dueDate: sanitized.dueDate,
      dueTime: sanitized.dueTime,
      recurrence: sanitized.recurrence ?? null,
      reminderAt: sanitized.reminderAt,
      order: sanitized.order ?? Date.now(),
      archived: sanitized.archived ?? false,
      source: sanitized.source ?? DEFAULT_SOURCE,
      createdAt: now,
      updatedAt: now,
      completedAt: sanitized.status === 'done' ? now : undefined,
      parentId: sanitized.parentId,
      estimateMinutes: sanitized.estimateMinutes,
    };
    this.todos.push(item);
    this.persist();
    return item;
  }

  update(id: string, patch: TodoUpdateInput): TodoItem {
    const index = this.todos.findIndex((t) => t.id === id);
    if (index < 0) throw new Error('Todo not found');
    const sanitized = sanitizeTodoInput(patch, false);
    const prev = this.todos[index];
    const merged: TodoItem = {
      ...prev,
      ...sanitized,
      id: prev.id,
      createdAt: prev.createdAt,
    };

    // Maintain lifecycle timestamps.
    if (merged.status === 'done' && prev.status !== 'done') {
      merged.completedAt = new Date().toISOString();
    } else if (merged.status !== 'done' && prev.status === 'done') {
      merged.completedAt = undefined;
    }
    merged.updatedAt = new Date().toISOString();

    this.todos[index] = merged;
    this.persist();
    return merged;
  }

  remove(id: string): number {
    const before = this.todos.length;
    this.todos = this.todos.filter((t) => t.id !== id);
    const removed = before - this.todos.length;
    if (removed > 0) this.persist();
    return removed;
  }

  /** Export the (filtered) checklist to a Markdown file at targetPath. */
  exportMarkdown(targetPath: string, includeDone = false): number {
    const md = renderTodosMarkdown(this.todos, includeDone);
    fs.ensureDirSync(path.dirname(targetPath));
    fs.writeFileSync(targetPath, md, 'utf8');
    return this.todos.filter((i) => includeDone || i.status !== 'done').length;
  }

  private backupPath(index: number): string {
    return `${this.filePath}.bak.${index}`;
  }

  private computeStats(): TodoStats {
    const active = this.todos.filter((t) => !t.archived);
    const stats: TodoStats = {
      total: active.length,
      open: 0,
      doing: 0,
      done: 0,
    };
    active.forEach((t) => {
      stats[t.status] += 1;
    });
    return stats;
  }

  /** Atomic write: temp file then rename, with rotating backups of the previous version. */
  private persist(): void {
    fs.ensureDirSync(path.dirname(this.filePath));
    const tmp = `${this.filePath}.tmp`;
    const data = JSON.stringify(
      {
        schemaVersion: SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        todos: this.todos,
      },
      null,
      2,
    );

    if (fs.existsSync(this.filePath)) {
      // Rotate backups: .bak.9 -> drop, .bak.8 -> .bak.9, ..., file -> .bak.0
      const last = this.backupPath(MAX_BACKUPS - 1);
      if (fs.existsSync(last)) fs.removeSync(last);
      for (let i = MAX_BACKUPS - 2; i >= 0; i -= 1) {
        const cur = this.backupPath(i);
        if (fs.existsSync(cur)) {
          fs.moveSync(cur, this.backupPath(i + 1), { overwrite: true });
        }
      }
      fs.copyFileSync(this.filePath, this.backupPath(0));
    }

    fs.writeFileSync(tmp, data, 'utf8');
    fs.moveSync(tmp, this.filePath, { overwrite: true });
  }
}
