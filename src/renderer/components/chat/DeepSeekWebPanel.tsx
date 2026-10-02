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
 * DeepSeek web integration panel.
 *
 * chat.deepseek.com has no public API — the free web chat uses internal
 * endpoints. This panel gives two views:
 *  - "网页版": an embedded webview (persistent partition) where the user logs
 *    in with their free account. Chatting there is also the reference for
 *    the request format (captured by the main-process observer).
 *  - "程序化对话": a chat UI (message list on top, input at the bottom) that
 *    replays the observed request with the session cookies — multi-turn:
 *    one DeepSeek chat session + parent_message_id chain is kept for the
 *    whole conversation and persisted locally. Answers stream in
 *    (content + thinking + citations) and the transcript can be saved to
 *    the folder knowledge base.
 *
 * This is a personal-automation integration against a third-party web
 * service: it can break when chat.deepseek.com changes, and relies on the
 * user's own logged-in session.
 */
import { AddIcon, SendIcon } from '-/components/CommonIcons';
import { useCurrentLocationContext } from '-/hooks/useCurrentLocationContext';
import { useNotificationContext } from '-/hooks/useNotificationContext';
import { writeLocationKb } from '-/services/knowledgeBase';
import {
  buildDeepseekPowResponse,
  parseDeepseekStream,
} from '-/services/deepseekPow';
import { marked } from 'marked';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import RefreshIcon from '@mui/icons-material/RefreshOutlined';
import React, { useEffect, useRef, useState } from 'react';

const WebviewTag = 'webview' as any;
const DEEPSEEK_URL = 'https://chat.deepseek.com/';

/** Local transcript + DeepSeek session ids, so multi-turn survives remounts. */
const CHAT_STORE_KEY = 'tsDeepseekChat';

type RefShape = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  capturedAt: number;
};

type DsUserMessage = { role: 'user'; content: string };
type DsAssistantMessage = {
  role: 'assistant';
  content: string;
  thinking: string;
  citations: string[];
};
type DsMessage = DsUserMessage | DsAssistantMessage;

type StoredChat = {
  sessionId: string | null;
  parentId: number | null;
  messages: DsMessage[];
  inject: string;
};

function loadStoredChat(): StoredChat {
  const empty: StoredChat = {
    sessionId: null,
    parentId: null,
    messages: [],
    inject: '',
  };
  try {
    const parsed = JSON.parse(localStorage.getItem(CHAT_STORE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object') return empty;
    return {
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
      parentId: Number.isInteger(parsed.parentId) ? parsed.parentId : null,
      inject: typeof parsed.inject === 'string' ? parsed.inject : '',
      messages: Array.isArray(parsed.messages)
        ? parsed.messages
            .filter(
              (m: any) =>
                m &&
                (m.role === 'user' || m.role === 'assistant') &&
                typeof m.content === 'string',
            )
            .map((m: any) =>
              m.role === 'assistant'
                ? {
                    role: 'assistant' as const,
                    content: m.content,
                    thinking: typeof m.thinking === 'string' ? m.thinking : '',
                    citations: Array.isArray(m.citations) ? m.citations : [],
                  }
                : { role: 'user' as const, content: m.content },
            )
        : [],
    };
  } catch (e) {
    return empty;
  }
}

function mdToHtml(markdown: string): string {
  if (!markdown) return '';
  try {
    return marked.parse(markdown) as string;
  } catch (e) {
    return '';
  }
}

function DeepSeekWebPanel() {
  const { t } = useTranslation();
  const { showNotification } = useNotificationContext();
  const { findLocation } = useCurrentLocationContext();
  const webviewRef = useRef<any>(null);
  const [mode, setMode] = useState<'web' | 'api'>(() =>
    loadStoredChat().messages.length > 0 ? 'api' : 'web',
  );
  const [input, setInput] = useState('');
  const [inject, setInject] = useState(() => loadStoredChat().inject);
  const [showInject, setShowInject] = useState(
    () => loadStoredChat().inject !== '',
  );
  const [messages, setMessages] = useState<DsMessage[]>(
    () => loadStoredChat().messages,
  );
  const [requestRef, setRequestRef] = useState<RefShape | null>(null);
  const [cookieCount, setCookieCount] = useState<number>(0);
  const [streaming, setStreaming] = useState(false);
  const [openThinking, setOpenThinking] = useState<Record<number, boolean>>({});
  const parentId = useRef<number | null>(loadStoredChat().parentId);
  const sessionIdRef = useRef<string | null>(loadStoredChat().sessionId);
  const inFlight = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);

  // persist the conversation (ids + transcript) on every change
  useEffect(() => {
    try {
      localStorage.setItem(
        CHAT_STORE_KEY,
        JSON.stringify({
          sessionId: sessionIdRef.current,
          parentId: parentId.current,
          messages,
          inject,
        }),
      );
    } catch (e) {
      /* storage full / unavailable — keep the in-memory conversation */
    }
  }, [messages, inject]);

  // auto-scroll to the newest content (also while streaming)
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  });

  async function readSession() {
    try {
      const webContents = webviewRef.current?.getWebContents();
      let cookies: any[] = [];
      if (webContents?.session?.cookies) {
        cookies = await webContents.session.cookies.get({
          url: DEEPSEEK_URL,
        });
      }
      setCookieCount(cookies.length);
      const ref: RefShape | null = await window.electronIO.ipcRenderer.invoke(
        'get-deepseek-web-request-ref',
      );
      setRequestRef(ref);
      if (cookies.length === 0) {
        showNotification(t('core:deepseekSessionEmpty'), 'warning');
      } else if (!ref) {
        showNotification(t('core:deepseekNoRef'), 'info');
      } else {
        showNotification(
          t('core:deepseekSessionOk', { n: cookies.length }),
          'info',
        );
      }
    } catch (e) {
      showNotification(t('core:deepseekSessionErr'), 'warning');
    }
  }

  function patchLastAssistant(patch: (msg: DsAssistantMessage) => void) {
    setMessages((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i -= 1) {
        if (next[i].role === 'assistant') {
          const copy: DsAssistantMessage = {
            ...(next[i] as DsAssistantMessage),
          };
          patch(copy);
          next[i] = copy;
          break;
        }
      }
      return next;
    });
  }

  /** Drop a trailing assistant bubble left empty by a failed request. */
  function dropEmptyAssistant() {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (
        last &&
        last.role === 'assistant' &&
        !last.content &&
        !last.thinking
      ) {
        return prev.slice(0, -1);
      }
      return prev;
    });
  }

  function startNewChat() {
    if (streaming) return;
    sessionIdRef.current = null;
    parentId.current = null;
    setOpenThinking({});
    setMessages([]);
  }

  async function sendTurn(question: string) {
    // The injected context is conversation-scoped: only the first message
    // of a (new) conversation carries it, later turns stay clean.
    const isFirstTurn = !messages.some((m) => m.role === 'user');
    const prompt =
      isFirstTurn && inject.trim() !== ''
        ? `${inject.trim()}\n\n${question}`
        : question;

    // One DeepSeek chat session for the whole conversation; the next
    // parent_message_id comes from the ready event of each response.
    if (!sessionIdRef.current) {
      const created: any = await window.electronIO.ipcRenderer.invoke(
        'deepseek-web-drive',
        'create-session',
      );
      if (created?.error || !created?.id) {
        showNotification(
          t('core:deepseekErr', {
            msg: created?.error || 'session create failed',
          }),
          'warning',
        );
        return;
      }
      sessionIdRef.current = created.id;
      parentId.current = null;
    }

    const payload = {
      chat_session_id: sessionIdRef.current,
      parent_message_id: parentId.current,
      model_type: null,
      prompt,
      ref_file_ids: [],
      thinking_enabled: false,
      search_enabled: true,
      action: null,
      preempt: false,
    };

    setInput('');
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: question },
      { role: 'assistant', content: '', thinking: '', citations: [] },
    ]);
    setStreaming(true);

    // Streaming: the webview drive script forwards each SSE chunk via
    // console.log('[ds-stream]...'), which the host receives as the webview's
    // 'console-message' event — render incrementally as chunks arrive.
    let streamBuf = '';
    let streamTimer: number | undefined;
    const flushStream = () => {
      const parsed = parseDeepseekStream(streamBuf);
      if (parsed.nextParent) {
        parentId.current = parsed.nextParent;
      }
      patchLastAssistant((msg) => {
        msg.content = parsed.content;
        msg.thinking = parsed.thinking;
        msg.citations = parsed.citations;
      });
    };
    const onWebviewConsole = (ev: any) => {
      const msg: string = ev?.message || '';
      if (!msg.startsWith('[ds-stream]')) return;
      streamBuf += `${msg.replace('[ds-stream]', '')}\n`;
      if (streamTimer) return;
      streamTimer = window.setTimeout(() => {
        streamTimer = undefined;
        flushStream();
      }, 50);
    };
    const wvEl = webviewRef.current as any;
    wvEl?.addEventListener?.('console-message', onWebviewConsole);
    try {
      // 1) Ask for a fresh PoW challenge from INSIDE the webview — DeepSeek's
      //    WAF rejects cross-origin calls from the app page, so all
      //    origin-sensitive requests run in the webview context.
      const chal: any = await window.electronIO.ipcRenderer.invoke(
        'deepseek-web-drive',
        'challenge',
      );
      const ch = chal?.challenge;
      if (chal?.error || !ch) {
        showNotification(
          t('core:deepseekErr', { msg: chal?.error || 'challenge failed' }),
          'warning',
        );
        dropEmptyAssistant();
        return;
      }
      const powHeader = await buildDeepseekPowResponse({
        ...ch,
        target_path: '/api/v0/chat/completion',
      });
      // 2) Run the completion inside the webview (its own auth token + cookie).
      const res: any = await window.electronIO.ipcRenderer.invoke(
        'deepseek-web-drive',
        'completion',
        { body: payload, powHeader },
      );
      if (res?.error) {
        showNotification(t('core:deepseekErr', { msg: res.error }), 'warning');
        dropEmptyAssistant();
        return;
      }
      if (!res?.ok) {
        showNotification(
          t('core:deepseekErr', { msg: res.text || 'completion failed' }),
          'warning',
        );
        dropEmptyAssistant();
        return;
      }
      // Final flush with the complete text (catches any trailing chunks).
      streamBuf = res.text;
      flushStream();
      if (!streamBuf.replace(/^data:[^\n]*\n/g, '').trim()) {
        showNotification(
          t('core:deepseekErr', { msg: 'empty answer' }),
          'warning',
        );
      }
    } catch (e: any) {
      showNotification(
        t('core:deepseekErr', { msg: e?.message || String(e) }),
        'warning',
      );
      dropEmptyAssistant();
    } finally {
      if (streamTimer) window.clearTimeout(streamTimer);
      wvEl?.removeEventListener?.('console-message', onWebviewConsole);
      setStreaming(false);
    }
  }

  async function sendApi() {
    const question = input.trim();
    // inFlight covers the window before `streaming` turns true (session
    // creation is awaited first), so Enter cannot double-send a turn.
    if (!question || streaming || inFlight.current) return;
    inFlight.current = true;
    try {
      await sendTurn(question);
    } finally {
      inFlight.current = false;
    }
  }

  async function saveToKb() {
    const location = findLocation();
    if (!location) {
      showNotification(t('core:deepseekNoLocation'), 'warning');
      return;
    }
    const turns = messages
      .map((m) => {
        if (m.role === 'user') {
          return `### ${t('core:deepseekRoleUser')}\n\n${m.content}`;
        }
        const parts = [
          m.thinking.trim()
            ? `> ${t('core:deepseekThinking')}\n\n${m.thinking.trim()}`
            : '',
          m.content.trim(),
          m.citations?.length
            ? `**${t('core:deepseekCitations')}：**\n${m.citations.join('\n')}`
            : '',
        ].filter(Boolean);
        return parts.length
          ? `### ${t('core:deepseekRoleAssistant')}\n\n${parts.join('\n\n')}`
          : '';
      })
      .filter(Boolean)
      .join('\n\n');
    if (!turns) return;
    await writeLocationKb(
      location,
      `DeepSeek 对话 ${new Date().toISOString().slice(0, 10)}`,
      turns,
    );
    showNotification(t('core:deepseekSaved'), 'info');
  }

  const hasAnswer = messages.some(
    (m) => m.role === 'assistant' && (m.content || m.thinking),
  );
  const turnCount = messages.filter((m) => m.role === 'user').length;

  const isThinkingOpen = (index: number, isLast: boolean): boolean =>
    streaming && isLast ? true : openThinking[index] === true;

  const renderMessage = (message: DsMessage, index: number) => {
    if (message.role === 'user') {
      return (
        <Box
          key={`msg-${index}`}
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
    const isLast = index === messages.length - 1;
    const thinkingOpen = isThinkingOpen(index, isLast);
    return (
      <Box key={`msg-${index}`} sx={{ marginBottom: 1.5 }}>
        {message.thinking && (
          <Box sx={{ marginBottom: 0.5 }}>
            <Typography
              variant="caption"
              component="div"
              onClick={() =>
                setOpenThinking((prev) => ({ ...prev, [index]: !thinkingOpen }))
              }
              sx={{
                color: 'text.secondary',
                cursor: 'pointer',
                userSelect: 'none',
                '&:hover': { textDecoration: 'underline' },
              }}
            >
              {thinkingOpen ? '▾' : '▸'} {t('core:deepseekThinking')}
            </Typography>
            {thinkingOpen && (
              <Box
                sx={{
                  opacity: 0.7,
                  fontSize: 12,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  borderLeft: '2px solid',
                  borderColor: 'divider',
                  paddingLeft: 1,
                  marginTop: 0.5,
                }}
                dangerouslySetInnerHTML={{ __html: mdToHtml(message.thinking) }}
              />
            )}
          </Box>
        )}
        <Box
          sx={{
            padding: 1,
            borderRadius: 2,
            bgcolor: 'background.paper',
            border: '1px solid',
            borderColor: 'divider',
            wordBreak: 'break-word',
            '& img': { maxWidth: '100%' },
          }}
          data-tid={isLast ? 'deepseekAnswerTID' : undefined}
        >
          <div
            className="ai-kb-markdown"
            dangerouslySetInnerHTML={{ __html: mdToHtml(message.content) }}
          />
          {streaming && isLast && (
            <Typography
              component="span"
              sx={{
                color: 'text.secondary',
                animation: 'dsblink 1s step-end infinite',
                '@keyframes dsblink': { '50%': { opacity: 0 } },
              }}
            >
              ▍
            </Typography>
          )}
          {message.citations?.length > 0 && (
            <Typography
              variant="caption"
              component="div"
              sx={{ color: 'text.secondary', marginTop: 1 }}
            >
              {t('core:deepseekCitations')}: {message.citations.join(' | ')}
            </Typography>
          )}
        </Box>
      </Box>
    );
  };

  return (
    <Box
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        paddingX: 1.5,
        paddingTop: 0.5,
      }}
    >
      <Tabs
        value={mode}
        onChange={(e, v) => setMode(v)}
        sx={{ minHeight: 'auto', marginBottom: 1 }}
      >
        <Tab value="web" label={t('core:deepseekWebMode')} />
        <Tab value="api" label={t('core:deepseekApiMode')} />
      </Tabs>

      <Box
        sx={{
          flexGrow: 1,
          minHeight: 0,
          position: 'relative',
          display: mode === 'web' ? 'block' : 'none',
        }}
      >
        <WebviewTag
          ref={webviewRef}
          src={DEEPSEEK_URL}
          partition="persist:deepseekweb"
          style={{ width: '100%', height: '100%' }}
          allowpopups
        />
        <Typography
          variant="caption"
          sx={{
            color: 'text.secondary',
            position: 'absolute',
            bottom: 4,
            left: 8,
          }}
        >
          {t('core:deepseekLoginHint')}
        </Typography>
      </Box>
      {/* the chat stays mounted while hidden, so a running stream survives
          switching back to the webview tab */}
      <Box
        sx={{
          flexGrow: 1,
          minHeight: 0,
          display: mode === 'api' ? 'flex' : 'none',
          flexDirection: 'column',
          gap: 1,
          paddingBottom: 1.5,
        }}
      >
        {/* session / conversation toolbar */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            flexWrap: 'wrap',
          }}
        >
          <Button size="small" variant="outlined" onClick={readSession}>
            {t('core:deepseekReadSession')}
          </Button>
          <IconButton size="small" onClick={readSession} aria-label="refresh">
            <RefreshIcon fontSize="small" />
          </IconButton>
          <Typography
            variant="caption"
            sx={{ color: 'text.secondary', flexGrow: 1, minWidth: 0 }}
          >
            {t('core:deepseekSessionStatus', {
              cookies: cookieCount,
              ref: requestRef ? '✓' : '—',
            })}
            {turnCount > 0 ? ` · #${turnCount}` : ''}
          </Typography>
          <Button
            size="small"
            variant={showInject ? 'outlined' : 'text'}
            onClick={() => setShowInject((v) => !v)}
          >
            {t('core:deepseekInjectToggle')}
          </Button>
          <Button
            size="small"
            onClick={startNewChat}
            disabled={streaming || messages.length === 0}
            startIcon={<AddIcon fontSize="small" />}
          >
            {t('core:deepseekNewChat')}
          </Button>
          {hasAnswer && (
            <Button size="small" onClick={saveToKb}>
              {t('core:deepseekSaveKb')}
            </Button>
          )}
        </Box>
        {showInject && (
          <TextField
            size="small"
            label={t('core:deepseekInject')}
            placeholder={t('core:deepseekInjectHint')}
            value={inject}
            onChange={(e) => setInject(e.target.value)}
          />
        )}

        {/* messages */}
        <Box
          ref={listRef}
          sx={{
            flexGrow: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: 1,
            borderRadius: 1,
            bgcolor: 'background.default',
          }}
        >
          {messages.length === 0 && (
            <Box
              sx={{
                color: 'text.secondary',
                textAlign: 'center',
                marginTop: 4,
                fontSize: '0.85rem',
              }}
            >
              {t('core:deepseekEmptyHint')}
            </Box>
          )}
          {messages.map(renderMessage)}
        </Box>

        {/* input — always at the bottom */}
        <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: 1 }}>
          <TextField
            fullWidth
            size="small"
            multiline
            minRows={2}
            maxRows={6}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('core:deepseekInputPlaceholder')}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                sendApi();
              }
            }}
          />
          <IconButton
            color={input.trim() && !streaming ? 'primary' : 'default'}
            disabled={streaming || !input.trim()}
            onClick={sendApi}
            aria-label={t('core:deepseekSend')}
            data-tid="deepseekSendTID"
            sx={{ marginBottom: 0.5 }}
          >
            {streaming ? <CircularProgress size={20} /> : <SendIcon />}
          </IconButton>
        </Box>
      </Box>
    </Box>
  );
}

export default DeepSeekWebPanel;
