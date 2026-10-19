/**
 * Issue collection feature (需求与缺陷收集) — global context: holds the
 * issue list + stats, exposes CRUD actions and the open/close toggle for the
 * inline issues panel. The panel itself is rendered by the content area
 * (RenderPerspective) via props, so the import graph stays acyclic.
 * Mirrors TodoListContextProvider.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import issueApi from './issueService';
import {
  IssueCreateInput,
  IssueItem,
  IssuePathInfo,
  IssueStats,
  IssueUpdateInput,
  IssueUpdateManyResult,
} from './issueTypes';

type IssueListContextData = {
  items: IssueItem[];
  stats: IssueStats;
  loading: boolean;
  error: string | null;
  dataPath: string;
  appInfo: { version: string; platform: string };
  openCount: number;
  isIssuesOpen: boolean;
  refresh: () => Promise<void>;
  createIssue: (input: IssueCreateInput) => Promise<IssueItem>;
  updateIssue: (id: string, patch: IssueUpdateInput) => Promise<IssueItem>;
  updateManyIssues: (
    ids: string[],
    status: 'open' | 'done',
  ) => Promise<IssueUpdateManyResult>;
  removeIssue: (id: string) => Promise<number>;
  exportMarkdown: () => Promise<void>;
  toggleIssues: () => void;
};

export const IssueListContext = createContext<IssueListContextData>({
  items: [],
  stats: { total: 0, open: 0, done: 0 },
  loading: false,
  error: null,
  dataPath: '',
  appInfo: { version: '', platform: '' },
  openCount: 0,
  isIssuesOpen: false,
  refresh: async () => {},
  createIssue: async () => {
    throw new Error('IssueListContext not initialized');
  },
  updateIssue: async () => {
    throw new Error('IssueListContext not initialized');
  },
  updateManyIssues: async () => {
    throw new Error('IssueListContext not initialized');
  },
  removeIssue: async () => {
    throw new Error('IssueListContext not initialized');
  },
  exportMarkdown: async () => {},
  toggleIssues: () => {},
});

export type IssueListContextProviderProps = {
  children: React.ReactNode;
};

export function IssueListContextProvider({
  children,
}: IssueListContextProviderProps) {
  const [isIssuesOpen, setIsIssuesOpen] = useState<boolean>(false);
  const [items, setItems] = useState<IssueItem[]>([]);
  const [stats, setStats] = useState<IssueStats>({
    total: 0,
    open: 0,
    done: 0,
  });
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [dataPath, setDataPath] = useState<string>('');
  const [appInfo, setAppInfo] = useState<{ version: string; platform: string }>(
    { version: '', platform: '' },
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await issueApi.list();
      setItems(result.items);
      setStats(result.stats);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    issueApi
      .getPath()
      .then((p: IssuePathInfo) => {
        setDataPath(p.file);
        setAppInfo({ version: p.version, platform: p.platform });
      })
      .catch(() => {});
  }, [refresh]);

  const createIssue = useCallback(
    async (input: IssueCreateInput): Promise<IssueItem> => {
      const created = await issueApi.create(input);
      await refresh();
      return created;
    },
    [refresh],
  );

  const updateIssue = useCallback(
    async (id: string, patch: IssueUpdateInput): Promise<IssueItem> => {
      const updated = await issueApi.update(id, patch);
      await refresh();
      return updated;
    },
    [refresh],
  );

  const updateManyIssues = useCallback(
    async (
      ids: string[],
      status: 'open' | 'done',
    ): Promise<IssueUpdateManyResult> => {
      const result = await issueApi.updateMany(ids, { status });
      await refresh();
      return result;
    },
    [refresh],
  );

  const removeIssue = useCallback(
    async (id: string): Promise<number> => {
      const removed = await issueApi.remove(id);
      await refresh();
      return removed;
    },
    [refresh],
  );

  const exportMarkdown = useCallback(async () => {
    try {
      const result = await issueApi.exportMarkdown();
      if (!result.canceled) await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [refresh]);

  const toggleIssues = useCallback(() => {
    setIsIssuesOpen((open) => !open);
  }, []);

  const context = useMemo(
    () => ({
      items,
      stats,
      loading,
      error,
      dataPath,
      appInfo,
      openCount: stats.open,
      isIssuesOpen,
      refresh,
      createIssue,
      updateIssue,
      updateManyIssues,
      removeIssue,
      exportMarkdown,
      toggleIssues,
    }),
    [
      items,
      stats,
      loading,
      error,
      dataPath,
      appInfo,
      isIssuesOpen,
      refresh,
      createIssue,
      updateIssue,
      updateManyIssues,
      removeIssue,
      exportMarkdown,
      toggleIssues,
    ],
  );

  return (
    <IssueListContext.Provider value={context}>
      {children}
    </IssueListContext.Provider>
  );
}

export const useIssueListContext = () => useContext(IssueListContext);
