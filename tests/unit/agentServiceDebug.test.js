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
import { afterEach, beforeEach, describe, expect, test } from '@playwright/test';
import {
  runAgent,
  stripSystemMessages,
} from '-/components/chat/AgentService';
import {
  clearAgentDebugLog,
  getAgentDebugSnapshot,
} from '-/components/chat/agentDebugLog';

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

function titles() {
  return getAgentDebugSnapshot().map((entry) => entry.title);
}

describe('runAgent transcript integrity (repeat-answer regression)', () => {
  beforeEach(() => {
    clearAgentDebugLog();
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  test('final assistant answer is part of result.messages', async () => {
    global.fetch = async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"answer one"}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
    const result = await runAgent({
      url: 'http://mock.local/v1',
      model: 'mock-model',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'q1' },
      ],
      tools: [],
      onEvent: () => {},
    });
    // Before the fix the transcript ended at the user turn: the answer only
    // reached the chat bubble, so the next run's apiMessages had no assistant
    // turns and the model re-answered every earlier question.
    expect(result.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
    ]);
    expect(result.messages[2].content).toBe('answer one');
  });

  test('stripSystemMessages removes accumulated system turns', () => {
    const transcript = [
      { role: 'system', content: 'old' },
      { role: 'system', content: 'older' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'system', content: 'current' },
    ];
    expect(stripSystemMessages(transcript).map((m) => m.role)).toEqual([
      'user',
      'assistant',
    ]);
  });

  test('multi-run transcript keeps one system turn and full Q/A pairs', async () => {
    global.fetch = async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
    // run 1 — provider layer: [system, user] in, transcript stored stripped
    const run1 = await runAgent({
      url: 'http://mock.local/v1',
      model: 'mock-model',
      messages: [
        { role: 'system', content: 'sys v1' },
        { role: 'user', content: 'q1' },
      ],
      tools: [],
      onEvent: () => {},
    });
    const stored1 = stripSystemMessages(run1.messages);
    expect(stored1.map((m) => m.role)).toEqual(['user', 'assistant']);

    // run 2 — provider layer: fresh system + stored transcript + new question
    const run2 = await runAgent({
      url: 'http://mock.local/v1',
      model: 'mock-model',
      messages: [
        { role: 'system', content: 'sys v2' },
        ...stored1,
        { role: 'user', content: 'q2' },
      ],
      tools: [],
      onEvent: () => {},
    });
    // Exactly one system turn and both Q/A pairs survive in the transcript.
    const roles = run2.messages.map((m) => m.role);
    expect(roles).toEqual([
      'system',
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(
      run2.messages.filter((m) => m.role === 'user').map((m) => m.content),
    ).toEqual(['q1', 'q2']);
    expect(
      run2.messages.filter((m) => m.role === 'assistant').map((m) => m.content),
    ).toEqual(['answer', 'answer']);
    expect(
      run2.messages.filter((m) => m.role === 'system').map((m) => m.content),
    ).toEqual(['sys v2']);
  });
});

describe('runAgent debug log', () => {
  beforeEach(() => {
    clearAgentDebugLog();
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  test('records run, request and completion entries on success', async () => {
    global.fetch = async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
    const events = [];
    const result = await runAgent({
      url: 'http://mock.local/v1',
      providerName: 'MockProvider',
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      onEvent: (event) => events.push(event),
    });

    expect(result.content).toBe('hello');
    expect(events.some((event) => event.type === 'error')).toBe(false);
    const logged = titles();
    expect(logged[0]).toBe('run started · MockProvider · mock-model');
    expect(logged[1]).toBe('request #1 sent · mock-model');
    expect(logged[2]).toMatch(/^request #1 finished · /);
    expect(logged[3]).toMatch(/^run completed · /);
    expect(getAgentDebugSnapshot()[0].detail).toContain(
      'url: http://mock.local/v1',
    );
  });

  test('surfaces HTTP status, Retry-After and body in the log and event', async () => {
    global.fetch = async () =>
      new Response('{"error":{"message":"rate limit exceeded"}}', {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'retry-after': '20', 'content-type': 'application/json' },
      });
    const errors = [];
    await runAgent({
      url: 'http://mock.local/v1',
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      onEvent: (event) => {
        if (event.type === 'error') errors.push(event.message);
      },
    });

    const failed = getAgentDebugSnapshot().find((entry) =>
      entry.title.includes('request #1 failed'),
    );
    expect(failed).toBeTruthy();
    expect(failed.level).toBe('error');
    expect(failed.detail).toContain('HTTP 429');
    expect(failed.detail).toContain('retry-after: 20');
    expect(failed.detail).toContain('rate limit exceeded');
    expect(errors[0]).toContain('HTTP 429 Too Many Requests');
    expect(errors[0]).toContain('rate limit exceeded');
    expect(titles().some((title) => title.startsWith('run failed'))).toBe(true);
  });

  test('records network errors with the underlying message', async () => {
    global.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    const errors = [];
    await runAgent({
      url: 'http://mock.local/v1',
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      onEvent: (event) => {
        if (event.type === 'error') errors.push(event.message);
      },
    });

    const failed = getAgentDebugSnapshot().find((entry) =>
      entry.title.includes('request #1 failed'),
    );
    expect(failed.detail).toContain('Failed to fetch');
    expect(errors[0]).toContain('network error');
    expect(errors[0]).toContain('Failed to fetch');
  });

  test('tool failures are recorded in the debug log', async () => {
    // The first round asks for a failing tool; the second round answers with
    // plain text so the loop terminates.
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return sseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"boom","arguments":"{}"}}]}}]}\n\n',
          'data: [DONE]\n\n',
        ]);
      }
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"recovered"}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
    };
    const tools = [
      {
        name: 'boom',
        description: 'always fails',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          throw new Error('tool exploded');
        },
      },
    ];
    await runAgent({
      url: 'http://mock.local/v1',
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      tools,
      onEvent: () => {},
    });
    expect(calls).toBe(2);
    const toolFailure = getAgentDebugSnapshot().find((entry) =>
      entry.title.includes('tool boom failed'),
    );
    expect(toolFailure).toBeTruthy();
    expect(toolFailure.level).toBe('error');
    expect(toolFailure.detail).toContain('tool exploded');
    expect(titles().some((title) => title.startsWith('run completed'))).toBe(
      true,
    );
  });
});
