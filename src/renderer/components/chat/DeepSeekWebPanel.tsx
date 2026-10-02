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
  const parentId = useRef<number>(1);
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

  async function getCookies(): Promise<string> {
    const webContents = webviewRef.current?.getWebContents();
    if (!webContents?.session?.cookies) return '';
    const cookies = await webContents.session.cookies.get({
      url: DEEPSEEK_URL,
    });
    return cookies.map((c: any) => `${c.name}=${c.value}`).join('; ');
  }

  async function sendApi() {
    const question = input.trim();
    if (!question || streaming) return;
    if (cookieCount === 0) {
      await readSession();
      if (cookieCount === 0) {
        showNotification(t('core:deepseekSessionEmpty'), 'warning');
        return;
      }
    }
    const cookie = await getCookies();
    if (!cookie) {
      showNotification(t('core:deepseekSessionEmpty'), 'warning');
      return;
    }
    const injected =
      inject.trim() !== '' ? `${inject.trim()}\n\n${question}` : question;

    // Prefer the observed request body shape (chat_session_id, parent_message_id,
    // prompt, …). Otherwise fall back to that same shape with a fresh session.
    let payload: any;
    const refBody = requestRef?.body;
    if (refBody) {
      try {
        const parsed = JSON.parse(refBody);
        payload = parsed;
        payload.prompt = injected;
        delete payload.stream;
        // Track the parent message id locally when a reference body exists.
        parentId.current = Math.max(
          parentId.current,
          (parsed.parent_message_id || 0) + 1,
        );
        payload.parent_message_id = parentId.current;
      } catch (e) {
        payload = null;
      }
    }
    if (!payload) {
      payload = {
        chat_session_id: sessionIdRef.current,
        parent_message_id: parentId.current,
        model_type: null,
        prompt: injected,
        ref_file_ids: [],
        thinking_enabled: false,
        search_enabled: true,
        action: null,
        preempt: false,
      };
    }

    const url = requestRef?.url || FALLBACK_CHAT_URL;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Cookie: cookie,
      ...(requestRef?.headers || {}),
    };
    delete headers['content-length'];
    delete headers['accept-encoding'];
    delete headers['cookie'];
    delete headers['authorization'];
    if (requestRef?.headers?.authorization) {
      headers.authorization = requestRef.headers.authorization;
    }

    setStreaming(true);
    setAcc({ content: '', thinking: '', citations: [] });
    let buffered = '';
    try {
      const resp = await fetch(url, {
        method: requestRef?.method || 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      if (!resp.ok || !resp.body) {
        const text = await resp.text().catch(() => '');
        showNotification(
          t('core:deepseekErr', {
            msg: `HTTP ${resp.status} ${text.slice(0, 120)}`,
          }),
          'warning',
        );
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split('\n');
        buffered = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.replace(/^data:\s*/, '');
          if (data === '[DONE]') continue;
          try {
            const json = JSON.parse(data);
            const delta = json?.choices?.[0]?.delta || {};
            const chunk = {
              content:
                delta.content || json?.content || json?.message?.content || '',
              thinking:
                delta.reasoning_content ||
                json?.reasoning_content ||
                json?.message?.reasoning_content ||
                '',
              citations: delta.citations || json?.citations || undefined,
            };
            setAcc((prev) => ({
              content: prev.content + chunk.content,
              thinking: prev.thinking + chunk.thinking,
              citations: chunk.citations || prev.citations,
            }));
          } catch (e) {
            /* keep-alive / non-JSON chunk */
          }
        }
      }
    } catch (e: any) {
      showNotification(
        t('core:deepseekErr', { msg: e?.message || String(e) }),
        'warning',
      );
    } finally {
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

      {mode === 'web' ? (
        <Box sx={{ flexGrow: 1, minHeight: 0, position: 'relative' }}>
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
      ) : (
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
              sx={{ overflowY: 'auto', flexGrow: 1, minHeight: 0 }}
              data-tid="deepseekAnswerTID"
            >
              {acc.thinking && (
                <Box
                  sx={{
                    opacity: 0.6,
                    borderBottom: '1px solid',
                    borderColor: 'divider',
                    marginBottom: 1,
                  }}
                  dangerouslySetInnerHTML={{ __html: thinkingHtml }}
                />
              )}
              <div dangerouslySetInnerHTML={{ __html: html }} />
              {acc.citations?.length > 0 && (
                <Typography
                  variant="caption"
                  component="div"
                  sx={{ color: 'text.secondary' }}
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
