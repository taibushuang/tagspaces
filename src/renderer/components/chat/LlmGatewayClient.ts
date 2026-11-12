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
 * Client for the CCB subsidiary LLM gateway (`upstream_mode: ccb_subsidiary`).
 *
 * The gateway is NOT OpenAI-compatible on the wire — it exposes
 * `POST /chat-gen/conversation` with a flat `{message, session_id, messages?,
 * model?, stream?}` body, `X-Api-Key` auth and replies
 * with `data: {"content": "…"}` SSE frames ending in `data: [DONE]`. All the
 * Sec-* /双层封装 group-protocol work happens inside the gateway; callers only
 * see this simplified surface.
 *
 * Multi-turn context: a session_id starting with `job-` puts the gateway in
 * "upstream self-managed" mode, where the OpenAI-format `messages` array is
 * passed through to the upstream model verbatim. The client keeps its own
 * history (like every other engine), so each request carries a fresh unique
 * `job-` session id plus the full sanitized message list — no reliance on
 * gateway-side memory.
 *
 * Tool calling is NOT supported by this upstream: the agent loop degrades to
 * plain chat (the `tools` field is silently dropped here).
 */
import { ChatRequest, ModelResponse } from 'ollama';
import type { OpenAIResult } from '-/components/chat/OpenAIClient';

/**
 * Normalize the configured URL to the gateway root that precedes `/chat-gen`.
 * Accepted styles:
 *   https://im5.ccbft.com/node3                    → https://im5.ccbft.com/node3
 *   https://im5.ccbft.com/node3/chat-gen           → https://im5.ccbft.com/node3
 *   https://im5.ccbft.com/node3/chat-gen/models    → https://im5.ccbft.com/node3
 *   http://127.0.0.1:8088                          → http://127.0.0.1:8088
 */
function gatewayBase(url: string): string {
  let base = (url || '').trim().replace(/\/+$/, '');
  base = base.replace(/\/chat-gen\/(models|conversation)$/, '');
  base = base.replace(/\/chat-gen$/, '');
  return base;
}

/** Gateway auth: the production llm_gateway authenticates `X-Api-Key`. */
function buildHeaders(authKey?: string, withBody = false) {
  const headers: Record<string, string> = {};
  if (withBody) {
    headers['Content-Type'] = 'application/json';
  }
  if (authKey) {
    headers['X-Api-Key'] = authKey;
  }
  return headers;
}

/** Gateway-enforced session id format: ^[A-Za-z0-9_-]{1,64}$. */
function newSessionId(): string {
  const hex =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID().replace(/-/g, '')
      : `${Date.now()}${Math.random().toString(16).slice(2)}`;
  return `job-ts${hex}`.slice(0, 64);
}

/** Coerce any message content (string / multimodal array / null) to a string. */
function contentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && typeof part.text === 'string'
          ? part.text
          : '',
      )
      .join('');
  }
  return content === null || content === undefined ? '' : String(content);
}

/**
 * OpenAI messages → gateway `messages` passthrough list. The gateway validates
 * that every entry carries both `role` and `content` (assistant tool-call
 * messages have `content: null` in OpenAI wire format and would be rejected),
 * so every entry is flattened to a plain `{role, content}` pair.
 */
function toGatewayMessages(
  msg: ChatRequest,
): { role: string; content: string }[] {
  return (msg.messages || []).map((m: any) => ({
    role: m.role,
    content: contentToText(m.content),
  }));
}

/** Last user text (or any text) from the conversation — the flat `message` field. */
function flatMessage(msg: ChatRequest): string {
  const messages: any[] = msg.messages || [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      const text = contentToText(messages[i].content);
      if (text) {
        return text;
      }
    }
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = contentToText(messages[i].content);
    if (text) {
      return text;
    }
  }
  return '(empty prompt)';
}

/**
 * List models via `GET /chat-gen/models`. Response shape:
 * `{code: 200, data: {models: ["…"], default_model: "…"}}`.
 */
export async function getGatewayModels(
  url: string,
  authKey?: string,
): Promise<ModelResponse[]> {
  if (!url) {
    return undefined;
  }
  try {
    const response = await fetch(`${gatewayBase(url)}/chat-gen/models`, {
      method: 'GET',
      headers: buildHeaders(authKey),
    });
    if (!response.ok) {
      return undefined;
    }
    const json = await response.json();
    const data = json?.data || {};
    // Dedupe while preserving order: dirty site configs may repeat the same
    // model line, which used to render as multiple indistinguishable rows.
    const names: string[] = [];
    if (Array.isArray(data.models)) {
      for (const m of data.models) {
        if (typeof m === 'string' && m && !names.includes(m)) {
          names.push(m);
        }
      }
    }
    if (
      !names.length &&
      typeof data.default_model === 'string' &&
      data.default_model
    ) {
      names.push(data.default_model);
    }
    return names.map(
      (name) =>
        ({
          name,
          model: name,
          modified_at: undefined,
          size: 0,
          digest: '',
          details: {
            family: 'llm-gateway',
            format: '',
            families: [],
            parameter_size: '',
            quantization_level: '',
          },
        }) as unknown as ModelResponse,
    );
  } catch (e) {
    console.log('getGatewayModels', e);
    return undefined;
  }
}

/** Endpoint probe for the URL field's refresh button. */
export async function probeGatewayEndpoint(
  url: string,
  authKey: string | undefined,
): Promise<{ ok: boolean; message?: string; modelCount?: number }> {
  if (!url) {
    return { ok: false, message: 'no endpoint URL configured' };
  }
  try {
    const response = await fetch(`${gatewayBase(url)}/chat-gen/models`, {
      method: 'GET',
      headers: buildHeaders(authKey),
    });
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).slice(0, 200);
      return {
        ok: false,
        message: `HTTP ${response.status}${text ? ': ' + text : ''}`,
      };
    }
    const json = await response.json().catch(() => undefined);
    const data = json?.data || {};
    const names: string[] = Array.isArray(data.models)
      ? Array.from(
          new Set(data.models.filter((m: any) => typeof m === 'string' && m)),
        )
      : [];
    return { ok: true, modelCount: names.length };
  } catch (e) {
    return { ok: false, message: e?.message || String(e) };
  }
}

/**
 * One full conversation round-trip: POST /chat-gen/conversation and consume
 * the SSE stream (`data: {"content": …}` frames, `data: [DONE]` terminator).
 * Returns the accumulated content, or undefined on HTTP/network failure or
 * abort. The request body always asks the gateway for `stream: true` and the
 * response is always consumed as SSE (msg.stream is ignored) — the gateway
 * answers with content frames before [DONE] regardless.
 */
export async function chatGatewayCompletion(
  url: string,
  msg: ChatRequest,
  chatMessageHandler?: (msgContent: string) => void,
  authKey?: string,
  signal?: AbortSignal,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature parity with chatOpenAICompletion
  reasoningHandler?: (reasoningDelta: string) => void,
): Promise<OpenAIResult | undefined> {
  if (!url) {
    return undefined;
  }
  const body = {
    message: flatMessage(msg),
    session_id: newSessionId(),
    messages: toGatewayMessages(msg),
    task_type: 'ds',
    enable_web: 'False',
    ...(msg.model ? { model: msg.model } : {}),
    stream: true,
  };
  try {
    const response = await fetch(`${gatewayBase(url)}/chat-gen/conversation`, {
      method: 'POST',
      headers: buildHeaders(authKey, true),
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      console.error(
        'chatGatewayCompletion HTTP ' +
          response.status +
          ': ' +
          (await response.text().catch(() => '')),
      );
      return undefined;
    }
    let content = '';
    // Parse one SSE line: accumulate `content` frames into `content` and
    // forward each delta to chatMessageHandler.
    const consumeSSELine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) {
        return;
      }
      const data = trimmed.replace(/^data:\s*/, '');
      if (data === '[DONE]') {
        return;
      }
      try {
        const json = JSON.parse(data);
        if (typeof json?.content === 'string') {
          content += json.content;
          if (chatMessageHandler) {
            chatMessageHandler(json.content);
          }
        }
        // reasoning_content frames are not emitted by this upstream; ignored
      } catch (e) {
        // ignore keep-alive / non-JSON lines
      }
    };
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // keep the last (possibly partial) line in the buffer
        buffer = lines.pop() || '';
        for (const line of lines) {
          consumeSSELine(line);
        }
      }
      // flush a trailing line not terminated by \n (lenient SSE servers)
      if (buffer) {
        consumeSSELine(buffer);
      }
    }
    return content ? { content } : {};
  } catch (e) {
    if ((e as any)?.name === 'AbortError') {
      return undefined;
    }
    console.error('chatGatewayCompletion error', e);
    return undefined;
  }
}

export async function newGatewayMessage(
  url: string,
  msg: ChatRequest,
  chatMessageHandler?: (msgContent: string) => void,
  authKey?: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const result = await chatGatewayCompletion(
    url,
    msg,
    chatMessageHandler,
    authKey,
    signal,
  );
  return result?.content;
}

export type ProviderVerifyResult = { ok: boolean; message?: string };

/**
 * Real availability check: one minimal conversation round-trip exercising
 * auth end-to-end. The gateway answers with SSE even for a tiny prompt.
 * On conversation failure a GET /models probe classifies WHY — network
 * unreachable vs edge 403 (IP whitelist) vs 401 (bad token) — so the user
 * sees the actual HTTP status instead of a bare "request failed".
 */
export async function verifyGatewayModel(
  url: string,
  authKey: string | undefined,
  modelName: string,
): Promise<ProviderVerifyResult> {
  if (!url) {
    return { ok: false, message: 'no endpoint URL configured' };
  }
  if (!modelName) {
    return { ok: false, message: 'no model name configured' };
  }
  const result = await chatGatewayCompletion(
    url,
    {
      model: modelName,
      messages: [{ role: 'user', content: 'ping' }],
      stream: false,
    } as any,
    undefined,
    authKey,
  );
  if (result === undefined) {
    try {
      const response = await fetch(`${gatewayBase(url)}/chat-gen/models`, {
        method: 'GET',
        headers: buildHeaders(authKey),
      });
      const text = (await response.text().catch(() => '')).slice(0, 160);
      if (!response.ok) {
        return {
          ok: false,
          message: `HTTP ${response.status}${text ? ': ' + text : ''}`,
        };
      }
      // Models list works but the conversation round-trip failed — the
      // endpoint is reachable and authenticated; blame the upstream/model.
      return {
        ok: true,
        message:
          'models list OK, conversation request failed (upstream/model?)',
      };
    } catch (e) {
      return {
        ok: false,
        message: 'network unreachable: ' + (e?.message || String(e)),
      };
    }
  }
  if (!result.content) {
    // Reachable and authenticated, but the model produced no output frames.
    return { ok: true, message: 'gateway reachable, empty model response' };
  }
  return { ok: true };
}
