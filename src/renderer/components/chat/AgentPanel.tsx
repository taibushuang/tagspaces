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
  DeleteIcon,
  SendIcon,
  StopIcon,
} from '-/components/CommonIcons';
import { AgentEvent, runAgent } from '-/components/chat/AgentService';
import { createAgentTools } from '-/components/chat/AgentTools';
import { buildAgentSystemPrompt } from '-/components/chat/agentPrompt';
import TsIconButton from '-/components/TsIconButton';
import TsSelect from '-/components/TsSelect';
import { useCurrentLocationContext } from '-/hooks/useCurrentLocationContext';
import { useDirectoryContentContext } from '-/hooks/useDirectoryContentContext';
import { useLocationIndexContext } from '-/hooks/useLocationIndexContext';
import { useSelectedEntriesContext } from '-/hooks/useSelectedEntriesContext';
import { useTaggingActionsContext } from '-/hooks/useTaggingActionsContext';
import { useIOActionsContext } from '-/hooks/useIOActionsContext';
import { loadLocationConventions } from '-/components/chat/locationConventions';
import { useChatContext } from '-/hooks/useChatContext';
import { useNotificationContext } from '-/hooks/useNotificationContext';
import { getDefaultAIProvider, getCurrentLanguage } from '-/reducers/settings';
import { convertMarkDownToHtml } from '-/services/utils-io';
import { TS } from '-/tagspaces.namespace';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import { useTheme } from '@mui/material/styles';
import { format } from 'date-fns';
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

function AgentPanel() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { showNotification } = useNotificationContext();
  const { currentModel } = useChatContext();
  const defaultAiProvider = useSelector(getDefaultAIProvider);
  const interfaceLanguage = useSelector(getCurrentLanguage);
  const { findLocation } = useCurrentLocationContext();
  const { agentSearch, getIndex } = useLocationIndexContext();
  const { currentDirectoryPath } = useDirectoryContentContext();
  const { selectedEntries } = useSelectedEntriesContext();
  const { addTagsToFsEntry, removeTagsFromEntry } = useTaggingActionsContext();
  const { setDescriptionChange, moveFiles, saveTextFilePromise } =
    useIOActionsContext();

  const [sessions, setSessions] = useState<AgentSession[]>(loadSessions);
  const [currentSessionId, setCurrentSessionId] = useState<string>(
    () => sessions[0]?.id || '',
  );
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [input, setInput] = useState<string>('');
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
    return createAgentTools({
      agentSearch,
      getIndex,
      currentLocationName: location ? location.name : '',
      currentLocationPath: location ? location.path : '',
      currentDirectoryPath: currentDirectoryPath || '',
      selectedEntries,
      addTagsToFsEntry: (entry, tags) => addTagsToFsEntry(entry, tags),
      removeTagsFromEntry,
      moveFile: (sourcePath: string, targetFolderPath: string) =>
        moveFiles([sourcePath], targetFolderPath, location.uuid),
      loadTextFile: (path: string) => location.loadTextFilePromise(path),
      readFileBytes: (path: string) =>
        Promise.resolve(location.getFileContentPromise(path, 'arraybuffer')),
      getDescription: (path: string) =>
        Promise.resolve(
          location
            .loadFileMetaDataPromise(path)
            .then((meta: TS.FileSystemEntryMeta) => meta?.description || '')
            .catch(() => ''),
        ),
      setDescription: (entry: TS.FileSystemEntry, description: string) =>
        setDescriptionChange(entry, description),
      writeTextFile: (path: string, content: string, overwrite: boolean) =>
        Promise.resolve(
          location.saveTextFilePromise({ path }, content, overwrite),
        ).then(() => undefined),
    });
  }, [
    findLocation,
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

  const handleSend = useCallback(async () => {
    const text = input.trim();
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
    setInput('');
    setIsRunning(true);
    const abortController = new AbortController();
    abortRef.current = abortController;

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
            }),
          },
          ...session.apiMessages,
        ],
        tools: buildTools(),
        signal: abortController.signal,
        onEvent: (event: AgentEvent) => {
          if (event.type === 'text') {
            patchAssistant((msg) => {
              msg.content += event.delta;
            });
          } else if (event.type === 'tool_call') {
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
  }, [
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
  ]);

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
        <TsSelect
          value={currentSession?.id || ''}
          onChange={(event) => setCurrentSessionId(event.target.value)}
          sx={{ flexGrow: 1, '& .MuiSelect-select': { padding: '6px' } }}
          size="small"
        >
          {sessions.map((session) => (
            <MenuItem key={session.id} value={session.id}>
              {sessionTitle(session)}
            </MenuItem>
          ))}
        </TsSelect>
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
        {!hasContent && (
          <Box
            sx={{ color: 'text.secondary', textAlign: 'center', marginTop: 4 }}
          >
            {t('core:aiAgentEmptyHint')}
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
          <TsIconButton tooltip={t('core:aiAgentSend')} onClick={handleSend}>
            <SendIcon color={input.trim() ? 'primary' : 'inherit'} />
          </TsIconButton>
        )}
      </Box>
    </Box>
  );
}

export default AgentPanel;
