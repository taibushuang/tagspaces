/**
 * Todo feature — typed wrapper around the main-process IPC channels.
 */

import {
  TodoCreateInput,
  TodoExportResult,
  TodoFilter,
  TodoItem,
  TodoListResult,
  TodoPathInfo,
  TodoUpdateInput,
} from './todoTypes';

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  window.electronIO.ipcRenderer.invoke(
    channel as Parameters<typeof window.electronIO.ipcRenderer.invoke>[0],
    ...args,
  ) as Promise<T>;

/**
 * Fired after every todo mutation. Agent tools write through this module too,
 * but they cannot reach TodoListContextProvider directly — this event keeps
 * the panel and the pending-count badge in sync while an agent works on a todo.
 */
export const TODO_CHANGED_EVENT = 'ts:todo-changed';

function notifyTodoChanged() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(TODO_CHANGED_EVENT));
  }
}

const todoApi = {
  list: (filter: TodoFilter = {}): Promise<TodoListResult> =>
    invoke('todo:list', filter),
  create: async (input: TodoCreateInput): Promise<TodoItem> => {
    const created = await invoke<TodoItem>('todo:create', input);
    notifyTodoChanged();
    return created;
  },
  update: async (id: string, patch: TodoUpdateInput): Promise<TodoItem> => {
    const updated = await invoke<TodoItem>('todo:update', id, patch);
    notifyTodoChanged();
    return updated;
  },
  remove: async (id: string): Promise<number> => {
    const removed = await invoke<number>('todo:remove', id);
    notifyTodoChanged();
    return removed;
  },
  exportMarkdown: (includeDone: boolean): Promise<TodoExportResult> =>
    invoke('todo:exportMarkdown', includeDone),
  getPath: (): Promise<TodoPathInfo> => invoke('todo:getPath'),
};

export default todoApi;
