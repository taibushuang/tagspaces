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

/**
 * Persistent home of the agent conversation + run state.
 *
 * The AgentPanel lives inside a Drawer that is mounted only while the AI work
 * area is visible. Scheduled tasks must keep running with the panel closed,
 * so sessions, the active run and the scheduled-task executor are hoisted
 * here (mounted with the dialog providers, which never unmount).
 *
 * All race protections from d6a7b389b live here now and are unchanged:
 * - runId guard in the run teardown,
 * - skipUserBubble for resumed instructions,
 * - location check before auto-resuming queued instructions,
 * - session lock while a run is in flight.
 */
import {
  AgentEvent,
  AgentInterruptQueue,
  runAgent,
} from '-/components/chat/AgentService';
import {
  createAgentTools,
  isElectron,
  readDiskInitState,
} from '-/components/chat/AgentTools';
import {
  getEnabledCustomSkills,
  incrementSkillUseCount,
  incrementToolCallCount,
} from '-/components/chat/agentCapabilities';
import { buildAgentSystemPrompt } from '-/components/chat/agentPrompt';
import { loadLocationConventions } from '-/components/chat/locationConventions';
import { makeKbToolDeps } from '-/services/knowledgeBase';
import { useChatContext } from '-/hooks/useChatContext';
import { useCurrentLocationContext } from '-/hooks/useCurrentLocationContext';
import { useDirectoryContentContext } from '-/hooks/useDirectoryContentContext';
import { useIOActionsContext } from '-/hooks/useIOActionsContext';
import { useLocationIndexContext } from '-/hooks/useLocationIndexContext';
import { useNotificationContext } from '-/hooks/useNotificationContext';
import { usePlatformFacadeContext } from '-/hooks/usePlatformFacadeContext';
import { useSelectedEntriesContext } from '-/hooks/useSelectedEntriesContext';
import { useTaggingActionsContext } from '-/hooks/useTaggingActionsContext';
import { getDefaultAIProvider, getCurrentLanguage } from '-/reducers/settings';
import { CommonLocation } from '-/utils/CommonLocation';
import { getUuid } from '@tagspaces/tagspaces-common/utils-io';
import { TS } from '-/tagspaces.namespace';
import { format } from 'date-fns';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useSelector } from 'react-redux';
import { findOverdue } from '-/utils/agentSchedule';
import type { AgentScheduledTask } from '-/utils/agentSchedule';

export type AgentToolStep = {
  id: string;
  name: string;
  args: string;
  result?: string;
  isError?: boolean;
};

export type AgentChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; steps: AgentToolStep[] };

export type AgentSession = {
  id: string;
  title: string;
  updatedAt: number;
  messages: AgentChatMessage[];
  /** OpenAI-format conversation carried across runs (incl. tool results). */
  apiMessages: Record<string, any>[];
};

export type AgentScheduledRunning = {
  taskId: string;
  sessionId: string;
};

export type AgentStartRunResult = 'success' | 'failed' | 'aborted';

export type AgentStartRunOptions = {
  sessionId: string;
  text: string;
  skipUserBubble?: boolean;
  /**
   * Context snapshot override. Scheduled runs execute against the location
   * they were created for, not whatever the UI currently shows. Omitted for
   * manual runs (they follow the current location, as before).
   */
  locationId?: string;
};

export type AgentSessionsContextData = {
  sessions: AgentSession[];
  currentSessionId: string;
  currentSession: AgentSession;
  setCurrentSessionId: (id: string) => void;
  updateSession: (
    id: string,
    updater: (session: AgentSession) => AgentSession,
  ) => void;
  isRunning: boolean;
  queuedCount: number;
  runningTask: AgentScheduledRunning | null;
  /** Whether this window is the app's main (executor) window. Child windows
   *  (opened for MD documents) are dormant for scheduled tasks. */
  isExecutor: boolean;
  restoredInput: string | null;
  consumeRestoredInput: () => void;
  startRun: (opts: AgentStartRunOptions) => Promise<AgentStartRunResult>;
  stopRun: () => void;
  enqueueInterrupt: (text: string) => void;
  newAgentSession: () => void;
  deleteCurrentAgentSession: () => void;
  tasks: AgentScheduledTask[];
  refreshTasks: () => Promise<void>;
  runNow: (taskId: string) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
  toggleTaskEnabled: (taskId: string, enabled: boolean) => Promise<void>;
  missedTasks: AgentScheduledTask[];
  dismissMissed: () => void;
};

const SESSIONS_KEY = 'tsAiAgentSessions';

/** Delay between "agent busy" retries for a due scheduled task. */
export const SCHEDULED_TASK_RETRY_DELAY_MS = 60_000;
/** Max number of retries before a busy agent causes a skipped result. */
export const SCHEDULED_TASK_MAX_RETRIES = 10;

/**
 * Pure retry decision (exported for tests / reuse): each attempt waits the
 * same 60s window, matching the plan's conflict policy.
 */
export function nextRetryDelay(_retryCount: number): number {
  return SCHEDULED_TASK_RETRY_DELAY_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function loadSessions(): AgentSession[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

export function newSession(): AgentSession {
  const now = Date.now();
  return {
    id: 'agent-' + now + '-' + Math.random().toString(36).slice(2, 8),
    title: '',
    updatedAt: now,
    messages: [],
    apiMessages: [],
  };
}

export function sessionTitle(session: AgentSession): string {
  if (session.title) {
    return session.title;
  }
  const firstUser = session.messages.find((m) => m.role === 'user');
  if (firstUser && firstUser.content) {
    return firstUser.content.slice(0, 30);
  }
  return format(session.updatedAt, 'MM-dd HH:mm');
}

export function shortText(text: string, limit = 120): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > limit ? oneLine.slice(0, limit) + '…' : oneLine;
}

export function prettyArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args || '{}'), null, 2);
  } catch (e) {
    return args || '{}';
  }
}

export function transcriptToMarkdown(
  session: AgentSession,
  t: (key: string) => string,
): string {
  return session.messages
    .map((message) => {
      if (message.role === 'user') {
        return `### ${t('core:aiAgentRoleUser')}\n\n${message.content}`;
      }
      const steps = message.steps
        .map((step) => {
          const parts = [
            `**${step.name}**`,
            '```json\n' + prettyArgs(step.args) + '\n```',
          ];
          if (step.result) {
            parts.push('```\n' + step.result + '\n```');
          }
          return parts.join('\n\n');
        })
        .join('\n\n');
      return `### ${t('core:aiAgentRoleAssistant')}\n\n${
        steps ? steps + '\n\n' : ''
      }${message.content}`;
    })
    .join('\n\n---\n\n');
}

export const AgentSessionsContext =
  createContext<AgentSessionsContextData>(undefined);

const MAX_FAILED_DETAIL = 300;

export function AgentSessionsContextProvider(props: {
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const { showNotification } = useNotificationContext();
  const { currentModel } = useChatContext();
  const defaultAiProvider = useSelector(getDefaultAIProvider);
  const interfaceLanguage = useSelector(getCurrentLanguage);
  const { findLocation, findLocationByPath, locations, addLocation } =
    useCurrentLocationContext();
  const { agentSearch, getIndex, findEntry, listChildren } =
    useLocationIndexContext();
  const { currentDirectoryPath } = useDirectoryContentContext();
  const { selectedEntries } = useSelectedEntriesContext();
  const { addTagsToFsEntry, removeTagsFromEntry } = useTaggingActionsContext();
  const { setDescriptionChange, moveFiles, copyFiles } = useIOActionsContext();
  const { moveFilesPromise } = usePlatformFacadeContext();

  // ---- sessions -----------------------------------------------------------
  const [sessions, setSessionsState] = useState<AgentSession[]>(loadSessions);
  const sessionsRef = useRef<AgentSession[]>(sessions);
  const [currentSessionId, setCurrentSessionIdState] = useState<string>(
    () => sessions[0]?.id || '',
  );
  const currentSessionIdRef = useRef<string>(currentSessionId);

  // Window role: the main window is the sole scheduled-task executor. Child
  // windows (MD-document viewers) must never run tasks, show the catch-up
  // banner or persist sessions (avoids double execution + localStorage
  // clobber). Declared before the persist effect below.
  const [role, setRole] = useState<'main' | 'child' | 'unknown'>('unknown');
  const isExecutor = role === 'main';

  const commitSessions = useCallback((next: AgentSession[]) => {
    sessionsRef.current = next;
    setSessionsState(next);
  }, []);

  const selectSession = useCallback((id: string) => {
    currentSessionIdRef.current = id;
    setCurrentSessionIdState(id);
  }, []);

  const currentSession =
    sessions.find((s) => s.id === currentSessionId) || sessions[0];

  // persist sessions on every change (main window only — child windows must
  // not write the shared localStorage and clobber the main window's copy)
  useEffect(() => {
    if (!isExecutor) {
      return;
    }
    try {
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
    } catch (e) {
      console.log('agent sessions persist failed', e);
    }
  }, [sessions, isExecutor]);

  // keep at least one session
  useEffect(() => {
    if (sessions.length === 0) {
      const session = newSession();
      commitSessions([session]);
      selectSession(session.id);
    } else if (!sessions.some((s) => s.id === currentSessionId)) {
      selectSession(sessions[0].id);
    }
  }, [sessions, currentSessionId, commitSessions, selectSession]);

  const updateSession = useCallback(
    (sessionId: string, updater: (session: AgentSession) => AgentSession) => {
      commitSessions(
        sessionsRef.current.map((s) =>
          s.id === sessionId ? { ...updater(s), updatedAt: Date.now() } : s,
        ),
      );
    },
    [commitSessions],
  );

  // ---- run state ----------------------------------------------------------
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [queuedCount, setQueuedCount] = useState<number>(0);
  const [restoredInput, setRestoredInput] = useState<string | null>(null);
  const [runningTask, setRunningTask] = useState<AgentScheduledRunning | null>(
    null,
  );
  const abortRef = useRef<AbortController>(undefined);
  // Step-boundary injection: messages sent while a run is in flight are
  // queued here and drained by runAgent right before the next model
  // round-trip. `isRunningRef` mirrors `isRunning` synchronously.
  const pendingQueueRef = useRef<AgentInterruptQueue>(undefined);
  const isRunningRef = useRef<boolean>(false);
  // Monotonic id of the currently active run. The dying run's teardown only
  // cleans the shared refs when its own id is still current.
  const runIdRef = useRef<number>(0);
  // Location (uuid) the current run was started from, so the leftover resume
  // can refuse to auto-continue if the context changed meanwhile.
  const runLocationIdRef = useRef<string>('');
  // Session the active run belongs to (manual runs use the current session,
  // scheduled runs use the task's dedicated session).
  const runSessionIdRef = useRef<string>('');
  // Leftover queued instructions not drained before the run ended, folded
  // into ONE follow-up run by an effect once the latest session state is
  // committed.
  const resumeRef = useRef<{
    locationId: string;
    sessionId: string;
    texts: string[];
    locationOverride: boolean;
  } | null>(null);
  // Last error surfaced by a run, used by the scheduled executor to report a
  // useful failure detail.
  const lastRunErrorRef = useRef<string>('');

  // ---- scheduled tasks ----------------------------------------------------
  const [tasks, setTasksState] = useState<AgentScheduledTask[]>([]);
  const tasksRef = useRef<AgentScheduledTask[]>([]);
  const [missedTasks, setMissedTasks] = useState<AgentScheduledTask[]>([]);
  const missedDismissedRef = useRef<boolean>(false);
  const mountedRef = useRef<boolean>(true);
  const activeDueRef = useRef<Set<string>>(new Set());
  const dueChainRef = useRef<Promise<void>>(Promise.resolve());
  const executeDueRef = useRef<
    (taskId: string, force?: boolean) => Promise<void>
  >(async () => {});

  const buildTools = useCallback(
    (location: CommonLocation | undefined) => {
      const locationForPath = (path: string) =>
        findLocationByPath(path) || location || undefined;
      return createAgentTools({
        agentSearch,
        getIndex,
        findEntry,
        listChildren,
        listLocations: () =>
          locations.map((l) => ({ name: l.name, path: l.path })),
        ...makeKbToolDeps(findLocationByPath, findLocation),
        currentLocationId: location ? location.uuid : '',
        currentLocationName: location ? location.name : '',
        currentLocationPath: location ? location.path : '',
        currentDirectoryPath: currentDirectoryPath || '',
        selectedEntries,
        addTagsToFsEntry: (entry, tags) => addTagsToFsEntry(entry, tags),
        removeTagsFromEntry,
        moveFile: (sourcePath: string, targetFolderPath: string) => {
          const srcLoc = locationForPath(sourcePath);
          const tgtLoc = locationForPath(targetFolderPath);
          if (!srcLoc) {
            return Promise.reject(
              new Error('source path is not inside any connected location'),
            );
          }
          if (!tgtLoc) {
            return Promise.reject(
              new Error(
                'target path is not inside any connected location — create or connect the destination first',
              ),
            );
          }
          // Cloud gating mirrors MoveCopyFilesDialog: cross-location moves are
          // fine between local locations, but a cloud location may only move
          // inside itself.
          const srcIsCloud = !!srcLoc.haveObjectStoreSupport?.();
          const tgtIsCloud = !!tgtLoc.haveObjectStoreSupport?.();
          if ((srcIsCloud || tgtIsCloud) && srcLoc.uuid !== tgtLoc.uuid) {
            return Promise.reject(
              new Error(
                'cross-location move involving a cloud location is not supported',
              ),
            );
          }
          return moveFiles([sourcePath], targetFolderPath, tgtLoc.uuid);
        },
        copyFile: (sourcePath: string, targetFolderPath: string) => {
          const srcLoc = locationForPath(sourcePath);
          const tgtLoc = locationForPath(targetFolderPath);
          if (!srcLoc) {
            return Promise.reject(
              new Error('source path is not inside any connected location'),
            );
          }
          if (!tgtLoc) {
            return Promise.reject(
              new Error(
                'target path is not inside any connected location — create or connect the destination first',
              ),
            );
          }
          const srcIsCloud = !!srcLoc.haveObjectStoreSupport?.();
          const tgtIsCloud = !!tgtLoc.haveObjectStoreSupport?.();
          if ((srcIsCloud || tgtIsCloud) && srcLoc.uuid !== tgtLoc.uuid) {
            return Promise.reject(
              new Error(
                'cross-location copy involving a cloud location is not supported',
              ),
            );
          }
          return copyFiles([sourcePath], targetFolderPath, tgtLoc.uuid);
        },
        deleteEntries: async (items) => {
          const results: Array<{
            path: string;
            ok: boolean;
            error?: string;
          }> = [];
          for (const item of items) {
            const loc = locationForPath(item.path);
            if (!loc) {
              results.push({
                path: item.path,
                ok: false,
                error: 'path is not inside any connected location',
              });
              continue;
            }
            try {
              const ok = await (item.isFile
                ? loc.deleteFilePromise(item.path, true)
                : loc.deleteDirectoryPromise(item.path, true));
              results.push({ path: item.path, ok: ok !== false });
            } catch (e: any) {
              results.push({
                path: item.path,
                ok: false,
                error: e?.message || String(e),
              });
            }
          }
          return results;
        },
        // Unattended (scheduled-task) runs have nobody to answer a dialog:
        // deletion is only allowed in folders the user granted interactively
        // (isDeleteGranted bypasses this callback); everything else denies.
        requestDeleteConfirmation: () => Promise.resolve(false),
        moveToPath: (sourcePath: string, targetPath: string) => {
          const srcLoc = locationForPath(sourcePath);
          const tgtLoc = locationForPath(targetPath);
          if (!srcLoc) {
            return Promise.reject(
              new Error('source path is not inside any connected location'),
            );
          }
          if (!tgtLoc) {
            return Promise.reject(
              new Error(
                'target path is not inside any connected location — create or connect the destination first',
              ),
            );
          }
          const srcIsCloud = !!srcLoc.haveObjectStoreSupport?.();
          const tgtIsCloud = !!tgtLoc.haveObjectStoreSupport?.();
          if ((srcIsCloud || tgtIsCloud) && srcLoc.uuid !== tgtLoc.uuid) {
            return Promise.reject(
              new Error(
                'cross-location move involving a cloud location is not supported',
              ),
            );
          }
          return moveFilesPromise([[sourcePath, targetPath]], srcLoc.uuid).then(
            (results: any[]) => {
              const err = (results || []).find(
                (r) => r instanceof Error || (r && r.message),
              );
              if (err) {
                throw err instanceof Error ? err : new Error(String(err));
              }
              return true;
            },
          );
        },
        loadTextFile: (path: string) => {
          const loc = locationForPath(path);
          if (!loc) {
            return Promise.reject(
              new Error('path is not inside any connected location'),
            );
          }
          return loc.loadTextFilePromise(path);
        },
        readFileBytes: (path: string) => {
          const loc = locationForPath(path);
          if (!loc) {
            return Promise.reject(
              new Error('path is not inside any connected location'),
            );
          }
          return Promise.resolve(
            loc.getFileContentPromise(path, 'arraybuffer'),
          );
        },
        getDescription: (path: string) => {
          const loc = locationForPath(path);
          if (!loc) {
            return Promise.resolve('');
          }
          return Promise.resolve(
            loc
              .loadFileMetaDataPromise(path)
              .then((meta: TS.FileSystemEntryMeta) => meta?.description || '')
              .catch(() => ''),
          );
        },
        setDescription: (entry: TS.FileSystemEntry, description: string) =>
          setDescriptionChange(entry, description),
        writeTextFile: (path: string, content: string, overwrite: boolean) => {
          const loc = locationForPath(path);
          if (!loc) {
            return Promise.reject(
              new Error('path is not inside any connected location'),
            );
          }
          return Promise.resolve(
            loc.saveTextFilePromise({ path }, content, overwrite),
          ).then(() => undefined);
        },
        createLocation: (
          name: string,
          locationPath: string,
          options?: { isDefault?: boolean; isReadOnly?: boolean },
        ) => {
          if (locations.some((l) => l.path === locationPath)) {
            return Promise.reject(
              new Error('location already connected: ' + locationPath),
            );
          }
          addLocation(
            new CommonLocation({
              uuid: getUuid(),
              name,
              type: '0',
              path: locationPath,
              paths: [locationPath],
              isDefault: Boolean(options?.isDefault),
              isReadOnly: Boolean(options?.isReadOnly),
            }),
            false,
          );
          return Promise.resolve({ ok: true, name, path: locationPath });
        },
      });
    },
    [
      findLocation,
      findLocationByPath,
      locations,
      addLocation,
      listChildren,
      agentSearch,
      getIndex,
      currentDirectoryPath,
      selectedEntries,
      addTagsToFsEntry,
      removeTagsFromEntry,
      setDescriptionChange,
      moveFiles,
      copyFiles,
      moveFilesPromise,
    ],
  );

  const stopRun = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = undefined;
    }
    // Dropping queued instructions on stop matches "interrupt" semantics —
    // the user asked the agent to halt, not to feed it more work.
    if (pendingQueueRef.current) {
      pendingQueueRef.current.pending = [];
    }
    // Invalidate the dying run: its teardown would otherwise clear the shared
    // refs even if a new run was already started during the (slow) teardown.
    runIdRef.current += 1;
    isRunningRef.current = false;
    setQueuedCount(0);
    // Interrupt semantics: nothing may auto-resume after Stop.
    resumeRef.current = null;
    runSessionIdRef.current = '';
    setRunningTask(null);
    setIsRunning(false);
  }, []);

  const enqueueInterrupt = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !isRunningRef.current || !pendingQueueRef.current) {
        return;
      }
      pendingQueueRef.current.pending.push(trimmed);
      setQueuedCount(pendingQueueRef.current.pending.length);
      const targetSessionId = runSessionIdRef.current;
      if (targetSessionId) {
        updateSession(targetSessionId, (s) => ({
          ...s,
          title: s.title || shortText(trimmed, 30),
          messages: [
            ...s.messages,
            { role: 'user', content: trimmed } as AgentChatMessage,
          ],
        }));
      }
    },
    [updateSession],
  );

  const startRun = useCallback(
    async (opts: AgentStartRunOptions): Promise<AgentStartRunResult> => {
      const text = (opts.text || '').trim();
      if (!text) {
        return 'aborted';
      }
      const session = sessionsRef.current.find((s) => s.id === opts.sessionId);
      if (!session) {
        return 'failed';
      }
      if (!defaultAiProvider || !defaultAiProvider.url) {
        lastRunErrorRef.current = t('core:aiNoProviderConfigured');
        showNotification(t('core:aiNoProviderConfigured'), 'warning');
        return 'failed';
      }
      const model = currentModel?.name || defaultAiProvider.defaultTextModel;
      if (!model) {
        lastRunErrorRef.current = 'no model selected';
        return 'failed';
      }
      const sessionId = session.id;

      // A run is already in flight: queue this message for step-boundary
      // injection instead of starting a parallel run. Scheduled executions
      // never take this branch (the executor waits for the agent to be idle).
      if (isRunningRef.current && pendingQueueRef.current) {
        // Defense-in-depth: only inject into the running run's OWN session.
        // If the caller targets a different session (e.g. the UI still shows a
        // stale currentSession for one render cycle after a scheduled run
        // started), injecting would drop the instruction into the wrong
        // conversation while the bubble lands in the caller's — the exact
        // cross-session injection class d6a7b389b fixed. Refuse + warn; the
        // UI routes the user to the running task's live detail instead.
        if (sessionId !== runSessionIdRef.current) {
          showNotification(
            t('core:aiAgentScheduledAnotherTaskRunning'),
            'warning',
          );
          return 'failed';
        }
        pendingQueueRef.current.pending.push(text);
        setQueuedCount(pendingQueueRef.current.pending.length);
        updateSession(sessionId, (s) => ({
          ...s,
          title: s.title || shortText(text, 30),
          messages: [
            ...s.messages,
            { role: 'user', content: text } as AgentChatMessage,
          ],
        }));
        return 'success';
      }

      const overrideLocationId = opts.locationId;
      const location = overrideLocationId
        ? findLocation(overrideLocationId)
        : findLocation();
      if (overrideLocationId && !location) {
        lastRunErrorRef.current = 'location missing';
        return 'failed';
      }
      const currentLocationUuid = findLocation()?.uuid ?? '';
      const sameAsCurrent =
        !overrideLocationId || overrideLocationId === currentLocationUuid;
      // A scheduled run may execute while the user is looking at another
      // location. In that case do not leak the UI's folder/selection into
      // the task context — tools fall back to absolute paths.
      const runDirectoryPath = sameAsCurrent ? currentDirectoryPath || '' : '';
      const runSelectedEntries = sameAsCurrent ? selectedEntries : [];

      const userMessage: AgentChatMessage = { role: 'user', content: text };
      const assistantMessage: AgentChatMessage = {
        role: 'assistant',
        content: '',
        steps: [],
      };
      updateSession(sessionId, (s) => ({
        ...s,
        title: s.title || shortText(text, 30),
        // The resume path (leftover fold) skips the user bubble — it was
        // already shown when the instruction was queued mid-run.
        messages: opts.skipUserBubble
          ? [...s.messages, assistantMessage]
          : [...s.messages, userMessage, assistantMessage],
      }));
      lastRunErrorRef.current = '';
      setIsRunning(true);
      isRunningRef.current = true;
      const myRunId = ++runIdRef.current;
      runLocationIdRef.current = location?.uuid ?? '';
      runSessionIdRef.current = sessionId;
      // Fresh injection channel for this run; drained by runAgent at each
      // step boundary. Leftover messages fold into a follow-up run below.
      const queue: AgentInterruptQueue = { pending: [], injections: 0 };
      pendingQueueRef.current = queue;
      const abortController = new AbortController();
      abortRef.current = abortController;

      // Skills are instruction blocks with no call event of their own, so each
      // enabled one counts as "used" by this run. Local-only counters.
      getEnabledCustomSkills().forEach((s) => incrementSkillUseCount(s.id));

      const patchAssistant = (
        patch: (msg: Extract<AgentChatMessage, { role: 'assistant' }>) => void,
      ) => {
        updateSession(sessionId, (s) => {
          const messages = [...s.messages];
          for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (messages[i].role === 'assistant') {
              const copy: Extract<AgentChatMessage, { role: 'assistant' }> = {
                ...(messages[i] as Extract<
                  AgentChatMessage,
                  { role: 'assistant' }
                >),
              };
              patch(copy);
              messages[i] = copy;
              break;
            }
          }
          return { ...s, messages };
        });
      };

      let outcome: AgentStartRunResult = 'success';
      let runError = '';
      try {
        const result = await runAgent({
          url: defaultAiProvider.url,
          authKey: defaultAiProvider.authKey,
          model,
          messages: [
            {
              role: 'system',
              content: buildAgentSystemPrompt({
                locationName: location?.name || '',
                currentDirectoryPath: runDirectoryPath,
                selectedEntries: runSelectedEntries,
                language: interfaceLanguage || 'en',
                conventions: await loadLocationConventions(location),
                customSkills: getEnabledCustomSkills().map((s) => ({
                  name: s.name,
                  instruction: s.instruction,
                })),
                diskInitState: readDiskInitState() ?? undefined,
              }),
            },
            ...session.apiMessages,
            // The user's message MUST be part of the API conversation — it is
            // only appended to session.apiMessages via the run result below.
            { role: 'user', content: text },
          ],
          tools: buildTools(location),
          signal: abortController.signal,
          interruptQueue: queue,
          onEvent: (event: AgentEvent) => {
            if (event.type === 'text') {
              patchAssistant((msg) => {
                msg.content += event.delta;
              });
            } else if (event.type === 'tool_call') {
              incrementToolCallCount(event.name);
              patchAssistant((msg) => {
                msg.steps.push({
                  id: 'step-' + Date.now() + '-' + msg.steps.length,
                  name: event.name,
                  args: event.args,
                });
              });
            } else if (event.type === 'tool_result') {
              patchAssistant((msg) => {
                const last = msg.steps[msg.steps.length - 1];
                if (last) {
                  last.result = event.result;
                  try {
                    last.isError = !!JSON.parse(event.result)?.error;
                  } catch (e) {
                    last.isError = false;
                  }
                }
              });
            } else if (event.type === 'error') {
              runError = event.message;
              patchAssistant((msg) => {
                msg.content +=
                  (msg.content ? '\n\n' : '') + '> ⚠️ ' + event.message;
              });
            } else if (event.type === 'interrupt_drained') {
              setQueuedCount(0);
            }
          },
        });
        updateSession(sessionId, (s) => ({
          ...s,
          apiMessages: result.messages,
        }));
        if (result.aborted) {
          outcome = 'aborted';
        } else if (runError) {
          outcome = 'failed';
        }
      } catch (e: any) {
        outcome = 'failed';
        runError = e?.message || String(e);
        patchAssistant((msg) => {
          msg.content +=
            (msg.content ? '\n\n' : '') + '> ⚠️ ' + (e?.message || String(e));
        });
      } finally {
        // Only the run that is still "current" may touch the shared refs. If
        // the user hit Stop and started another run while this one was still
        // tearing down (tool IPC calls don't abort promptly), the old run
        // must not clear the new run's controller / injection queue.
        if (runIdRef.current !== myRunId) {
          outcome = 'aborted';
        } else {
          abortRef.current = undefined;
          isRunningRef.current = false;
          pendingQueueRef.current = undefined;
          setQueuedCount(0);
          setIsRunning(false);
          lastRunErrorRef.current = runError;
          // Messages still queued when the run ended (typed right as it
          // finished, before the next step boundary) fold into ONE follow-up
          // run. The resume is deferred to an effect so it runs with the
          // latest committed session state (incl. this run's apiMessages) and
          // skips the user bubble that was already shown at queue time.
          const leftover = queue.pending.splice(0);
          if (leftover.length > 0) {
            resumeRef.current = {
              locationId: runLocationIdRef.current,
              sessionId,
              texts: leftover,
              locationOverride: !!overrideLocationId,
            };
          }
        }
      }
      return outcome;
    },
    [
      defaultAiProvider,
      currentModel,
      findLocation,
      currentDirectoryPath,
      selectedEntries,
      interfaceLanguage,
      buildTools,
      updateSession,
      showNotification,
      t,
    ],
  );

  // Called by the agent panel when a location switch made the auto-resume
  // unsafe: the queued text is handed back to the input box.
  useEffect(() => {
    if (isRunning || !resumeRef.current) {
      return;
    }
    const { locationId, sessionId, texts, locationOverride } =
      resumeRef.current;
    resumeRef.current = null;
    const canResume = locationOverride
      ? !!findLocation(locationId)
      : (findLocation()?.uuid ?? '') === locationId;
    if (canResume) {
      // Same context: auto-resume in the run's session (existing behavior),
      // reusing the already shown user bubble.
      void startRun({
        sessionId,
        text: texts.join('\n\n'),
        skipUserBubble: true,
        ...(locationOverride ? { locationId } : {}),
      });
    } else {
      // Context changed since the task started: do NOT auto-resume — it
      // would execute the old task with the new location's context. Move the
      // instruction back to the input box and let the user review it.
      setRestoredInput(texts.join('\n\n'));
      showNotification(t('core:aiAgentResumeContextChanged'), 'warning');
    }
  }, [isRunning, startRun, findLocation, showNotification, t]);

  const consumeRestoredInput = useCallback(() => {
    setRestoredInput(null);
  }, []);

  const newAgentSession = useCallback(() => {
    // Session operations are locked while a run is in flight: switching the
    // "current session" mid-run would misroute queued instructions and the
    // leftover resume to the wrong session.
    if (isRunningRef.current) {
      return;
    }
    const session = newSession();
    commitSessions([session, ...sessionsRef.current]);
    selectSession(session.id);
  }, [commitSessions, selectSession]);

  const deleteCurrentAgentSession = useCallback(() => {
    if (isRunningRef.current) {
      return;
    }
    const id = currentSessionIdRef.current;
    const rest = sessionsRef.current.filter((s) => s.id !== id);
    commitSessions(rest.length > 0 ? rest : [newSession()]);
  }, [commitSessions]);

  const setCurrentSessionId = useCallback(
    (id: string) => {
      if (isRunningRef.current) {
        return;
      }
      selectSession(id);
    },
    [selectSession],
  );

  // ---- scheduled tasks: loading + executor --------------------------------
  const loadTasksFromIpc = useCallback(async (): Promise<
    AgentScheduledTask[]
  > => {
    if (!isElectron()) {
      return [];
    }
    try {
      const list =
        await window.electronIO.ipcRenderer.invoke('scheduledTask:list');
      return Array.isArray(list) ? (list as AgentScheduledTask[]) : [];
    } catch (e) {
      console.error('loading scheduled tasks failed', e);
      return [];
    }
  }, []);

  const refreshTasks = useCallback(async () => {
    if (!isExecutor) {
      return; // only the main (executor) window loads tasks / missed banner
    }
    const list = await loadTasksFromIpc();
    tasksRef.current = list;
    setTasksState(list);
    if (!missedDismissedRef.current) {
      setMissedTasks(findOverdue(list, Date.now()));
    }
  }, [loadTasksFromIpc, isExecutor]);

  const reportResult = useCallback(
    async (
      taskId: string,
      result: {
        status: 'success' | 'failed' | 'skipped' | 'missed';
        detail?: string;
        ranAt: number;
      },
    ) => {
      if (!isElectron()) {
        return;
      }
      try {
        await window.electronIO.ipcRenderer.invoke(
          'scheduledTask:reportResult',
          taskId,
          result,
        );
      } catch (e) {
        console.error('reporting scheduled task result failed', e);
      }
    },
    [],
  );

  const executeDueTask = useCallback(
    async (taskId: string, force = false) => {
      if (!isElectron()) {
        return;
      }
      await refreshTasks();
      let task = tasksRef.current.find((t) => t.id === taskId);
      // `force` comes from an explicit "run now" click, which overrides the
      // paused state — a manual request should always run, never no-op.
      if (!task || (!task.enabled && !force)) {
        return;
      }
      const ranAt = Date.now();

      // Context snapshot principle: a task belongs to the location it was
      // created in. A deleted location means the run is skipped, never
      // executed against whatever the UI happens to show.
      if (!findLocation(task.locationId)) {
        await reportResult(taskId, {
          status: 'skipped',
          detail: 'location missing',
          ranAt,
        });
        await refreshTasks();
        return;
      }
      if (!defaultAiProvider || !defaultAiProvider.url) {
        await reportResult(taskId, {
          status: 'failed',
          detail: t('core:aiNoProviderConfigured'),
          ranAt,
        });
        await refreshTasks();
        return;
      }

      // Global single-run constraint: never queue a scheduled instruction
      // into an in-flight run (cross-session injection). Wait for the agent
      // to become idle instead.
      const waitForIdle = async (): Promise<boolean> => {
        let retries = 0;
        while (isRunningRef.current && retries < SCHEDULED_TASK_MAX_RETRIES) {
          retries += 1;
          await sleep(nextRetryDelay(retries));
          if (!mountedRef.current) {
            return false;
          }
        }
        return !isRunningRef.current;
      };
      if (!(await waitForIdle())) {
        await reportResult(taskId, {
          status: 'skipped',
          detail: 'agent busy',
          ranAt,
        });
        await refreshTasks();
        return;
      }

      // The task may have been deleted or re-bound while waiting for the
      // agent to become idle — always run the latest definition. A disable
      // during the wait only aborts non-forced (auto) runs.
      await refreshTasks();
      const latest = tasksRef.current.find((t) => t.id === taskId);
      if (!latest || (!latest.enabled && !force)) {
        return;
      }
      task = latest;
      if (!findLocation(task.locationId)) {
        await reportResult(taskId, {
          status: 'skipped',
          detail: 'location missing',
          ranAt,
        });
        await refreshTasks();
        return;
      }

      // Dedicated session per task: create on first execution and write the
      // id back so later runs and the UI share the same transcript.
      let session = task.sessionId
        ? sessionsRef.current.find((s) => s.id === task.sessionId)
        : undefined;
      if (!session) {
        session = newSession();
        session.title = `⏰ ${task.name}`;
        commitSessions([session, ...sessionsRef.current]);
        try {
          await window.electronIO.ipcRenderer.invoke(
            'scheduledTask:update',
            taskId,
            { sessionId: session.id },
          );
        } catch (e) {
          console.error('persisting scheduled task session failed', e);
        }
      }
      const sessionId = session.id;

      // Persisting the session id above is an await; a manual run may have
      // started meanwhile. Wait again so the task prompt is never queued into
      // somebody else's run.
      if (!(await waitForIdle())) {
        await reportResult(taskId, {
          status: 'skipped',
          detail: 'agent busy',
          ranAt,
        });
        await refreshTasks();
        return;
      }

      setRunningTask({ taskId, sessionId });
      let status: AgentStartRunResult = 'failed';
      try {
        status = await startRun({
          sessionId,
          text: task.prompt,
          locationId: task.locationId,
        });
      } catch (e: any) {
        lastRunErrorRef.current = e?.message || String(e);
        status = 'failed';
      } finally {
        setRunningTask((prev) =>
          prev && prev.taskId === taskId ? null : prev,
        );
      }

      const detail =
        status === 'failed'
          ? shortText(
              lastRunErrorRef.current || t('core:aiAgentRunFailed'),
              MAX_FAILED_DETAIL,
            )
          : status === 'aborted'
            ? t('core:aiAgentScheduledStoppedByUser')
            : undefined;
      await reportResult(taskId, {
        status: status === 'aborted' ? 'skipped' : status,
        detail,
        ranAt,
      });
      await refreshTasks();
    },
    [
      refreshTasks,
      reportResult,
      findLocation,
      defaultAiProvider,
      commitSessions,
      startRun,
      t,
    ],
  );
  executeDueRef.current = executeDueTask;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Query this window's role (main vs child) from the main process. Until it
  // resolves the scheduled-task machinery stays off; on IPC failure default to
  // 'child' (never execute) — better to pause than to double-execute.
  useEffect(() => {
    if (!isElectron()) {
      setRole('main'); // web build — single renderer, treat as the only window
      return;
    }
    let cancelled = false;
    window.electronIO.ipcRenderer
      .invoke('scheduledTask:getRole')
      .then((r) => {
        // Only 'main' activates; 'child' AND 'unknown' stay dormant (never
        // execute, never persist) — conservative per the plan.
        if (!cancelled) setRole(r === 'main' ? 'main' : 'child');
      })
      .catch(() => {
        if (!cancelled) setRole('child');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Initial load (also fills the missed-run banner data source).
  useEffect(() => {
    void refreshTasks();
  }, [refreshTasks]);

  // Conversation runs may create/update/delete tasks through the agent tools;
  // refresh the list whenever a run finishes so the scheduled view is current.
  useEffect(() => {
    if (!isRunning) {
      void refreshTasks();
    }
  }, [isRunning, refreshTasks]);

  // Main process broadcasts due tasks from its 30s tick. Only the main
  // (executor) window subscribes — child windows must never execute. Deliveries
  // are serialized: one task at a time, in broadcast order.
  useEffect(() => {
    if (!isElectron() || !isExecutor) {
      return undefined;
    }
    const unsubscribe = window.electronIO.ipcRenderer.on(
      'scheduledTaskDue',
      (...args: unknown[]) => {
        const payload = args[0] as
          | { taskId?: string; force?: boolean }
          | undefined;
        const taskId = payload?.taskId;
        if (!taskId || activeDueRef.current.has(taskId)) {
          return;
        }
        activeDueRef.current.add(taskId);
        dueChainRef.current = dueChainRef.current
          .then(() => executeDueRef.current(taskId, Boolean(payload?.force)))
          .catch((e) => {
            console.error('scheduled task execution failed', e);
          })
          .finally(() => {
            activeDueRef.current.delete(taskId);
          });
      },
    );
    return unsubscribe;
  }, [isExecutor]);

  const runNow = useCallback(
    async (taskId: string) => {
      if (!isElectron()) {
        return;
      }
      try {
        await window.electronIO.ipcRenderer.invoke(
          'scheduledTask:runNow',
          taskId,
        );
      } catch (e) {
        console.error('starting scheduled task failed', e);
        showNotification(t('core:aiAgentRunFailed'), 'error');
      }
    },
    [showNotification, t],
  );

  const deleteTask = useCallback(
    async (taskId: string) => {
      if (!isElectron()) {
        return;
      }
      try {
        await window.electronIO.ipcRenderer.invoke(
          'scheduledTask:delete',
          taskId,
        );
      } catch (e) {
        console.error('deleting scheduled task failed', e);
      }
      await refreshTasks();
    },
    [refreshTasks],
  );

  const toggleTaskEnabled = useCallback(
    async (taskId: string, enabled: boolean) => {
      if (!isElectron()) {
        return;
      }
      try {
        await window.electronIO.ipcRenderer.invoke(
          'scheduledTask:update',
          taskId,
          { enabled },
        );
      } catch (e) {
        console.error('updating scheduled task failed', e);
      }
      await refreshTasks();
    },
    [refreshTasks],
  );

  const dismissMissed = useCallback(async () => {
    missedDismissedRef.current = true;
    const ranAt = Date.now();
    // Mark each missed occurrence as handled so "忽略本次" really means skip
    // THIS one: reportResult advances nextRunAt to the next future fire, so
    // the task neither lingers as overdue nor reappears in the banner after
    // the next launch.
    for (const task of missedTasks) {
      if (!isElectron()) {
        continue;
      }
      try {
        await window.electronIO.ipcRenderer.invoke(
          'scheduledTask:reportResult',
          task.id,
          { status: 'missed', ranAt },
        );
      } catch (e) {
        console.error('dismissing missed scheduled task failed', e);
      }
    }
    setMissedTasks([]);
    await refreshTasks();
  }, [missedTasks, refreshTasks]);

  const value: AgentSessionsContextData = useMemo(
    () => ({
      sessions,
      currentSessionId,
      currentSession,
      setCurrentSessionId,
      updateSession,
      isRunning,
      queuedCount,
      runningTask,
      isExecutor,
      restoredInput,
      consumeRestoredInput,
      startRun,
      stopRun,
      enqueueInterrupt,
      newAgentSession,
      deleteCurrentAgentSession,
      tasks,
      refreshTasks,
      runNow,
      deleteTask,
      toggleTaskEnabled,
      missedTasks,
      dismissMissed,
    }),
    [
      sessions,
      currentSessionId,
      currentSession,
      setCurrentSessionId,
      updateSession,
      isRunning,
      queuedCount,
      runningTask,
      isExecutor,
      restoredInput,
      consumeRestoredInput,
      startRun,
      stopRun,
      enqueueInterrupt,
      newAgentSession,
      deleteCurrentAgentSession,
      tasks,
      refreshTasks,
      runNow,
      deleteTask,
      toggleTaskEnabled,
      missedTasks,
      dismissMissed,
    ],
  );

  return (
    <AgentSessionsContext.Provider value={value}>
      {props.children}
    </AgentSessionsContext.Provider>
  );
}

export const useAgentSessionsContext = () => useContext(AgentSessionsContext);

export default AgentSessionsContextProvider;
