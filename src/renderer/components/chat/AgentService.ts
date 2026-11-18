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
 * `role:'tool'` results → repeat until the model answers with plain text.
 * No step budget: the loop runs until the model delivers its final answer,
 * the user aborts, or the request fails. Deliberately framework-free — the
 * provider abstraction already lives in AiClient/OpenAIClient.
 */
import { ChatRequest } from 'ollama';
import { chatOpenAICompletion } from '-/components/chat/OpenAIClient';
import { chatGatewayCompletion } from '-/components/chat/LlmGatewayClient';
import { logAgentDebug } from '-/components/chat/agentDebugLog';
import {
  ModelCallFailure,
  failureToUserMessage,
} from '-/components/chat/agentRequestGuard';
import type { AIProviders } from '-/components/chat/ChatTypes';

export type AgentTool = {
  name: string;
  description: string;
  /** JSON Schema for the `parameters` object (OpenAI function format). */
  parameters: Record<string, any>;
  execute: (args: any) => Promise<any>;
};

export type AgentEvent =
  | { type: 'text'; delta: string }
  // Chain-of-thought deltas (e.g. DeepSeek reasoning_content) — streamed so
  // the panel can render a "thinking" section when the user enables it.
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call'; name: string; args: string }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'error'; message: string }
  // Emitted after a step-boundary drain actually injected messages; the panel
  // clears its queued-count indicator on it (drain removes everything in one
  // pass, so there is no meaningful "remaining" count to carry).
  | { type: 'interrupt_drained' };

export type AgentMessage = Record<string, any>;

/**
 * Defect-evidence snapshot: the most recent failed agent tool call (either a
 * thrown error or a result carrying { error }). report_issue attaches it to
 * bug reports as environment context for developers. Kept module-level — it
 * survives across runs and is best-effort (never blocks the loop).
 */
export type FailedToolCall = {
  tool: string;
  args?: string;
  error: string;
  at: number;
};

let lastFailedToolCall: FailedToolCall | undefined;

export function getLastFailedToolCall(): FailedToolCall | undefined {
  return lastFailedToolCall;
}

function recordFailedToolCall(
  toolName: string,
  args: string | undefined,
  error: string,
): void {
  lastFailedToolCall = {
    tool: toolName,
    ...(args && { args: args.slice(0, 500) }),
    error: String(error).slice(0, 1000),
    at: Date.now(),
  };
}

/**
 * Shared channel for step-boundary injection. The renderer pushes user
 * messages typed while the agent is running into `pending`; `runAgent`
 * drains them into the conversation at each step boundary (right before the
 * next model round-trip), so the model sees the new instruction immediately
 * without waiting for the whole run to finish. `injections` counts how many
 * have been delivered this run (budget guard against endless feeding).
 */
export type AgentInterruptQueue = {
  pending: string[];
  injections: number;
};

/**
 * Upper bound on how many step-boundary injections are delivered in one run.
 * Guards against endless feeding of new instructions into a running task;
 * queued messages beyond the cap are folded into a follow-up run instead.
 */
export const MAX_AGENT_INJECTIONS = 4;
/**
 * How many times a goal-driven run (todo session) may be nudged to keep working
 * after the model ends its turn without completing the goal. Bounded so a model
 * that genuinely cannot finish (or ignores the nudge) still terminates.
 */
export const MAX_GOAL_NUDGES = 2;
/** Tool results longer than this get truncated before going back to the model. */
export const TOOL_RESULT_CHAR_LIMIT = 4000;

export type AgentRunOptions = {
  url: string;
  authKey?: string;
  /** Provider display name, recorded in the debug log only. */
  providerName?: string;
  /** Provider engine — selects the wire protocol (see completionEngine). */
  engine?: AIProviders;
  model: string;
  messages: AgentMessage[];
  tools: AgentTool[];
  onEvent: (event: AgentEvent) => void;
  signal?: AbortSignal;
  /** Step-boundary injection channel (see AgentInterruptQueue). */
  interruptQueue?: AgentInterruptQueue;
  maxInjections?: number;
  /**
   * Todo id this session must complete. When set and the todo_complete tool is
   * available, a turn that ends without a successful completion for this id is
   * answered with a bounded "keep going / state the blocker" nudge instead of
   * ending the run (see MAX_GOAL_NUDGES).
   */
  goalTodoId?: string;
};

export type AgentRunResult = {
  messages: AgentMessage[];
  content: string;
  aborted: boolean;
  /** True once a successful todo_complete for `goalTodoId` ran in this run. */
  goalCompleted: boolean;
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

export type DrainInterruptResult = {
  injected: number;
  /** True when this drain delivered at least one message and the injection
   * budget allows granting a fresh step window to the new instruction. */
  grantedBudget: boolean;
};

/**
 * Pure drain of a step-boundary injection queue: moves every pending user
 * message into the conversation as a `role:'user'` turn and counts it toward
 * the run's injection budget. Called by `runAgent` at each step boundary and
 * unit-testable without an endpoint.
 */
export function drainInterruptQueue(
  conversation: AgentMessage[],
  queue: AgentInterruptQueue,
  maxInjections: number = MAX_AGENT_INJECTIONS,
): DrainInterruptResult {
  let injected = 0;
  while (queue.pending.length > 0) {
    const content = queue.pending.shift();
    if (content && content.trim()) {
      conversation.push({ role: 'user', content });
      queue.injections += 1;
      injected += 1;
    }
  }
  return {
    injected,
    grantedBudget: injected > 0 && queue.injections <= maxInjections,
  };
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
    const serialized = truncate(
      JSON.stringify(result ?? { ok: true }),
      TOOL_RESULT_CHAR_LIMIT,
    );
    // A result carrying { error } is a soft failure — record it too, so a
    // subsequent report_issue can attach the evidence automatically.
    try {
      const parsed = JSON.parse(serialized);
      if (parsed && typeof parsed === 'object' && parsed.error) {
        recordFailedToolCall(tool.name, rawArgs, parsed.error);
        logAgentDebug(
          'warn',
          `tool ${tool.name} returned an error`,
          (rawArgs ? `args: ${rawArgs}\n` : '') +
            String(parsed.error).slice(0, 2000),
        );
      }
    } catch {
      // non-JSON result — nothing to record
    }
    return serialized;
  } catch (e) {
    // Tool errors go back to the model so it can explain/recover instead of
    // crashing the whole run.
    console.error(`agent tool ${tool.name} failed`, e);
    recordFailedToolCall(tool.name, rawArgs, e?.message || String(e));
    logAgentDebug(
      'error',
      `tool ${tool.name} failed`,
      (rawArgs ? `args: ${rawArgs}\n` : '') +
        (e?.stack || e?.message || String(e)).slice(0, 2000),
    );
    return JSON.stringify({ error: e?.message || String(e) });
  }
}

/**
 * True when this tool call successfully completed the session's goal todo:
 * name must be todo_complete, its id argument must match the goal, and the
 * tool result must not carry an `error`.
 */
function isGoalCompletion(
  toolName: string,
  rawArgs: string,
  toolResult: string,
  goalTodoId: string,
): boolean {
  if (toolName !== 'todo_complete') {
    return false;
  }
  try {
    const args = JSON.parse(rawArgs || '{}');
    if (args?.id !== goalTodoId) {
      return false;
    }
    const result = JSON.parse(toolResult || '{}');
    return !result?.error;
  } catch {
    return false;
  }
}

/**
 * Nudge appended as a user turn when the model ends its turn without
 * completing the session goal. Keeps the todo as the single objective while
 * still giving the model a legitimate exit when it is truly blocked.
 */
function buildGoalNudge(todoId: string, attempt: number): string {
  return [
    `Session goal check (${attempt}/${MAX_GOAL_NUDGES}): todo ${todoId} is still not marked done.`,
    `This todo is the final goal of this session — continue working on it with tools.`,
    `If the task is actually finished, call todo_complete with id "${todoId}" now.`,
    `If you are genuinely blocked (missing information, permissions or user decision),`,
    `state exactly what blocks you and what the user must do. Do not stop silently.`,
  ].join(' ');
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
    engine,
    providerName,
    model,
    messages,
    tools,
    onEvent,
    signal,
    interruptQueue,
    maxInjections = MAX_AGENT_INJECTIONS,
    goalTodoId,
  } = options;
  const conversation: AgentMessage[] = [...messages];
  let finalContent = '';
  let aborted = false;
  let runFailure = '';
  let goalCompleted = false;
  let goalNudges = 0;
  // Enforcement needs a tool-calling engine and the completion tool; gateway
  // runs (no tools) and runs without the todo tools fall back to prompt-only.
  const canEnforceGoal =
    !!goalTodoId &&
    engine !== 'llm-gateway' &&
    tools.some((t) => t.name === 'todo_complete');
  let step = 0;
  const runStartedAt = Date.now();
  logAgentDebug(
    'info',
    `run started · ${providerName || 'agent'} · ${model}`,
    `engine: ${engine || 'openai-compatible'}\nurl: ${url}\ntools: ${
      tools.length
    }\nmessages: ${messages.length}`,
  );

  const request: ChatRequest = {
    model,
    messages: conversation as any,
    stream: true,
  };
  (request as any).tools = tools.map(toOpenAITool);

  // Wire-protocol dispatch: the CCB subsidiary gateway speaks its own
  // message/session protocol and has no tool-calling support — runs on it
  // degrade to plain chat (tool_calls never come back).
  const completion =
    engine === 'llm-gateway' ? chatGatewayCompletion : chatOpenAICompletion;

  // eslint-disable-next-line no-constant-condition -- bounded by abort / final answer / request failure
  while (true) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    // Step-boundary injection: drain user messages queued while the agent
    // was working before the next model round-trip, so the model reacts to
    // the new instruction immediately.
    if (interruptQueue) {
      const { injected } = drainInterruptQueue(
        conversation,
        interruptQueue,
        maxInjections,
      );
      if (injected > 0) {
        onEvent({ type: 'interrupt_drained' });
      }
    }
    step += 1;
    let callFailure: ModelCallFailure | undefined;
    const requestStartedAt = Date.now();
    logAgentDebug(
      'info',
      `request #${step} sent · ${model}`,
      `messages: ${conversation.length}, tools: ${tools.length}, stream: true`,
    );
    // eslint-disable-next-line no-await-in-loop -- each round depends on the previous tool results
    const result = await completion(
      url,
      { ...request, messages: conversation as any },
      (delta) => onEvent({ type: 'text', delta }),
      authKey,
      signal,
      (delta) => onEvent({ type: 'reasoning', delta }),
      (failure) => {
        callFailure = failure;
      },
    );
    const requestElapsed = `${((Date.now() - requestStartedAt) / 1000).toFixed(
      1,
    )}s`;
    if (result === undefined) {
      aborted = !!signal?.aborted;
      const message = aborted
        ? 'aborted by user'
        : failureToUserMessage(callFailure);
      runFailure = message;
      logAgentDebug(
        aborted ? 'warn' : 'error',
        `request #${step} ${aborted ? 'aborted' : 'failed'} · ${requestElapsed}`,
        [callFailure?.message, callFailure?.detail]
          .filter(Boolean)
          .join('\n') || message,
      );
      onEvent({ type: 'error', message });
      break;
    }
    logAgentDebug(
      'info',
      `request #${step} finished · ${requestElapsed}`,
      `content: ${result.content?.length || 0} chars, tool calls: ${
        result.toolCalls?.length || 0
      }`,
    );

    const toolCalls = result.toolCalls || [];
    if (toolCalls.length === 0) {
      const answer = result.content || '';
      if (canEnforceGoal && !goalCompleted && goalNudges < MAX_GOAL_NUDGES) {
        // The model ended its turn but the session goal is not done: feed its
        // answer plus an explicit goal-check turn and keep the loop alive.
        goalNudges += 1;
        conversation.push({
          role: 'assistant',
          ...(answer ? { content: answer } : {}),
        });
        conversation.push({
          role: 'user',
          content: buildGoalNudge(goalTodoId as string, goalNudges),
        });
        logAgentDebug(
          'warn',
          `goal check #${goalNudges} · todo ${goalTodoId} still open`,
          `model ended turn without todo_complete; continuing`,
        );
        // eslint-disable-next-line no-continue -- next round asks the model to act on the goal
        continue;
      }
      finalContent = answer;
      break;
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
      if (
        goalTodoId &&
        isGoalCompletion(
          call.function.name,
          call.function.arguments,
          toolResult,
          goalTodoId,
        )
      ) {
        goalCompleted = true;
        logAgentDebug(
          'info',
          `goal completed · todo ${goalTodoId}`,
          'todo_complete succeeded',
        );
      }
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

  let outcome: 'completed' | 'failed' | 'aborted' = 'completed';
  if (runFailure) {
    outcome = 'failed';
  } else if (aborted) {
    outcome = 'aborted';
  }
  let level: 'info' | 'warn' | 'error' = 'info';
  if (runFailure) {
    level = 'error';
  } else if (aborted) {
    level = 'warn';
  }
  logAgentDebug(
    level,
    `run ${outcome} · ${((Date.now() - runStartedAt) / 1000).toFixed(1)}s`,
    runFailure || `steps: ${step}, messages: ${conversation.length}`,
  );
  return {
    messages: conversation,
    content: finalContent,
    aborted,
    goalCompleted,
  };
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
