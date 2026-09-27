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
 * Generic client for any OpenAI-compatible local/remote LLM server
 * (LM Studio, llama.cpp's llama-server, vLLM, Ollama's /v1 endpoint, …).
 *
 * It speaks only `GET /v1/models` and `POST /v1/chat/completions`, so it has
 * no notion of pulling/deleting models — those are Ollama-native and handled
 * by OllamaClient. The function surface mirrors OllamaClient so ChatProvider
 * can dispatch to either by engine.
 */
import { ChatRequest, ModelResponse } from 'ollama';

/**
 * Resolve the OpenAI base URL. The configured URL is treated as the base that
 * precedes `/v1` (the standard OpenAI `baseURL` convention), so both styles work:
 *   http://localhost:1234        → http://localhost:1234/v1
 *   http://localhost:1234/v1     → http://localhost:1234/v1   (no double /v1)
 *   https://openrouter.ai/api/v1 → https://openrouter.ai/api/v1
 * Callers append only the endpoint suffix (`/chat/completions`, `/models`).
 */
function apiBase(url: string): string {
  if (!url) {
    return url;
  }
  const base = url.replace(/\/+$/, '');
  // Already versioned (…/v1, /api/v3, …) — use as-is; Ark uses /api/v3.
  if (/\/v\d+$/.test(base)) {
    return base;
  }
  return `${base}/v1`;
}

/**
 * @param withBody set Content-Type for requests that carry a JSON body (POST).
 *   Omit it on GET so a no-auth request stays CORS-"simple" (no preflight).
 */
function buildHeaders(
  authKey?: string,
  withBody = false,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (withBody) {
    headers['Content-Type'] = 'application/json';
  }
  if (authKey) {
    headers.Authorization = `Bearer ${authKey}`;
  }
  return headers;
}

/**
 * List models via `GET /v1/models`. The OpenAI shape is `{ data: [{ id }] }`;
 * we map it onto the Ollama `ModelResponse` shape the UI already consumes
 * (only `name` is meaningful — size/dates are unknown for these servers).
 */
export async function getOpenAIModels(
  url: string,
  authKey?: string,
): Promise<ModelResponse[]> {
  if (!url) {
    return undefined;
  }
  try {
    const response = await fetch(`${apiBase(url)}/models`, {
      method: 'GET',
      headers: buildHeaders(authKey),
    });
    if (!response.ok) {
      return undefined;
    }
    const json = await response.json();
    const data = Array.isArray(json?.data) ? json.data : [];
    return data
      .filter((m) => m && m.id)
      .map(
        (m) =>
          ({
            name: m.id,
            model: m.id,
            modified_at: undefined,
            size: 0,
            digest: '',
            details: {
              family: 'openai-compatible',
              format: '',
              families: [],
              parameter_size: '',
              quantization_level: '',
            },
          }) as unknown as ModelResponse,
      );
  } catch (e) {
    console.log('getOpenAIModels', e);
    return undefined;
  }
}

export type ProviderVerifyResult = { ok: boolean; message?: string };

/**
 * Endpoint probe for the URL field's refresh button: GET /models with the
 * configured key, returning the model count on success and the actual HTTP
 * status / error text on failure. No model ping — at URL-entry time no model
 * name exists yet; that live check belongs to Save & Verify.
 */
export async function probeOpenAIEndpoint(
  url: string,
  authKey: string | undefined,
): Promise<{ ok: boolean; message?: string; modelCount?: number }> {
  if (!url) {
    return { ok: false, message: 'no endpoint URL configured' };
  }
  try {
    const response = await fetch(`${apiBase(url)}/models`, {
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
    const data = Array.isArray(json?.data) ? json.data : [];
    return { ok: true, modelCount: data.filter((m) => m && m.id).length };
  } catch (e) {
    return { ok: false, message: e?.message || String(e) };
  }
}

/**
 * Real availability check: one minimal /chat/completions round-trip with the
 * configured key and model. Unlike GET /models this exercises auth end-to-end
 * and works on gateways without a usable models listing (e.g. Ark). A failure
 * carries the actual HTTP status / error text so the UI can show WHY.
 */
export async function verifyOpenAIModel(
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
  try {
    const response = await fetch(`${apiBase(url)}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authKey ? { Authorization: `Bearer ${authKey}` } : {}),
      },
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
    });
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).slice(0, 200);
      return {
        ok: false,
        message: `HTTP ${response.status}${text ? ': ' + text : ''}`,
      };
    }
    const json = await response.json().catch(() => undefined);
    if (Array.isArray(json?.choices) && json.choices.length > 0) {
      return { ok: true };
    }
    return { ok: false, message: 'unexpected response shape' };
  } catch (e) {
    return { ok: false, message: e?.message || String(e) };
  }
}

/**
 * A tool call requested by the model (OpenAI wire format, simplified).
 */
export type OpenAIToolCall = {
  id: string;
  function: { name: string; arguments: string };
};

/** Result of one /chat/completions round: text content and/or tool calls. */
export type OpenAIResult = {
  content?: string;
  toolCalls?: OpenAIToolCall[];
};

/**
 * Translate the internal (Ollama-native) ChatRequest into an OpenAI
 * chat-completions body:
 *  - `messages[].images: [base64]` → `content: [{type:'text'}, {type:'image_url', ...}]`
 *  - Ollama `format: <jsonSchema>` → `response_format: { type:'json_schema', json_schema }`
 *  - `keep_alive` is dropped (no OpenAI equivalent)
 *  - agent fields (`tools`, `tool_choice`) pass through; assistant messages
 *    with `tool_calls` and `role:'tool'` messages pass through untouched
 */
function toOpenAIRequest(msg: ChatRequest): Record<string, any> {
  const messages = (msg.messages || []).map((m: any) => {
    // Agent messages (tool results / assistant tool calls) pass through
    if (m.role === 'tool' || Array.isArray(m.tool_calls)) {
      return { ...m };
    }
    if (Array.isArray(m.images) && m.images.length > 0) {
      return {
        role: m.role,
        content: [
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
          ...m.images.map((base64: string) => ({
            type: 'image_url',
            image_url: { url: 'data:image/jpeg;base64,' + base64 },
          })),
        ],
      };
    }
    return { role: m.role, content: m.content };
  });

  const body: Record<string, any> = {
    model: msg.model,
    messages,
    stream: !!msg.stream,
  };

  // Agent tool definitions pass through in OpenAI format
  const { tools, tool_choice, format } = msg as any;
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
    if (tool_choice) {
      body.tool_choice = tool_choice;
    }
  }

  // Ollama puts the raw JSON schema in `format`; OpenAI wants response_format.
  if (format && typeof format === 'object') {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'result', schema: format },
    };
  }
  return body;
}

/** Accumulate streamed `delta.tool_calls` fragments by index. */
function accumulateToolCalls(
  acc: Record<number, OpenAIToolCall>,
  fragments: any[],
) {
  for (const frag of fragments) {
    if (!frag || typeof frag.index !== 'number') {
      continue;
    }
    const target =
      acc[frag.index] ||
      (acc[frag.index] = { id: '', function: { name: '', arguments: '' } });
    if (frag.id) {
      target.id = frag.id;
    }
    if (frag.function?.name) {
      target.function.name = frag.function.name;
    }
    if (frag.function?.arguments) {
      target.function.arguments += frag.function.arguments;
    }
  }
}

/**
 * Send one /chat/completions round and return both text content and tool
 * calls. When `msg.stream` is true the response is parsed as SSE: text deltas
 * go to `chatMessageHandler` live, tool-call fragments are accumulated by
 * index and returned complete at the end.
 */
export async function chatOpenAICompletion(
  url: string,
  msg: ChatRequest,
  chatMessageHandler?: (msgContent: string) => void,
  authKey?: string,
  signal?: AbortSignal,
): Promise<OpenAIResult | undefined> {
  if (!url) {
    return undefined;
  }
  const body = toOpenAIRequest(msg);
  try {
    const response = await fetch(`${apiBase(url)}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(authKey, true),
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      console.error(
        'chatOpenAICompletion HTTP ' +
          response.status +
          ': ' +
          (await response.text().catch(() => '')),
      );
      return undefined;
    }

    if (msg.stream && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      const toolCallAcc: Record<number, OpenAIToolCall> = {};
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
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) {
            continue;
          }
          const data = trimmed.replace(/^data:\s*/, '');
          if (data === '[DONE]') {
            continue;
          }
          try {
            const json = JSON.parse(data);
            const delta = json?.choices?.[0]?.delta;
            if (!delta) {
              continue;
            }
            if (delta.content) {
              content += delta.content;
              if (chatMessageHandler) {
                chatMessageHandler(delta.content);
              }
            }
            if (Array.isArray(delta.tool_calls)) {
              accumulateToolCalls(toolCallAcc, delta.tool_calls);
            }
          } catch (e) {
            // ignore keep-alive / non-JSON lines
          }
        }
      }
      const toolCalls = Object.keys(toolCallAcc)
        .map(Number)
        .sort((a, b) => a - b)
        .map((i) => toolCallAcc[i])
        .filter((c) => c.function.name);
      return {
        ...(content ? { content } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      };
    }

    const json = await response.json();
    const message = json?.choices?.[0]?.message;
    const toolCalls: OpenAIToolCall[] = Array.isArray(message?.tool_calls)
      ? message.tool_calls.filter((c: any) => c?.function?.name)
      : [];
    return {
      ...(message?.content ? { content: message.content } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  } catch (e) {
    if ((e as any)?.name === 'AbortError') {
      return undefined;
    }
    console.error('chatOpenAICompletion error', e);
    return undefined;
  }
}

/**
 * Send a chat message via `POST /v1/chat/completions`. When `msg.stream` is
 * true the response is parsed as SSE and `chatMessageHandler` receives each
 * delta; otherwise the full assistant content is returned.
 */
export async function newOpenAIMessage(
  url: string,
  msg: ChatRequest,
  chatMessageHandler?: (msgContent: string) => void,
  authKey?: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const result = await chatOpenAICompletion(
    url,
    msg,
    chatMessageHandler,
    authKey,
    signal,
  );
  return result?.content;
}
