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
 * Minimal tool-calling agent loop over any OpenAI-compatible endpoint
 * (Kimi, DeepSeek, Volcengine Ark, LM Studio, intranet gateways, …).
 *
 * It speaks the standard `tools` / `tool_calls` protocol of
 * `/v1/chat/completions`: request → execute requested tools → append
 * `role:'tool'` results → repeat until the model answers with plain text or
 * the step budget is exhausted. Deliberately framework-free — the provider
 * abstraction already lives in AiClient/OpenAIClient.
 */
import { ChatRequest } from 'ollama';
import { chatOpenAICompletion } from '-/components/chat/OpenAIClient';

export type AgentTool = {
  name: string;
  description: string;
  /** JSON Schema for the `parameters` object (OpenAI function format). */
  parameters: Record<string, any>;
  execute: (args: any) => Promise<any>;
};

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; name: string; args: string }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'error'; message: string };

export type AgentMessage = Record<string, any>;

/** Hard budget of model round-trips per run (guards against tool loops). */
export const MAX_AGENT_STEPS = 8;
/**
 * When the step budget is exhausted, the model gets a checkpoint prompt:
 * it must summarize progress and either continue (fresh budget) or wrap
 * up with the final answer. This caps how many times the budget can be
 * renewed, so a runaway loop still terminates (8 × (1+4) rounds max).
 */
export const MAX_AGENT_CHECKPOINTS = 4;
/** Tool results longer than this get truncated before going back to the model. */
export const TOOL_RESULT_CHAR_LIMIT = 4000;

export type AgentRunOptions = {
  url: string;
  authKey?: string;
  model: string;
  messages: AgentMessage[];
  tools: AgentTool[];
  onEvent: (event: AgentEvent) => void;
  signal?: AbortSignal;
  maxSteps?: number;
};

export type AgentRunResult = {
  messages: AgentMessage[];
  content: string;
  aborted: boolean;
};

function toOpenAITool(tool: AgentTool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function truncate(text: string, limit: number) {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)} …[truncated, ${text.length} chars total]`;
}

async function executeToolCall(
  tool: AgentTool | undefined,
  rawArgs: string,
): Promise<string> {
  if (!tool) {
    return JSON.stringify({ error: 'unknown tool' });
  }
  try {
    let args: any = {};
    if (rawArgs && rawArgs.trim()) {
      args = JSON.parse(rawArgs);
    }
    const result = await tool.execute(args);
    return truncate(
      JSON.stringify(result ?? { ok: true }),
      TOOL_RESULT_CHAR_LIMIT,
    );
  } catch (e) {
    // Tool errors go back to the model so it can explain/recover instead of
    // crashing the whole run.
    console.error(`agent tool ${tool.name} failed`, e);
    return JSON.stringify({ error: e?.message || String(e) });
  }
}

/**
 * Run the agent loop. Streams text deltas and tool activity through
 * `onEvent`. Always resolves (never throws): failures surface as
 * `{ type: 'error' }` events and a result with `aborted`/error content.
 */
export async function runAgent(
  options: AgentRunOptions,
): Promise<AgentRunResult> {
  const {
    url,
    authKey,
    model,
    messages,
    tools,
    onEvent,
    signal,
    maxSteps = MAX_AGENT_STEPS,
  } = options;
  const conversation: AgentMessage[] = [...messages];
  let finalContent = '';
  let aborted = false;
  let stepsSinceCheckpoint = 0;
  let checkpointsUsed = 0;

  const request: ChatRequest = {
    model,
    messages: conversation as any,
    stream: true,
  };
  (request as any).tools = tools.map(toOpenAITool);

  // eslint-disable-next-line no-constant-condition -- bounded by checkpoints + abort
  while (true) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    if (stepsSinceCheckpoint >= maxSteps) {
      if (checkpointsUsed >= MAX_AGENT_CHECKPOINTS) {
        break; // total budget exhausted — hard stop below
      }
      checkpointsUsed += 1;
      // Checkpoint: the model must report progress and either continue
      // with real work (fresh budget) or deliver the final answer. Its
      // streamed reply makes the progress report visible to the user.
      conversation.push({
        role: 'user',
        content:
          `⏸️ Step budget of ${maxSteps} tool rounds reached. Before doing anything else, briefly summarize progress (what is done, what remains — in the user's language). ` +
          'Then, if you are making real progress and not repeating the same calls, proceed with the next tool call to continue the task. ' +
          'If the task is complete or you are stuck, reply with the final answer for the user instead.',
      });
    }
    // eslint-disable-next-line no-await-in-loop -- each round depends on the previous tool results
    const result = await chatOpenAICompletion(
      url,
      { ...request, messages: conversation as any },
      (delta) => onEvent({ type: 'text', delta }),
      authKey,
      signal,
    );
    if (result === undefined) {
      aborted = !!signal?.aborted;
      const message = aborted
        ? 'aborted by user'
        : 'model request failed (HTTP error or network problem)';
      onEvent({ type: 'error', message });
      break;
    }

    const toolCalls = result.toolCalls || [];
    if (toolCalls.length === 0) {
      finalContent = result.content || '';
      break;
    }
    if (stepsSinceCheckpoint >= maxSteps) {
      // The model answered the checkpoint by continuing to work — grant a
      // fresh budget for the next stretch.
      stepsSinceCheckpoint = 0;
    } else {
      stepsSinceCheckpoint += 1;
    }

    // Keep any text emitted alongside the tool calls in the transcript
    conversation.push({
      role: 'assistant',
      ...(result.content ? { content: result.content } : {}),
      tool_calls: toolCalls.map((c) => ({
        type: 'function',
        id: c.id,
        function: { name: c.function.name, arguments: c.function.arguments },
      })),
    });

    // eslint-disable-next-line no-restricted-syntax -- tool calls run in request order
    for (const call of toolCalls) {
      if (signal?.aborted) {
        aborted = true;
        break;
      }
      onEvent({
        type: 'tool_call',
        name: call.function.name,
        args: call.function.arguments,
      });
      const tool = tools.find((t) => t.name === call.function.name);
      // eslint-disable-next-line no-await-in-loop -- sequential by protocol design
      const toolResult = await executeToolCall(tool, call.function.arguments);
      onEvent({
        type: 'tool_result',
        name: call.function.name,
        result: toolResult,
      });
      conversation.push({
        role: 'tool',
        tool_call_id: call.id,
        content: toolResult,
      });
    }
    if (aborted) {
      break;
    }
  }

  if (!finalContent && !aborted) {
    const message =
      checkpointsUsed > 0
        ? `agent stopped: step budget exhausted even after ${checkpointsUsed} checkpoint continuation(s) without a final answer`
        : `agent stopped after ${maxSteps} steps without a final answer`;
    onEvent({ type: 'error', message });
  }
  return { messages: conversation, content: finalContent, aborted };
}

/**
 * Probe whether the endpoint's model supports tool calling: a real
 * /chat/completions round-trip carrying one dummy tool. Servers/models that
 * don't support `tools` typically reject the request (HTTP 400), which makes
 * this distinguishable from a plain chat failure.
 * Returns an error message on failure, undefined on success.
 */
export async function checkAgentSupport(
  url: string,
  authKey: string | undefined,
  model: string,
): Promise<string | undefined> {
  try {
    const result = await chatOpenAICompletion(
      url,
      {
        model,
        stream: false,
        messages: [{ role: 'user', content: 'reply with ok' }],
        max_tokens: 16,
      } as any,
      undefined,
      authKey,
    );
    if (result === undefined) {
      return 'endpoint not reachable or model request failed';
    }
    // Now with a tool attached — models/servers without tool support fail here
    const withTool = await chatOpenAICompletion(
      url,
      {
        model,
        stream: false,
        messages: [{ role: 'user', content: 'what time is it?' }],
        max_tokens: 64,
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_current_time',
              description: 'returns the current local time',
              parameters: { type: 'object', properties: {}, required: [] },
            },
          },
        ],
        tool_choice: 'auto',
      } as any,
      undefined,
      authKey,
    );
    if (withTool === undefined) {
      return 'model or server rejected tool definitions (no tool calling support)';
    }
    return undefined;
  } catch (e) {
    return e?.message || String(e);
  }
}
