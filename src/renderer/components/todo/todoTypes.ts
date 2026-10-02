/**
 * Todo feature — shared renderer types.
 *
 * Field layout must stay in sync with the authoritative definition in
 * src/main/todoStore.ts (kept separate so the renderer never imports main
 * process modules).
 */

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
  parentId?: string;
  estimateMinutes?: number;
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

export type TodoCreateInput = Pick<TodoItem, 'title'> &
  Partial<
    Omit<TodoItem, 'id' | 'title' | 'createdAt' | 'updatedAt' | 'completedAt'>
  >;

export type TodoUpdateInput = Partial<Omit<TodoItem, 'id' | 'createdAt'>>;

export interface TodoExportResult {
  canceled: boolean;
  count: number;
  filePath: string | null;
}

export interface TodoPathInfo {
  file: string;
  dir: string;
}

export type TodoStatusFilter = 'all' | TodoStatus;

export const TODO_STATUSES: TodoStatus[] = ['open', 'doing', 'done'];
export const TODO_PRIORITIES: TodoPriority[] = ['high', 'medium', 'low'];
export const TODO_RECURRENCE_FREQUENCIES: RecurrenceFrequency[] = [
  'daily',
  'weekly',
  'monthly',
  'yearly',
];
