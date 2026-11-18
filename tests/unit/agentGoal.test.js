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
 */
import { afterEach, describe, expect, test } from '@playwright/test';
import { MAX_GOAL_NUDGES, runAgent } from '-/components/chat/AgentService';

const realFetch = global.fetch;

function sseResponse(frames) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      frames.forEach((frame) => controller.enqueue(encoder.encode(frame)));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function textFrame(text) {
  return `data: ${JSON.stringify({
    choices: [{ delta: { content: text } }],
  })}\n\n`;
}

function toolCallFrame(id, name, args) {
  return `data: ${JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id, function: { name, arguments: args } },
          ],
        },
      },
    ],
  })}\n\n`;
}

function todoCompleteTool(executed) {
  return {
    name: 'todo_complete',
    description: 'mark a todo done',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    execute: async (args) => {
      executed.push(args);
      return { ok: true, todo: { id: args.id, status: 'done' } };
    },
  };
}

afterEach(() => {
  global.fetch = realFetch;
});

describe('runAgent goal enforcement (todo sessions)', () => {
  test('nudges a run that ends without completing the goal, then stops', async () => {
    const bodies = [];
    global.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return sseResponse([textFrame('still working'), 'data: [DONE]\n\n']);
    };
    const executed = [];
    const result = await runAgent({
      url: 'http://mock.local/v1',
      model: 'mock-model',
      messages: [{ role: 'user', content: 'do the todo' }],
      tools: [todoCompleteTool(executed)],
      goalTodoId: 'todo-1',
      onEvent: () => {},
    });

    // Initial turn + MAX_GOAL_NUDGES nudges, then the model is allowed to end.
    expect(bodies.length).toBe(1 + MAX_GOAL_NUDGES);
    expect(result.goalCompleted).toBe(false);
    expect(result.aborted).toBe(false);
    expect(executed).toEqual([]);

    expect(bodies[1].messages.at(-1).content).toContain(
      'Session goal check (1/2)',
    );
    expect(bodies[1].messages.at(-1).content).toContain('todo-1');
    expect(bodies[2].messages.at(-1).content).toContain(
      `Session goal check (${MAX_GOAL_NUDGES}/${MAX_GOAL_NUDGES})`,
    );
    // The model's premature answer is preserved in the carried conversation.
    expect(bodies[1].messages.some((m) => m.content === 'still working')).toBe(
      true,
    );
    expect(result.content).toBe('still working');
  });

  test('stops nudging once todo_complete succeeds for the goal id', async () => {
    const bodies = [];
    global.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) {
        return sseResponse([
          toolCallFrame('call-1', 'todo_complete', '{"id":"todo-1"}'),
          'data: [DONE]\n\n',
        ]);
      }
      return sseResponse([textFrame('all done'), 'data: [DONE]\n\n']);
    };
    const executed = [];
    const result = await runAgent({
      url: 'http://mock.local/v1',
      model: 'mock-model',
      messages: [{ role: 'user', content: 'do the todo' }],
      tools: [todoCompleteTool(executed)],
      goalTodoId: 'todo-1',
      onEvent: () => {},
    });

    expect(bodies.length).toBe(2);
    expect(executed).toEqual([{ id: 'todo-1' }]);
    expect(result.goalCompleted).toBe(true);
    expect(result.content).toBe('all done');
    // No goal-check nudge after the completion.
    expect(
      bodies[1].messages.some((m) =>
        String(m.content).includes('Session goal check'),
      ),
    ).toBe(false);
  });

  test('does not nudge when the completion tool is unavailable', async () => {
    const bodies = [];
    global.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return sseResponse([textFrame('plain answer'), 'data: [DONE]\n\n']);
    };
    const result = await runAgent({
      url: 'http://mock.local/v1',
      model: 'mock-model',
      messages: [{ role: 'user', content: 'do the todo' }],
      tools: [],
      goalTodoId: 'todo-1',
      onEvent: () => {},
    });

    expect(bodies.length).toBe(1);
    expect(result.goalCompleted).toBe(false);
    expect(result.content).toBe('plain answer');
  });

  test('a completion for a different todo does not satisfy the goal', async () => {
    const bodies = [];
    global.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) {
        return sseResponse([
          toolCallFrame('call-1', 'todo_complete', '{"id":"todo-OTHER"}'),
          'data: [DONE]\n\n',
        ]);
      }
      return sseResponse([textFrame('done for the other one'), 'data: [DONE]\n\n']);
    };
    const executed = [];
    const result = await runAgent({
      url: 'http://mock.local/v1',
      model: 'mock-model',
      messages: [{ role: 'user', content: 'do the todo' }],
      tools: [todoCompleteTool(executed)],
      goalTodoId: 'todo-1',
      onEvent: () => {},
    });

    expect(executed).toEqual([{ id: 'todo-OTHER' }]);
    expect(result.goalCompleted).toBe(false);
    // Tool-call round + one final answer + MAX_GOAL_NUDGES.
    expect(bodies.length).toBe(2 + MAX_GOAL_NUDGES);
  });
});
