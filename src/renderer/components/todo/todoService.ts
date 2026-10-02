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

const todoApi = {
  list: (filter: TodoFilter = {}): Promise<TodoListResult> =>
    invoke('todo:list', filter),
  create: (input: TodoCreateInput): Promise<TodoItem> =>
    invoke('todo:create', input),
  update: (id: string, patch: TodoUpdateInput): Promise<TodoItem> =>
    invoke('todo:update', id, patch),
  remove: (id: string): Promise<number> => invoke('todo:remove', id),
  exportMarkdown: (includeDone: boolean): Promise<TodoExportResult> =>
    invoke('todo:exportMarkdown', includeDone),
  getPath: (): Promise<TodoPathInfo> => invoke('todo:getPath'),
};

export default todoApi;
