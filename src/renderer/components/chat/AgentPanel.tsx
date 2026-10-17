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
 * Standalone AI Agent panel: session list, chat bubbles, collapsible
 * tool-call cards, streaming output with a stop button, a scheduled-task
 * sub-view and a live view of a scheduled run.
 *
 * Sessions and the active run live in AgentSessionsContextProvider so they
 * survive this panel being unmounted (Drawer closed / tab switched) and so
 * scheduled tasks can execute in the background. This component only owns
 * view-local state (input text, menus, sub-view selection).
 */
import {
  AddIcon,
  ArrowDropUpIcon,
  CloseIcon,
  DeleteIcon,
  EditIcon,
  GoBackIcon,
  HTMLFileIcon,
  MarkdownFileIcon,
  MoreMenuIcon,
  SendIcon,
  StopIcon,
} from '-/components/CommonIcons';
import {
  AgentChatMessage,
  AgentScheduledRunning,
  sessionTitle,
  shortText,
  prettyArgs,
  transcriptToMarkdown,
  useAgentSessionsContext,
} from '-/components/chat/AgentSessionsContextProvider';
import { readDiskInitState } from '-/components/chat/AgentTools';
import { useCurrentLocationContext } from '-/hooks/useCurrentLocationContext';
import { useLocationIndexContext } from '-/hooks/useLocationIndexContext';
import { useChatContext } from '-/hooks/useChatContext';
import { useNotificationContext } from '-/hooks/useNotificationContext';
import { inboxLastOrganizedMs, newEntriesSince } from '-/utils/inboxOrganize';
import { getDefaultAIProvider } from '-/reducers/settings';
import TsIconButton from '-/components/TsIconButton';
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
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import ScheduleIcon from '@mui/icons-material/Schedule';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import { useTheme } from '@mui/material/styles';
import { format, formatDistanceToNow } from 'date-fns';
import {
  convertMarkDownToHtml,
  getMimeType,
  saveAsTextFile,
} from '-/services/utils-io';
import { formatDateTime4Tag } from '@tagspaces/tagspaces-common/misc';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSelector } from 'react-redux';
import { describeSchedule } from '-/utils/agentSchedule';
import type { AgentScheduledTask } from '-/utils/agentSchedule';
import ConfirmDialog from '-/components/dialogs/ConfirmDialog';

type AgentPanelView = 'agent' | 'scheduled';
type LastResult = AgentScheduledTask['lastResults'][number];

const selectableTextSx = {
  userSelect: 'text',
  '& *': {
    userSelect: 'text',
    cursor: 'text',
  },
  '& button': {
    userSelect: 'none',
    cursor: 'pointer',
  },
};

function AgentPanel() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { showNotification } = useNotificationContext();
  const { currentModel, models, setModel, changeCurrentModel } =
    useChatContext();
  const defaultAiProvider = useSelector(getDefaultAIProvider);
  const { findLocation } = useCurrentLocationContext();
  const { listChildren } = useLocationIndexContext();
  const {
    sessions,
    currentSession,
    currentSessionId,
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
  } = useAgentSessionsContext();

  const [view, setView] = useState<AgentPanelView>('agent');
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentScheduledTask | null>(
    null,
  );
  const [liveInput, setLiveInput] = useState<string>('');
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
  const listRef = useRef<HTMLDivElement>(null);
  const detailListRef = useRef<HTMLDivElement>(null);

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

  // live view of a scheduled run follows its transcript while streaming
  useEffect(() => {
    if (detailListRef.current) {
      detailListRef.current.scrollTop = detailListRef.current.scrollHeight;
    }
  }, [runningTask?.taskId, sessions]);

  // A run refused to auto-resume because the location changed: bring the
  // instruction back into the input box for review.
  useEffect(() => {
    if (restoredInput !== null) {
      setInput(restoredInput);
      consumeRestoredInput();
    }
  }, [restoredInput, consumeRestoredInput]);

  const handleSend = useCallback(
    (overrideText?: string) => {
      const text = (overrideText ?? input).trim();
      if (!text) {
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
      const sessionId = currentSession?.id;
      if (!sessionId) {
        return;
      }

      // A run is already in flight: queue this message for step-boundary
      // injection instead of starting a parallel run. Never inject into a
      // scheduled run that belongs to a different session — that would
      // misroute the instruction (cross-session injection).
      if (isRunning) {
        if (runningTask && runningTask.sessionId !== sessionId) {
          showNotification(
            t('core:aiAgentScheduledAnotherTaskRunning'),
            'warning',
          );
          return;
        }
        enqueueInterrupt(text);
      } else {
        void startRun({ sessionId, text });
      }
      setPromptHistory((prev) => [text, ...prev].slice(0, 10));
      setHistoryIndex(-1);
      setInput('');
    },
    [
      input,
      defaultAiProvider,
      currentModel,
      currentSession,
      isRunning,
      runningTask,
      enqueueInterrupt,
      startRun,
      showNotification,
      t,
    ],
  );

  const handleStartDiskInit = useCallback(() => {
    handleSend(t('core:aiAgentIntroInitMessage'));
  }, [handleSend, t]);

  const handleOrganizeInbox = useCallback(() => {
    const fresh = pendingInboxes.filter((p) => p.count > 0).slice(0, 5);
    const more =
      pendingInboxes.filter((p) => p.count > 0).length > 5 ? '\n…' : '';
    const list = fresh.map((p) => `${p.path} (${p.count})`).join('\n');
    handleSend(`${t('core:aiInboxOrganizeMessage')}\n${list}${more}`);
  }, [pendingInboxes, handleSend, t]);

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
    newAgentSession();
  }, [newAgentSession]);

  const handleDeleteSession = useCallback(() => {
    deleteCurrentAgentSession();
  }, [deleteCurrentAgentSession]);

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

  const handleLiveSend = useCallback(() => {
    const text = liveInput.trim();
    if (!text) {
      return;
    }
    enqueueInterrupt(text);
    setLiveInput('');
  }, [liveInput, enqueueInterrupt]);

  const describeTask = useCallback((task: AgentScheduledTask) => {
    try {
      return describeSchedule(task.schedule.cron);
    } catch (e) {
      return task.schedule.cron;
    }
  }, []);

  const statusText = useCallback(
    (status: LastResult['status']) => {
      switch (status) {
        case 'success':
          return t('core:aiAgentScheduledStatusSuccess');
        case 'failed':
          return t('core:aiAgentScheduledStatusFailed');
        case 'skipped':
          return t('core:aiAgentScheduledStatusSkipped');
        default:
          return t('core:aiAgentScheduledStatusMissed');
      }
    },
    [t],
  );

  const detailText = useCallback(
    (detail?: string) => {
      if (!detail) {
        return '';
      }
      if (detail === 'agent busy') {
        return t('core:aiAgentScheduledSkippedBusy');
      }
      if (detail === 'location missing') {
        return t('core:aiAgentScheduledSkippedLocation');
      }
      return detail;
    },
    [t],
  );

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

  const renderLastResultBadge = (task: AgentScheduledTask) => {
    const last = task.lastResults[task.lastResults.length - 1];
    if (!last) {
      return (
        <Box sx={{ fontSize: '0.78rem', color: 'text.secondary' }}>
          {t('core:aiAgentScheduledNoRuns')}
        </Box>
      );
    }
    const color =
      last.status === 'success'
        ? 'success.main'
        : last.status === 'failed'
          ? 'error.main'
          : 'text.secondary';
    return (
      <Box
        component="span"
        title={detailText(last.detail)}
        sx={{ fontSize: '0.78rem', color }}
      >
        {statusText(last.status)} ·{' '}
        {formatDistanceToNow(last.startedAt, { addSuffix: true })}
      </Box>
    );
  };

  const renderTaskHistory = (task: AgentScheduledTask) => {
    if (task.lastResults.length === 0) {
      return (
        <Box sx={{ fontSize: '0.78rem', color: 'text.secondary' }}>
          {t('core:aiAgentScheduledNoRuns')}
        </Box>
      );
    }
    return [...task.lastResults].reverse().map((result, index) => (
      <Box
        key={'result-' + index}
        sx={{
          display: 'flex',
          gap: 1,
          fontSize: '0.78rem',
          alignItems: 'baseline',
        }}
      >
        <Box component="span" sx={{ minWidth: 140 }}>
          {format(result.startedAt, 'yyyy-MM-dd HH:mm')}
        </Box>
        <Box component="span">{statusText(result.status)}</Box>
        {result.detail && (
          <Box
            component="span"
            sx={{ color: 'text.secondary', wordBreak: 'break-word' }}
          >
            {detailText(result.detail)}
          </Box>
        )}
      </Box>
    ));
  };

  const activeRunningTask: AgentScheduledRunning | null =
    runningTask && runningTask.taskId === detailTaskId ? runningTask : null;

  const renderRunningDetail = (active: AgentScheduledRunning) => {
    const task = tasks.find((item) => item.id === active.taskId);
    const session = sessions.find((item) => item.id === active.sessionId);
    const location = task ? findLocation(task.locationId) : undefined;
    return (
      <Box
        data-tid="agentScheduledDetailTID"
        sx={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          gap: 1,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <TsIconButton
            tooltip={t('core:aiAgentScheduledBack')}
            onClick={() => setDetailTaskId(null)}
          >
            <GoBackIcon fontSize="small" />
          </TsIconButton>
          <Box sx={{ flexGrow: 1, fontWeight: 600, minWidth: 0 }}>
            {task ? task.name : t('core:aiAgentScheduledDetailTitle')}
          </Box>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              color: 'text.secondary',
              fontSize: '0.8rem',
            }}
          >
            <CircularProgress size={12} />
            {t('core:aiAgentScheduledRunning')}
          </Box>
          <TsIconButton
            tooltip={t('core:aiAgentScheduledStopRun')}
            onClick={stopRun}
          >
            <StopIcon color="error" />
          </TsIconButton>
        </Box>
        {task && (
          <Box sx={{ fontSize: '0.8rem', color: 'text.secondary' }}>
            {describeTask(task)} ·{' '}
            {location
              ? location.name
              : t('core:aiAgentScheduledLocationMissing')}
          </Box>
        )}
        {task && (
          <Box
            sx={{
              fontSize: '0.85rem',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: 100,
              overflowY: 'auto',
            }}
          >
            {task.prompt}
          </Box>
        )}
        <Box
          ref={detailListRef}
          sx={{
            flexGrow: 1,
            overflowY: 'auto',
            padding: 1,
            borderRadius: 1,
            bgcolor: 'background.default',
            ...selectableTextSx,
          }}
        >
          {session?.messages.map(renderMessage)}
        </Box>
        {queuedCount > 0 && (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              color: 'text.secondary',
            }}
          >
            <CircularProgress size={14} />
            <Box sx={{ fontSize: '0.8rem' }}>
              {t('core:aiAgentQueuedHint', { count: queuedCount })}
            </Box>
          </Box>
        )}
        <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: 1 }}>
          <TextField
            fullWidth
            multiline
            minRows={2}
            maxRows={6}
            value={liveInput}
            onChange={(event) => setLiveInput(event.target.value)}
            placeholder={t('core:aiAgentScheduledLiveInputPlaceholder')}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                handleLiveSend();
              }
            }}
          />
          <TsIconButton
            tooltip={t('core:aiAgentSend')}
            onClick={handleLiveSend}
          >
            <SendIcon color={liveInput.trim() ? 'primary' : 'inherit'} />
          </TsIconButton>
        </Box>
      </Box>
    );
  };

  const renderScheduledView = () => {
    if (activeRunningTask) {
      return renderRunningDetail(activeRunningTask);
    }
    return (
      <Box
        data-tid="agentScheduledViewTID"
        sx={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          gap: 1,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Box sx={{ flexGrow: 1, fontWeight: 600 }}>
            {t('core:aiAgentScheduledTitle')}
          </Box>
          <TsIconButton
            tooltip={t('core:aiAgentScheduledBack')}
            onClick={() => {
              setView('agent');
              setDetailTaskId(null);
            }}
          >
            <CloseIcon />
          </TsIconButton>
        </Box>
        <Box
          sx={{
            flexGrow: 1,
            overflowY: 'auto',
            padding: 1,
            borderRadius: 1,
            bgcolor: 'background.default',
            ...selectableTextSx,
          }}
        >
          {tasks.length === 0 && (
            <Box
              sx={{
                color: 'text.secondary',
                textAlign: 'center',
                marginTop: 4,
                paddingX: 2,
              }}
            >
              {t('core:aiAgentScheduledEmpty')}
            </Box>
          )}
          {tasks.map((task) => {
            const isTaskRunning = runningTask?.taskId === task.id;
            const expanded = expandedTaskId === task.id;
            const location = findLocation(task.locationId);
            return (
              <Box
                key={task.id}
                sx={{
                  paddingY: 1,
                  borderBottom: '1px solid',
                  borderColor: 'divider',
                  opacity: task.enabled ? 1 : 0.6,
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <Switch
                    size="small"
                    checked={task.enabled}
                    disabled={isTaskRunning}
                    onChange={(event) =>
                      toggleTaskEnabled(task.id, event.target.checked)
                    }
                  />
                  <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                    <Box
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 1,
                        minWidth: 0,
                      }}
                    >
                      <Box
                        sx={{
                          fontWeight: 500,
                          overflow: 'hidden',
                          whiteSpace: 'nowrap',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {task.name}
                      </Box>
                      {isTaskRunning && (
                        <Box
                          component="button"
                          type="button"
                          data-tid="agentScheduledRunningBadgeTID"
                          onClick={() => setDetailTaskId(task.id)}
                          sx={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 0.5,
                            border: '1px solid ' + theme.palette.primary.main,
                            borderRadius: 999,
                            padding: '1px 8px',
                            color: 'primary.main',
                            backgroundColor: 'transparent',
                            cursor: 'pointer',
                            fontSize: '0.72rem',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          <CircularProgress size={10} />
                          {t('core:aiAgentScheduledRunning')}
                        </Box>
                      )}
                    </Box>
                    <Box
                      sx={{
                        fontSize: '0.8rem',
                        color: 'text.secondary',
                        wordBreak: 'break-word',
                      }}
                    >
                      {describeTask(task)} ·{' '}
                      {location
                        ? location.name
                        : t('core:aiAgentScheduledLocationMissing')}
                    </Box>
                    {renderLastResultBadge(task)}
                  </Box>
                  <TsIconButton
                    tooltip={t('core:aiAgentScheduledRunNow')}
                    disabled={isTaskRunning}
                    onClick={() => {
                      void runNow(task.id);
                    }}
                    data-tid="agentScheduledRunNowTID"
                  >
                    <PlayArrowIcon fontSize="small" />
                  </TsIconButton>
                  <TsIconButton
                    tooltip={t('core:aiAgentScheduledDelete')}
                    disabled={isTaskRunning}
                    onClick={() => setDeleteTarget(task)}
                    data-tid="agentScheduledDeleteTID"
                  >
                    <DeleteIcon fontSize="small" />
                  </TsIconButton>
                  <TsIconButton
                    tooltip={t('core:aiAgentScheduledHistory')}
                    onClick={() => setExpandedTaskId(expanded ? null : task.id)}
                  >
                    <ExpandMoreIcon
                      fontSize="small"
                      sx={{
                        transform: expanded ? 'rotate(180deg)' : 'none',
                      }}
                    />
                  </TsIconButton>
                </Box>
                {expanded && (
                  <Box sx={{ marginTop: 1, marginLeft: 5 }}>
                    {renderTaskHistory(task)}
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      </Box>
    );
  };

  const hasContent = currentSession && currentSession.messages.length > 0;

  if (view === 'scheduled') {
    return (
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          gap: 1,
        }}
      >
        {renderScheduledView()}
        <ConfirmDialog
          open={!!deleteTarget}
          title={t('core:aiAgentScheduledDeleteConfirmTitle')}
          content={
            deleteTarget
              ? t('core:aiAgentScheduledDeleteConfirmContent', {
                  name: deleteTarget.name,
                })
              : undefined
          }
          confirmCallback={(result) => {
            if (result && deleteTarget) {
              void deleteTask(deleteTarget.id);
            }
          }}
          onClose={() => setDeleteTarget(null)}
        />
      </Box>
    );
  }

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
          disabled={isRunning}
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
              // Guard covers the case where the menu was already open when a
              // run started — the anchor button's disabled state can't help.
              disabled={isRunning}
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
              ...(defaultAiProvider?.customModels || []),
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
        {isExecutor && (
          <TsIconButton
            tooltip={t('core:aiAgentScheduledTitle')}
            onClick={() => {
              setView('scheduled');
              void refreshTasks();
            }}
            data-tid="agentScheduledTasksButtonTID"
          >
            <ScheduleIcon />
          </TsIconButton>
        )}
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
          disabled={isRunning}
          onClick={handleNewSession}
        >
          <AddIcon />
        </TsIconButton>
        <TsIconButton
          tooltip={t('core:aiAgentDeleteSession')}
          disabled={isRunning}
          onClick={handleDeleteSession}
        >
          <DeleteIcon />
        </TsIconButton>
      </Box>
      {/* missed scheduled runs (while the app was closed) */}
      {missedTasks.length > 0 && (
        <Box
          data-tid="agentScheduledMissedBannerTID"
          sx={{
            padding: 1,
            borderRadius: 2,
            bgcolor: 'background.paper',
            border: '1px solid ' + theme.palette.divider,
            wordBreak: 'break-word',
          }}
        >
          <Box sx={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: 0.5 }}>
            {t('core:aiAgentScheduledMissedBanner', {
              count: missedTasks.length,
            })}
          </Box>
          {missedTasks.map((task) => (
            <Box
              key={task.id}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                fontSize: '0.85rem',
              }}
            >
              <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                {task.name} · {describeTask(task)}
              </Box>
              <Button
                size="small"
                onClick={() => {
                  void runNow(task.id);
                }}
              >
                {t('core:aiAgentScheduledMissedRun')}
              </Button>
            </Box>
          ))}
          <Button size="small" onClick={dismissMissed}>
            {t('core:aiAgentScheduledDismiss')}
          </Button>
        </Box>
      )}
      {/* messages */}
      <Box
        ref={listRef}
        sx={{
          flexGrow: 1,
          overflowY: 'auto',
          padding: 1,
          borderRadius: 1,
          bgcolor: 'background.default',
          // Global minireset.css sets user-select:none on every element via
          // :not(input):not(textarea) (specificity 0,0,2). A container-level
          // userSelect does NOT propagate to descendants, so use the '& *'
          // subtree override (0,1,0 > 0,0,2) to make chat text selectable
          // and copyable. Buttons keep their pointer cursor.
          ...selectableTextSx,
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
      {queuedCount > 0 && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            color: 'text.secondary',
          }}
        >
          <CircularProgress size={14} />
          <Box sx={{ fontSize: '0.8rem' }}>
            {t('core:aiAgentQueuedHint', { count: queuedCount })}
          </Box>
        </Box>
      )}
      {/* input */}
      <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: 1 }}>
        <TextField
          fullWidth
          multiline
          minRows={2}
          maxRows={6}
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
        {isRunning && (
          <TsIconButton
            tooltip={t('core:aiAgentStopGeneration')}
            onClick={stopRun}
          >
            <StopIcon color="error" />
          </TsIconButton>
        )}
        <TsIconButton
          tooltip={t('core:aiAgentSend')}
          onClick={() => handleSend()}
        >
          <SendIcon color={input.trim() ? 'primary' : 'inherit'} />
        </TsIconButton>
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
