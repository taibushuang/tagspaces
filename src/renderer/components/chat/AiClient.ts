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
 * Engine-agnostic AI client used by ChatProvider. It hides the difference
 * between the Ollama-native SDK (`engine: 'ollama'`) and any OpenAI-compatible
 * server (`engine: 'openai-compatible'` — LM Studio, llama.cpp, vLLM, …).
 *
 * `pull`/`delete` are Ollama-only and therefore optional; OpenAI-compatible
 * servers manage their models externally, so those members are undefined and
 * the UI hides the corresponding controls.
 */
import { AIProvider } from '-/components/chat/ChatTypes';
import {
  deleteOllamaModel,
  getOllamaModels,
  newOllamaMessage,
  pullOllamaModel,
} from '-/components/chat/OllamaClient';
import {
  getOpenAIModels,
  newOpenAIMessage,
  probeOpenAIEndpoint,
  verifyOpenAIModel,
} from '-/components/chat/OpenAIClient';
import { ChatRequest, ModelResponse, Ollama } from 'ollama';

export interface AiClient {
  engine: AIProvider['engine'];
  list: () => Promise<ModelResponse[]>;
  chat: (
    msg: ChatRequest,
    chatMessageHandler?: (msgContent: string) => void,
  ) => Promise<string | undefined>;
  abort: () => void;
  /** Ollama-only: download a model with progress. Undefined elsewhere. */
  pull?: (model: string, progress: (part: any) => void) => Promise<boolean>;
  /** Ollama-only: delete an installed model. Undefined elsewhere. */
  delete?: (model: string) => Promise<string>;
}

async function getOllamaInstance(url: string): Promise<Ollama> {
  if (url) {
    try {
      //@ts-ignore - browser build has no bundled types entry
      const { Ollama } = await import('ollama/browser');
      return new Ollama({ host: url });
    } catch (error) {
      console.error('Failed to load Ollama module:', error);
    }
  }
  return undefined;
}

/**
 * Build the right AiClient for a provider. Returns undefined only when the
 * Ollama SDK fails to load; OpenAI-compatible clients are always constructable.
 */
export async function getAiClient(provider: AIProvider): Promise<AiClient> {
  if (!provider || !provider.url) {
    return undefined;
  }
  if (provider.engine === 'openai-compatible') {
    let controller: AbortController | undefined;
    return {
      engine: provider.engine,
      list: () => getOpenAIModels(provider.url, provider.authKey),
      chat: (msg, handler) => {
        controller = new AbortController();
        return newOpenAIMessage(
          provider.url,
          msg,
          handler,
          provider.authKey,
          controller.signal,
        );
      },
      abort: () => {
        if (controller) {
          controller.abort();
        }
      },
    };
  }
  // default: Ollama
  const ollama = await getOllamaInstance(provider.url);
  if (!ollama) {
    return undefined;
  }
  return {
    engine: 'ollama',
    list: () => getOllamaModels(ollama),
    chat: (msg, handler) => newOllamaMessage(ollama, msg, handler),
    abort: () => ollama.abort(),
    pull: (model, progress) => pullOllamaModel(ollama, model, progress),
    delete: (model) => deleteOllamaModel(ollama, model),
  };
}

/** Probe whether a provider's endpoint is reachable (models list succeeds). */
export function checkProviderAlive(provider: AIProvider): Promise<boolean> {
  return getAiClient(provider)
    .then((client) => (client ? client.list() : undefined))
    .then((m) => !!m)
    .catch(() => false);
}

export type ProviderVerifyResult = { ok: boolean; message?: string };

/**
 * Real availability check: one minimal chat round-trip with the configured
 * key and model — unlike a GET /models probe this exercises auth end-to-end
 * and works on gateways without a usable models listing (e.g. Ark). A failure
 * carries the actual HTTP status / error text so the UI can show WHY.
 */
export async function verifyProviderModel(
  provider: AIProvider,
  modelName: string,
): Promise<ProviderVerifyResult> {
  if (!provider || !provider.url) {
    return { ok: false, message: 'no endpoint URL configured' };
  }
  if (!modelName) {
    return { ok: false, message: 'no model name configured' };
  }
  if (provider.engine === 'openai-compatible') {
    return verifyOpenAIModel(provider.url, provider.authKey, modelName);
  }
  // Ollama: a tiny chat round-trip proves endpoint + model.
  try {
    const ollama = await getOllamaInstance(provider.url);
    if (!ollama) {
      return { ok: false, message: 'Ollama SDK unavailable' };
    }
    await ollama.chat({
      model: modelName,
      messages: [{ role: 'user', content: 'ping' }],
      options: { num_predict: 1 },
    });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, message: e?.message || String(e) };
  }
}

/**
 * Endpoint discovery probe for the URL field's refresh button: GET /models
 * with the configured key (if any). Reports the model count on success and
 * the HTTP status on failure; 404 means the gateway has no models listing
 * (e.g. Ark) — manual model entry + Save & Verify is the path there.
 */
export async function probeProviderEndpoint(provider: AIProvider): Promise<{
  ok: boolean;
  message?: string;
  modelCount?: number;
  httpStatus?: number;
}> {
  if (!provider || !provider.url) {
    return { ok: false, message: 'no endpoint URL configured' };
  }
  if (provider.engine === 'openai-compatible') {
    const result = await probeOpenAIEndpoint(provider.url, provider.authKey);
    return result;
  }
  // Ollama: the SDK list doubles as the discovery probe.
  try {
    const ollama = await getOllamaInstance(provider.url);
    if (!ollama) {
      return { ok: false, message: 'Ollama SDK unavailable' };
    }
    const models = await getOllamaModels(ollama);
    return { ok: true, modelCount: models ? models.length : 0 };
  } catch (e: any) {
    return { ok: false, message: e?.message || String(e) };
  }
}
