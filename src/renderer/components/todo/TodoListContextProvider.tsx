/**
 * Todo feature — global context: holds the todo list + stats, exposes CRUD
 * actions and the open/close toggle for the inline todo panel. The panel
 * itself is rendered by the content area (RenderPerspective) via props, so
 * the import graph stays acyclic.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import todoApi from './todoService';
import {
  TodoCreateInput,
  TodoItem,
  TodoStats,
  TodoUpdateInput,
} from './todoTypes';
import { pendingCount } from './todoUtils';

type TodoListContextData = {
  items: TodoItem[];
  stats: TodoStats;
  loading: boolean;
  error: string | null;
  dataPath: string;
  pendingCount: number;
  isTodoOpen: boolean;
  refresh: () => Promise<void>;
  createTodo: (input: TodoCreateInput) => Promise<TodoItem>;
  updateTodo: (id: string, patch: TodoUpdateInput) => Promise<TodoItem>;
  removeTodo: (id: string) => Promise<number>;
  exportMarkdown: (includeDone: boolean) => Promise<void>;
  toggleTodoList: () => void;
};

export const TodoListContext = createContext<TodoListContextData>({
  items: [],
  stats: { total: 0, open: 0, doing: 0, done: 0 },
  loading: false,
  error: null,
  dataPath: '',
  pendingCount: 0,
  isTodoOpen: false,
  refresh: async () => {},
  createTodo: async () => {
    throw new Error('TodoListContext not initialized');
  },
  updateTodo: async () => {
    throw new Error('TodoListContext not initialized');
  },
  removeTodo: async () => {
    throw new Error('TodoListContext not initialized');
  },
  exportMarkdown: async () => {},
  toggleTodoList: () => {},
});

export type TodoListContextProviderProps = {
  children: React.ReactNode;
};

export function TodoListContextProvider({
  children,
}: TodoListContextProviderProps) {
  const [isTodoOpen, setIsTodoOpen] = useState<boolean>(false);
  const [items, setItems] = useState<TodoItem[]>([]);
  const [stats, setStats] = useState<TodoStats>({
    total: 0,
    open: 0,
    doing: 0,
    done: 0,
  });
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [dataPath, setDataPath] = useState<string>('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await todoApi.list();
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
    todoApi
      .getPath()
      .then((p) => setDataPath(p.file))
      .catch(() => {});
  }, [refresh]);

  const createTodo = useCallback(
    async (input: TodoCreateInput): Promise<TodoItem> => {
      const created = await todoApi.create(input);
      await refresh();
      return created;
    },
    [refresh],
  );

  const updateTodo = useCallback(
    async (id: string, patch: TodoUpdateInput): Promise<TodoItem> => {
      const updated = await todoApi.update(id, patch);
      await refresh();
      return updated;
    },
    [refresh],
  );

  const removeTodo = useCallback(
    async (id: string): Promise<number> => {
      const removed = await todoApi.remove(id);
      await refresh();
      return removed;
    },
    [refresh],
  );

  const exportMarkdown = useCallback(
    async (includeDone: boolean) => {
      try {
        const result = await todoApi.exportMarkdown(includeDone);
        if (!result.canceled) await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
  );

  const toggleTodoList = useCallback(() => {
    setIsTodoOpen((open) => !open);
  }, []);

  const context = useMemo(
    () => ({
      items,
      stats,
      loading,
      error,
      dataPath,
      pendingCount: pendingCount(stats),
      isTodoOpen,
      refresh,
      createTodo,
      updateTodo,
      removeTodo,
      exportMarkdown,
      toggleTodoList,
    }),
    [
      items,
      stats,
      loading,
      error,
      dataPath,
      isTodoOpen,
      refresh,
      createTodo,
      updateTodo,
      removeTodo,
      exportMarkdown,
      toggleTodoList,
    ],
  );

  return (
    <TodoListContext.Provider value={context}>
      {children}
    </TodoListContext.Provider>
  );
}

export const useTodoListContext = () => useContext(TodoListContext);
