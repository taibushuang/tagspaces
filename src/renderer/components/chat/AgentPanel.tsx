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
 * Standalone AI Agent panel: session list (persisted to localStorage), chat
 * bubbles, collapsible tool-call cards, streaming output with a stop button.
 * Talks to the same OpenAI-compatible endpoints and provider settings as the
 * chat tab, but keeps its own transcript independent of any opened folder.
 */
import {
  AddIcon,
  ArrowDropUpIcon,
  DeleteIcon,
  EditIcon,
  HTMLFileIcon,
  MarkdownFileIcon,
  MoreMenuIcon,
  SendIcon,
  StopIcon,
} from '-/components/CommonIcons';
import { AgentEvent, runAgent } from '-/components/chat/AgentService';
import {
  createAgentTools,
  readDiskInitState,
} from '-/components/chat/AgentTools';
import { buildAgentSystemPrompt } from '-/components/chat/agentPrompt';
import { inboxLastOrganizedMs, newEntriesSince } from '-/utils/inboxOrganize';
import { makeKbToolDeps } from '-/services/knowledgeBase';
import {
  getEnabledCustomSkills,
  incrementSkillUseCount,
  incrementToolCallCount,
} from '-/components/chat/agentCapabilities';
import TsIconButton from '-/components/TsIconButton';
import { useCurrentLocationContext } from '-/hooks/useCurrentLocationContext';
import { useDirectoryContentContext } from '-/hooks/useDirectoryContentContext';
import { useLocationIndexContext } from '-/hooks/useLocationIndexContext';
import { useSelectedEntriesContext } from '-/hooks/useSelectedEntriesContext';
import { useTaggingActionsContext } from '-/hooks/useTaggingActionsContext';
import { useIOActionsContext } from '-/hooks/useIOActionsContext';
import { usePlatformFacadeContext } from '-/hooks/usePlatformFacadeContext';
import { loadLocationConventions } from '-/components/chat/locationConventions';
import { useChatContext } from '-/hooks/useChatContext';
import { useNotificationContext } from '-/hooks/useNotificationContext';
import { getDefaultAIProvider, getCurrentLanguage } from '-/reducers/settings';
import { CommonLocation } from '-/utils/CommonLocation';
import { getUuid } from '@tagspaces/tagspaces-common/utils-io';
import { TS } from '-/tagspaces.namespace';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import { useTheme } from '@mui/material/styles';
import { format } from 'date-fns';
import {
  convertMarkDownToHtml,
  getMimeType,
  saveAsTextFile,
} from '-/services/utils-io';
import { formatDateTime4Tag } from '@tagspaces/tagspaces-common/misc';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSelector } from 'react-redux';

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

const SESSIONS_KEY = 'tsAiAgentSessions';

function loadSessions(): AgentSession[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function newSession(): AgentSession {
  const now = Date.now();
  return {
    id: 'agent-' + now,
    title: '',
    updatedAt: now,
    messages: [],
    apiMessages: [],
  };
}

function sessionTitle(session: AgentSession): string {
  if (session.title) {
    return session.title;
  }
  const firstUser = session.messages.find((m) => m.role === 'user');
  if (firstUser && firstUser.content) {
    return firstUser.content.slice(0, 30);
  }
  return format(session.updatedAt, 'MM-dd HH:mm');
}

function shortText(text: string, limit = 120): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > limit ? oneLine.slice(0, limit) + '…' : oneLine;
}

function prettyArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args || '{}'), null, 2);
  } catch (e) {
    return args || '{}';
  }
}

function transcriptToMarkdown(
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

function AgentPanel() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { showNotification } = useNotificationContext();
  const { currentModel, models, setModel, changeCurrentModel } =
    useChatContext();
  const defaultAiProvider = useSelector(getDefaultAIProvider);
  const interfaceLanguage = useSelector(getCurrentLanguage);
  const { findLocation, findLocationByPath, locations, addLocation } =
    useCurrentLocationContext();
  const { agentSearch, getIndex, findEntry, listChildren } =
    useLocationIndexContext();
  const { currentDirectoryPath } = useDirectoryContentContext();
  const { selectedEntries } = useSelectedEntriesContext();
  const { addTagsToFsEntry, removeTagsFromEntry } = useTaggingActionsContext();
  const { setDescriptionChange, moveFiles, copyFiles, saveTextFilePromise } =
    useIOActionsContext();
  const { moveFilesPromise } = usePlatformFacadeContext();

  const [sessions, setSessions] = useState<AgentSession[]>(loadSessions);
  const [currentSessionId, setCurrentSessionId] = useState<string>(
    () => sessions[0]?.id || '',
  );
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [input, setInput] = useState<string>('');
  const [diskInitDone, setDiskInitDone] = useState<boolean>(() =>
    Boolean(readDiskInitState()?.done),
  );
  const [pendingInboxes, setPendingInboxes] = useState<
    Array<{ path: string; mode: string; count: number }>
  >([]);
  const [modelMenuAnchor, setModelMenuAnchor] = useState<null | HTMLElement>(
    null,
  );
  const [exportMenuAnchor, setExportMenuAnchor] = useState<null | HTMLElement>(
    null,
  );
  const [sessionMenuAnchor, setSessionMenuAnchor] =
    useState<null | HTMLElement>(null);
  const [renamingOpen, setRenamingOpen] = useState<boolean>(false);
  const [renameValue, setRenameValue] = useState<string>('');
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const abortRef = useRef<AbortController>(undefined);
  const listRef = useRef<HTMLDivElement>(null);

  const currentSession =
    sessions.find((s) => s.id === currentSessionId) || sessions[0];

  // persist sessions on every change
  useEffect(() => {
    try {
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
    } catch (e) {
      console.log('agent sessions persist failed', e);
    }
  }, [sessions]);

  // keep at least one session
  useEffect(() => {
    if (sessions.length === 0) {
      const session = newSession();
      setSessions([session]);
      setCurrentSessionId(session.id);
    } else if (!sessions.some((s) => s.id === currentSessionId)) {
      setCurrentSessionId(sessions[0].id);
    }
  }, [sessions, currentSessionId]);

  // refresh the disk-init marker whenever an agent run finishes so the
  // intro card and its CTA chip disappear once the skill has run
  useEffect(() => {
    if (!isRunning) {
      setDiskInitDone(Boolean(readDiskInitState()?.done));
    }
  }, [isRunning]);

  // refresh the "inbox has new files to file away" reminder: count, per
  // registered inbox, the files newer than its last mark_inbox_organized
  useEffect(() => {
    let cancelled = false;
    if (!diskInitDone) {
      setPendingInboxes([]);
      return () => {
        cancelled = true;
      };
    }
    const inboxes = readDiskInitState()?.inboxes || [];
    (async () => {
      const result: Array<{ path: string; mode: string; count: number }> = [];
      for (const ib of inboxes) {
        try {
          const entries = await listChildren(ib.path);
          const fresh = newEntriesSince(entries, inboxLastOrganizedMs(ib.path));
          result.push({ path: ib.path, mode: ib.mode, count: fresh.length });
        } catch (e) {
          // unreadable inbox (not connected) — skip the reminder for it
        }
      }
      if (!cancelled) setPendingInboxes(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [diskInitDone, isRunning, listChildren]);

  // auto-scroll to the newest content (also while streaming)
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  });

  const updateSession = useCallback(
    (sessionId: string, updater: (session: AgentSession) => AgentSession) => {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId ? { ...updater(s), updatedAt: Date.now() } : s,
        ),
      );
    },
    [],
  );

  const buildTools = useCallback(() => {
    const location = findLocation();
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
        // Pass the TARGET location id — same as the move dialog (handleMove).
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
        // Same cloud constraint as MoveCopyFilesDialog.
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
        return Promise.resolve(loc.getFileContentPromise(path, 'arraybuffer'));
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
  }, [
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
  ]);

  const handleStop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = undefined;
    }
    setIsRunning(false);
  }, []);

  const handleSend = useCallback(
    async (overrideText?: string) => {
      const text = (overrideText ?? input).trim();
      if (!text || isRunning) {
        return;
      }
      if (!defaultAiProvider || !defaultAiProvider.url) {
        showNotification(t('core:aiNoProviderConfigured'), 'warning');
        return;
      }
      const model = currentModel?.name || defaultAiProvider.defaultTextModel;
      if (!model) {
        return;
      }
      const session = currentSession;
      if (!session) {
        return;
      }
      const sessionId = session.id;
      const userMessage: AgentChatMessage = { role: 'user', content: text };
      const assistantMessage: AgentChatMessage = {
        role: 'assistant',
        content: '',
        steps: [],
      };
      updateSession(sessionId, (s) => ({
        ...s,
        title: s.title || shortText(text, 30),
        messages: [...s.messages, userMessage, assistantMessage],
      }));
      setPromptHistory((prev) => [text, ...prev].slice(0, 10));
      setHistoryIndex(-1);
      setInput('');
      setIsRunning(true);
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

      try {
        const result = await runAgent({
          url: defaultAiProvider.url,
          authKey: defaultAiProvider.authKey,
          model,
          messages: [
            {
              role: 'system',
              content: buildAgentSystemPrompt({
                locationName: findLocation()?.name || '',
                currentDirectoryPath: currentDirectoryPath || '',
                selectedEntries,
                language: interfaceLanguage || 'en',
                conventions: await loadLocationConventions(findLocation()),
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
          tools: buildTools(),
          signal: abortController.signal,
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
              patchAssistant((msg) => {
                msg.content +=
                  (msg.content ? '\n\n' : '') + '> ⚠️ ' + event.message;
              });
            }
          },
        });
        updateSession(sessionId, (s) => ({
          ...s,
          apiMessages: result.messages,
        }));
      } catch (e) {
        patchAssistant((msg) => {
          msg.content +=
            (msg.content ? '\n\n' : '') + '> ⚠️ ' + (e?.message || String(e));
        });
      } finally {
        abortRef.current = undefined;
        setIsRunning(false);
      }
    },
    [
      input,
      isRunning,
      defaultAiProvider,
      currentModel,
      currentSession,
      findLocation,
      currentDirectoryPath,
      selectedEntries,
      interfaceLanguage,
      buildTools,
      updateSession,
    ],
  );

  const handleStartDiskInit = useCallback(() => {
    handleSend(t('core:aiAgentIntroInitMessage'));
  }, [handleSend]);

  const handleOrganizeInbox = useCallback(() => {
    const fresh = pendingInboxes.filter((p) => p.count > 0).slice(0, 5);
    const more =
      pendingInboxes.filter((p) => p.count > 0).length > 5 ? '\n…' : '';
    const list = fresh.map((p) => `${p.path} (${p.count})`).join('\n');
    handleSend(`${t('core:aiInboxOrganizeMessage')}\n${list}${more}`);
  }, [pendingInboxes, handleSend]);

  const handleChangeModel = useCallback(
    (newModelName: string) => {
      changeCurrentModel(newModelName)
        .then((success) => {
          if (success) {
            setModel(newModelName);
          }
        })
        .catch((err) => {
          showNotification(
            t('core:installCustomModel') + err.message + ': ' + newModelName,
            'error',
            false,
          );
        });
    },
    [changeCurrentModel, setModel, showNotification, t],
  );

  const saveAsMarkdown = useCallback(() => {
    setExportMenuAnchor(null);
    if (!currentSession || currentSession.messages.length === 0) {
      return;
    }
    const blob = new Blob([transcriptToMarkdown(currentSession, t)], {
      type: getMimeType('md'),
    });
    saveAsTextFile(
      blob,
      `tagspaces-agent [export ${formatDateTime4Tag(new Date(), true)}].md`,
    );
  }, [currentSession, t]);

  const saveAsHtml = useCallback(() => {
    setExportMenuAnchor(null);
    if (!currentSession || currentSession.messages.length === 0) {
      return;
    }
    const blob = new Blob(
      [convertMarkDownToHtml(transcriptToMarkdown(currentSession, t))],
      { type: getMimeType('html') },
    );
    saveAsTextFile(
      blob,
      `tagspaces-agent [export ${formatDateTime4Tag(new Date(), true)}].html`,
    );
  }, [currentSession, t]);

  const handleNewSession = useCallback(() => {
    const session = newSession();
    setSessions((prev) => [session, ...prev]);
    setCurrentSessionId(session.id);
  }, []);

  const handleDeleteSession = useCallback(() => {
    if (!currentSession) {
      return;
    }
    const rest = sessions.filter((s) => s.id !== currentSession.id);
    setSessions(rest.length > 0 ? rest : [newSession()]);
  }, [currentSession, sessions]);

  const taskGoalLabel =
    currentSession && currentSession.messages.length > 0
      ? sessionTitle(currentSession)
      : t('core:aiAgentNewTaskGoal');

  const handleStartRename = useCallback(() => {
    setSessionMenuAnchor(null);
    setRenameValue(
      currentSession && currentSession.messages.length > 0
        ? sessionTitle(currentSession)
        : '',
    );
    setRenamingOpen(true);
  }, [currentSession]);

  const handleRenameCommit = useCallback(() => {
    const value = renameValue.trim();
    setRenamingOpen(false);
    if (!value || !currentSession) {
      return;
    }
    updateSession(currentSession.id, (s) => ({ ...s, title: value }));
  }, [renameValue, currentSession, updateSession]);

  const renderMessage = (message: AgentChatMessage, index: number) => {
    if (message.role === 'user') {
      return (
        <Box
          key={'msg-' + index}
          sx={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 1 }}
        >
          <Box
            sx={{
              maxWidth: '85%',
              padding: 1,
              borderRadius: 2,
              bgcolor: 'primary.main',
              color: 'primary.contrastText',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {message.content}
          </Box>
        </Box>
      );
    }
    return (
      <Box key={'msg-' + index} sx={{ marginBottom: 1.5 }}>
        {message.steps.map((step) => (
          <Accordion
            key={step.id}
            defaultExpanded={false}
            sx={{
              marginBottom: 0.5,
              ...(step.isError && {
                border: '1px solid ' + theme.palette.error.main,
              }),
            }}
          >
            <AccordionSummary expandIcon={<ExpandMoreIcon fontSize="small" />}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                {isRunning && !step.result ? (
                  <CircularProgress size={14} />
                ) : (
                  <span>{step.isError ? '⚠️' : '🔧'}</span>
                )}
                <Box sx={{ fontWeight: 500 }}>{step.name}</Box>
                <Box sx={{ color: 'text.secondary', fontSize: '0.8rem' }}>
                  {shortText(step.args)}
                </Box>
              </Box>
            </AccordionSummary>
            <AccordionDetails sx={{ paddingTop: 0 }}>
              <Box
                sx={{
                  fontSize: '0.8rem',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  color: 'text.secondary',
                  marginBottom: 1,
                }}
              >
                {prettyArgs(step.args)}
              </Box>
              {step.result && (
                <Box
                  sx={{
                    fontSize: '0.8rem',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    ...(step.isError && { color: 'error.main' }),
                  }}
                >
                  {step.result}
                </Box>
              )}
            </AccordionDetails>
          </Accordion>
        ))}
        {message.content && (
          <Box
            sx={{
              maxWidth: '95%',
              padding: 1,
              borderRadius: 2,
              bgcolor: 'background.paper',
              border: '1px solid ' + theme.palette.divider,
              wordBreak: 'break-word',
              '& img': { maxWidth: '100%' },
            }}
            dangerouslySetInnerHTML={{
              __html: convertMarkDownToHtml(message.content),
            }}
          />
        )}
      </Box>
    );
  };

  const hasContent = currentSession && currentSession.messages.length > 0;

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        gap: 1,
      }}
    >
      {/* session toolbar */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Button
          size="small"
          data-tid="agentTaskGoalTID"
          onClick={(e) => setSessionMenuAnchor(e.currentTarget)}
          endIcon={<ArrowDropUpIcon />}
          sx={{
            flexGrow: 1,
            minWidth: 0,
            justifyContent: 'flex-start',
            textTransform: 'none',
            paddingX: 1,
            color: 'text.primary',
            fontWeight: 500,
          }}
        >
          <Box
            component="span"
            sx={{
              flexGrow: 1,
              minWidth: 0,
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
            }}
          >
            {taskGoalLabel}
          </Box>
        </Button>
        <Menu
          data-tid="agentSessionMenuTID"
          anchorEl={sessionMenuAnchor}
          open={Boolean(sessionMenuAnchor)}
          onClose={() => setSessionMenuAnchor(null)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        >
          {sessions.map((session) => (
            <MenuItem
              key={session.id}
              selected={session.id === currentSession?.id}
              onClick={() => {
                setCurrentSessionId(session.id);
                setSessionMenuAnchor(null);
              }}
            >
              {sessionTitle(session)}
            </MenuItem>
          ))}
          <MenuItem onClick={handleStartRename}>
            <ListItemIcon>
              <EditIcon />
            </ListItemIcon>
            <ListItemText primary={t('core:aiAgentRenameTaskGoal')} />
          </MenuItem>
        </Menu>
        <Button
          size="small"
          data-tid="modelPickerTID"
          onClick={(e) => setModelMenuAnchor(e.currentTarget)}
          endIcon={<ArrowDropUpIcon />}
          sx={{
            minWidth: 0,
            maxWidth: 120,
            textTransform: 'none',
            paddingX: 0.5,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
          }}
        >
          {currentModel?.name || t('core:chooseModel')}
        </Button>
        <Menu
          data-tid="modelPickerMenuTID"
          anchorEl={modelMenuAnchor}
          open={Boolean(modelMenuAnchor)}
          onClose={() => setModelMenuAnchor(null)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        >
          {Array.from(
            new Set<string>([
              ...(currentModel?.name ? [currentModel.name] : []),
              ...(defaultAiProvider.customModels || []),
              ...(models || []).map((m) => m.name).filter(Boolean),
            ]),
          ).map((name) => (
            <MenuItem
              key={name}
              selected={name === currentModel?.name}
              onClick={() => {
                handleChangeModel(name);
                setModelMenuAnchor(null);
              }}
            >
              {name}
            </MenuItem>
          ))}
        </Menu>
        <TsIconButton
          tooltip={t('core:aiAgentExportTranscript')}
          onClick={(e) => setExportMenuAnchor(e.currentTarget)}
          data-tid="agentExportMenuTID"
        >
          <MoreMenuIcon />
        </TsIconButton>
        <Menu
          anchorEl={exportMenuAnchor}
          open={Boolean(exportMenuAnchor)}
          onClose={() => setExportMenuAnchor(null)}
          transformOrigin={{ horizontal: 'right', vertical: 'top' }}
          anchorOrigin={{ horizontal: 'right', vertical: 'bottom' }}
        >
          <MenuItem onClick={saveAsHtml}>
            <ListItemIcon>
              <HTMLFileIcon />
            </ListItemIcon>
            <ListItemText primary={t('core:saveAsHtml')} />
          </MenuItem>
          <MenuItem onClick={saveAsMarkdown}>
            <ListItemIcon>
              <MarkdownFileIcon />
            </ListItemIcon>
            <ListItemText primary={t('core:saveAsMd')} />
          </MenuItem>
        </Menu>
        <TsIconButton
          tooltip={t('core:aiAgentNewSession')}
          onClick={handleNewSession}
        >
          <AddIcon />
        </TsIconButton>
        <TsIconButton
          tooltip={t('core:aiAgentDeleteSession')}
          onClick={handleDeleteSession}
        >
          <DeleteIcon />
        </TsIconButton>
      </Box>
      {/* messages */}
      <Box
        ref={listRef}
        sx={{
          flexGrow: 1,
          overflowY: 'auto',
          padding: 1,
          borderRadius: 1,
          bgcolor: 'background.default',
        }}
      >
        {!hasContent && diskInitDone && (
          <Box
            sx={{ color: 'text.secondary', textAlign: 'center', marginTop: 4 }}
          >
            {t('core:aiAgentEmptyHint')}
          </Box>
        )}
        {!diskInitDone && (
          <Box
            sx={{
              maxWidth: '95%',
              padding: 1,
              borderRadius: 2,
              marginBottom: 1,
              bgcolor: 'background.paper',
              border: '1px solid ' + theme.palette.divider,
              wordBreak: 'break-word',
            }}
          >
            <Box
              dangerouslySetInnerHTML={{
                __html: convertMarkDownToHtml(t('core:aiAgentIntro')),
              }}
            />
            <Box
              component="button"
              type="button"
              onClick={handleStartDiskInit}
              sx={{
                marginTop: 1,
                padding: '6px 14px',
                borderRadius: 999,
                border: '1px solid ' + theme.palette.primary.main,
                color: 'primary.main',
                backgroundColor: 'transparent',
                cursor: 'pointer',
                fontSize: '0.85rem',
                '&:hover': { backgroundColor: theme.palette.action.hover },
              }}
            >
              {t('core:aiAgentIntroInitCta')}
            </Box>
          </Box>
        )}
        {diskInitDone && pendingInboxes.some((p) => p.count > 0) && (
          <Box
            sx={{
              maxWidth: '95%',
              padding: 1,
              borderRadius: 2,
              marginBottom: 1,
              bgcolor: 'background.paper',
              border: '1px solid ' + theme.palette.divider,
              wordBreak: 'break-word',
            }}
          >
            <Box sx={{ fontWeight: 600, fontSize: '0.9rem' }}>
              {t('core:aiInboxOrganizeTitle')}
            </Box>
            {pendingInboxes
              .filter((p) => p.count > 0)
              .map((p) => (
                <Box
                  key={p.path}
                  sx={{ fontSize: '0.85rem', color: 'text.secondary' }}
                >
                  {p.path} ({p.count})
                </Box>
              ))}
            <Box
              component="button"
              type="button"
              onClick={handleOrganizeInbox}
              sx={{
                marginTop: 1,
                padding: '6px 14px',
                borderRadius: 999,
                border: '1px solid ' + theme.palette.primary.main,
                color: 'primary.main',
                backgroundColor: 'transparent',
                cursor: 'pointer',
                fontSize: '0.85rem',
                '&:hover': { backgroundColor: theme.palette.action.hover },
              }}
            >
              {t('core:aiInboxOrganizeCta')}
            </Box>
          </Box>
        )}
        {currentSession?.messages.map(renderMessage)}
        {isRunning && (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              color: 'text.secondary',
            }}
          >
            <CircularProgress size={14} />
            <Box sx={{ fontSize: '0.8rem' }}>{t('core:aiAgentRunning')}</Box>
          </Box>
        )}
      </Box>
      {/* input */}
      <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: 1 }}>
        <TextField
          fullWidth
          multiline
          minRows={2}
          maxRows={6}
          disabled={isRunning}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={t('core:aiAgentInputPlaceholder')}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              handleSend();
            } else if (event.key === 'ArrowUp' && input.trim() === '') {
              event.preventDefault();
              const newIndex = Math.min(
                historyIndex + 1,
                promptHistory.length - 1,
              );
              if (newIndex >= 0 && newIndex < promptHistory.length) {
                setHistoryIndex(newIndex);
                setInput(promptHistory[newIndex]);
              }
            } else if (event.key === 'ArrowDown' && input.trim() === '') {
              event.preventDefault();
              if (historyIndex > 0) {
                const newIndex = historyIndex - 1;
                setHistoryIndex(newIndex);
                setInput(promptHistory[newIndex]);
              } else if (historyIndex === 0) {
                setHistoryIndex(-1);
                setInput('');
              }
            }
          }}
        />
        {isRunning ? (
          <TsIconButton
            tooltip={t('core:aiAgentStopGeneration')}
            onClick={handleStop}
          >
            <StopIcon color="error" />
          </TsIconButton>
        ) : (
          <TsIconButton
            tooltip={t('core:aiAgentSend')}
            onClick={() => handleSend()}
          >
            <SendIcon color={input.trim() ? 'primary' : 'inherit'} />
          </TsIconButton>
        )}
      </Box>
      {/* rename task goal dialog */}
      <Dialog
        open={renamingOpen}
        onClose={() => setRenamingOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>{t('core:aiAgentRenameTaskGoal')}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            placeholder={t('core:aiAgentTaskGoalHint')}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                handleRenameCommit();
              }
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenamingOpen(false)}>
            {t('core:cancel')}
          </Button>
          <Button color="primary" onClick={handleRenameCommit}>
            {t('core:save')}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default AgentPanel;
