/**
 * Todo feature — pure UI helpers (filtering, sorting, overdue checks).
 * Kept free of React so they can be unit tested.
 */

import {
  TodoItem,
  TodoPriority,
  TodoSortKey,
  TodoStatus,
  TodoStatusFilter,
} from './todoTypes';

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

export function filterTodos(
  items: TodoItem[],
  opts: {
    status: TodoStatusFilter;
    keyword?: string;
    tag?: string;
    project?: string;
  },
): TodoItem[] {
  const keyword = (opts.keyword ?? '').trim().toLowerCase();
  return items.filter((item) => {
    if (opts.status !== 'all' && item.status !== opts.status) return false;
    if (opts.tag && !item.tags.includes(opts.tag)) return false;
    if (opts.project && item.project !== opts.project) return false;
    if (keyword) {
      const hay = `${item.title} ${item.description ?? ''}`.toLowerCase();
      if (!hay.includes(keyword)) return false;
    }
    return true;
  });
}

function compareBySort(a: TodoItem, b: TodoItem, sort: TodoSortKey): number {
  switch (sort) {
    case 'priority':
      return (
        PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority] ||
        (a.dueDate || '').localeCompare(b.dueDate || '')
      );
    case 'dueDate':
      return (
        (a.dueDate || '').localeCompare(b.dueDate || '') ||
        PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority]
      );
    case 'createdAt':
      return a.createdAt.localeCompare(b.createdAt);
    case 'updatedAt':
      return b.updatedAt.localeCompare(a.updatedAt);
    case 'manual':
    default:
      return a.order - b.order;
  }
}

export function sortTodos(items: TodoItem[], sort: TodoSortKey): TodoItem[] {
  const copy = [...items];
  copy.sort((a, b) => {
    const w = STATUS_WEIGHT[a.status] - STATUS_WEIGHT[b.status];
    if (w !== 0) return w;
    return compareBySort(a, b, sort);
  });
  return copy;
}

/** True when the item is not done and its due date is in the past. */
export function isOverdue(item: TodoItem): boolean {
  if (!item.dueDate || item.status === 'done') return false;
  const today = new Date();
  const due = new Date(`${item.dueDate}T23:59:59`);
  return due.getTime() < today.getTime();
}

export function isDueToday(item: TodoItem): boolean {
  if (!item.dueDate || item.status === 'done') return false;
  const today = new Date();
  const dateKey = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`;
  return item.dueDate === dateKey(today);
}

export function pendingCount(stats: { open: number; doing: number }): number {
  return stats.open + stats.doing;
}
