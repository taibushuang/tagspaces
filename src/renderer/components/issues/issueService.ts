/**
 * Issue collection feature — typed wrapper around the main-process IPC
 * channels.
 */

import {
  IssueCreateInput,
  IssueExportResult,
  IssueFilter,
  IssueItem,
  IssueListResult,
  IssuePathInfo,
  IssueUpdateInput,
  IssueUpdateManyResult,
} from './issueTypes';

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  window.electronIO.ipcRenderer.invoke(
    channel as Parameters<typeof window.electronIO.ipcRenderer.invoke>[0],
    ...args,
  ) as Promise<T>;

const issueApi = {
  list: (filter: IssueFilter = {}): Promise<IssueListResult> =>
    invoke('issue:list', filter),
  create: (input: IssueCreateInput): Promise<IssueItem> =>
    invoke('issue:create', input),
  update: (id: string, patch: IssueUpdateInput): Promise<IssueItem> =>
    invoke('issue:update', id, patch),
  updateMany: (
    ids: string[],
    patch: { status: 'open' | 'done' },
  ): Promise<IssueUpdateManyResult> => invoke('issue:updateMany', ids, patch),
  remove: (id: string): Promise<number> => invoke('issue:remove', id),
  exportMarkdown: (): Promise<IssueExportResult> =>
    invoke('issue:exportMarkdown'),
  getPath: (): Promise<IssuePathInfo> => invoke('issue:getPath'),
};

export default issueApi;
