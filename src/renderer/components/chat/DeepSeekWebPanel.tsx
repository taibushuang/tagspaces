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
 *  - "程序化对话": our own input that replays the observed request with the
 *    session cookies — extra context can be injected, the answer streams in
 *    (content + thinking + citations) and can be saved to the folder
 *    knowledge base or to a markdown file.
 *
 * This is a personal-automation integration against a third-party web
 * service: it can break when chat.deepseek.com changes, and relies on the
 * user's own logged-in session.
 */
import { marked } from 'marked';
import { useCurrentLocationContext } from '-/hooks/useCurrentLocationContext';
import { useNotificationContext } from '-/hooks/useNotificationContext';
import { writeLocationKb } from '-/services/knowledgeBase';
import {
  buildDeepseekPowResponse,
  parseDeepseekStream,
} from '-/services/deepseekPow';
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
import React, { useRef, useState } from 'react';

const WebviewTag = 'webview' as any;
const DEEPSEEK_URL = 'https://chat.deepseek.com/';
const FALLBACK_CHAT_URL = 'https://chat.deepseek.com/api/v0/chat/completion';

type RefShape = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  capturedAt: number;
};

type StreamAccumulator = {
  content: string;
  thinking: string;
  citations: string[];
};

function DeepSeekWebPanel() {
  const { t } = useTranslation();
  const { showNotification } = useNotificationContext();
  const { findLocation } = useCurrentLocationContext();
  const webviewRef = useRef<any>(null);
  const [mode, setMode] = useState<'web' | 'api'>('web');
  const [input, setInput] = useState('');
  const [inject, setInject] = useState('');
  const [requestRef, setRequestRef] = useState<RefShape | null>(null);
  const [cookieCount, setCookieCount] = useState<number>(0);
  const parentId = useRef<number | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [acc, setAcc] = useState<StreamAccumulator>({
    content: '',
    thinking: '',
    citations: [],
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
      try {
        const ses = await window.electronIO.ipcRenderer.invoke(
          'get-deepseek-session',
        );
        sessionIdRef.current = ses?.sessionId || null;
      } catch (e) {
        /* session id optional */
      }
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

  async function sendApi() {
    const question = input.trim();
    if (!question || streaming) return;
    const injected =
      inject.trim() !== '' ? `${inject.trim()}\n\n${question}` : question;

    // The programmatic chat runs on its own fresh session, created from
    // inside the webview (origin-safe) — independent of what the webview is
    // currently showing.
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
    const sessionId: string = created.id;
    // First message of a fresh session uses a null parent; the ready event
    // of each response supplies the next parent_message_id.
    parentId.current = null;

    const payload = {
      chat_session_id: sessionId,
      parent_message_id: parentId.current,
      model_type: null,
      prompt: injected,
      ref_file_ids: [],
      thinking_enabled: false,
      search_enabled: true,
      action: null,
      preempt: false,
    };

    setStreaming(true);
    setAcc({ content: '', thinking: '', citations: [] });
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
      setAcc({
        content: parsed.content,
        thinking: parsed.thinking,
        citations: parsed.citations,
      });
    };
    const onWebviewConsole = (ev: any) => {
      const msg: string = ev?.message || '';
      if (!msg.startsWith('[ds-stream]')) return;
      streamBuf += msg.replace('[ds-stream]', '') + '\n';
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
        return;
      }
      if (!res?.ok) {
        showNotification(
          t('core:deepseekErr', { msg: res.text || 'completion failed' }),
          'warning',
        );
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
    } finally {
      if (streamTimer) window.clearTimeout(streamTimer);
      wvEl?.removeEventListener?.('console-message', onWebviewConsole);
      setStreaming(false);
    }
  }

  async function saveToKb() {
    const location = findLocation();
    if (!location) {
      showNotification(t('core:deepseekNoLocation'), 'warning');
      return;
    }
    const text = acc.content.trim();
    if (!text) return;
    const body = [
      acc.thinking.trim() ? `> 思考过程\n\n${acc.thinking.trim()}` : '',
      text,
      acc.citations?.length
        ? `\n\n**引用来源：**\n${acc.citations.join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    await writeLocationKb(
      location,
      `DeepSeek 回答 ${new Date().toISOString().slice(0, 10)}`,
      body,
    );
    showNotification(t('core:deepseekSaved'), 'info');
  }

  const html = acc.content ? (marked.parse(acc.content) as string) : '';
  const thinkingHtml = acc.thinking
    ? (marked.parse(acc.thinking) as string)
    : '';

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
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
      {mode !== 'web' && (
        <Box
          sx={{
            flexGrow: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Button size="small" variant="outlined" onClick={readSession}>
              {t('core:deepseekReadSession')}
            </Button>
            <IconButton size="small" onClick={readSession} aria-label="refresh">
              <RefreshIcon fontSize="small" />
            </IconButton>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {t('core:deepseekSessionStatus', {
                cookies: cookieCount,
                ref: requestRef ? '✓' : '—',
              })}
            </Typography>
          </Box>
          <TextField
            size="small"
            multiline
            minRows={2}
            label={t('core:deepseekInject')}
            value={inject}
            onChange={(e) => setInject(e.target.value)}
          />
          <TextField
            size="small"
            multiline
            minRows={2}
            label={t('core:yourMessageForAI')}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button
              size="small"
              variant="contained"
              disabled={streaming}
              onClick={sendApi}
              data-tid="deepseekSendTID"
            >
              {streaming ? (
                <CircularProgress size={14} />
              ) : (
                t('core:deepseekSend')
              )}
            </Button>
            {acc.content && (
              <>
                <Button size="small" onClick={saveToKb}>
                  {t('core:deepseekSaveKb')}
                </Button>
              </>
            )}
          </Box>
          {(acc.content || acc.thinking) && (
            <Box
              sx={{
                overflowY: 'auto',
                flexGrow: 1,
                minHeight: 0,
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: 1,
                padding: 1.5,
                backgroundColor: 'background.paper',
              }}
              data-tid="deepseekAnswerTID"
            >
              {acc.thinking && (
                <Box
                  sx={{
                    opacity: 0.6,
                    borderBottom: '1px solid',
                    borderColor: 'divider',
                    marginBottom: 1,
                    paddingBottom: 1,
                    fontSize: 12,
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  <Typography variant="caption" sx={{ fontWeight: 600 }}>
                    {t('core:deepseekThinking')}
                  </Typography>
                  <div dangerouslySetInnerHTML={{ __html: thinkingHtml }} />
                </Box>
              )}
              <div
                className="ai-kb-markdown"
                dangerouslySetInnerHTML={{ __html: html }}
              />
              {streaming && (
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
              {acc.citations?.length > 0 && (
                <Typography
                  variant="caption"
                  component="div"
                  sx={{ color: 'text.secondary', marginTop: 1 }}
                >
                  {t('core:deepseekCitations')}: {acc.citations.join(' | ')}
                </Typography>
              )}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}

export default DeepSeekWebPanel;
