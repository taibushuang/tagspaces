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
import { beforeEach, describe, expect, test } from '@playwright/test';
import {
  MAX_AGENT_DEBUG_ENTRIES,
  clearAgentDebugLog,
  formatAgentDebugLog,
  formatElapsed,
  getAgentDebugSnapshot,
  logAgentDebug,
  subscribeAgentDebugLog,
} from '-/components/chat/agentDebugLog';
import {
  createRequestIdleGuard,
  describeRequestFailure,
  failureToUserMessage,
  httpFailureFromResponse,
  readResponseErrorBody,
} from '-/components/chat/agentRequestGuard';

describe('agentDebugLog', () => {
  beforeEach(() => {
    clearAgentDebugLog();
  });

  test('appends entries and notifies subscribers', () => {
    let notifications = 0;
    const unsubscribe = subscribeAgentDebugLog(() => {
      notifications += 1;
    });
    logAgentDebug('info', 'run started');
    logAgentDebug('error', 'request failed', 'HTTP 429');
    const entries = getAgentDebugSnapshot();
    expect(entries.length).toBe(2);
    expect(entries[0].title).toBe('run started');
    expect(entries[1].level).toBe('error');
    expect(entries[1].detail).toBe('HTTP 429');
    expect(notifications).toBe(2);
    unsubscribe();
  });

  test('snapshot reference changes only on append/clear', () => {
    const before = getAgentDebugSnapshot();
    expect(getAgentDebugSnapshot()).toBe(before);
    logAgentDebug('info', 'x');
    const after = getAgentDebugSnapshot();
    expect(after).not.toBe(before);
    expect(getAgentDebugSnapshot()).toBe(after);
  });

  test('ring buffer drops the oldest entries', () => {
    for (let i = 0; i < MAX_AGENT_DEBUG_ENTRIES + 5; i += 1) {
      logAgentDebug('info', 'entry ' + i);
    }
    const entries = getAgentDebugSnapshot();
    expect(entries.length).toBe(MAX_AGENT_DEBUG_ENTRIES);
    expect(entries[0].title).toBe('entry 5');
  });

  test('detail is capped at 4000 chars', () => {
    logAgentDebug('error', 'big', 'x'.repeat(5000));
    expect(getAgentDebugSnapshot()[0].detail.length).toBe(4000);
  });

  test('clear empties the log and notifies', () => {
    logAgentDebug('info', 'x');
    let notified = 0;
    const unsubscribe = subscribeAgentDebugLog(() => {
      notified += 1;
    });
    clearAgentDebugLog();
    expect(getAgentDebugSnapshot()).toEqual([]);
    expect(notified).toBe(1);
    unsubscribe();
  });

  test('formatAgentDebugLog renders timestamps, levels and indented details', () => {
    logAgentDebug('error', 'request #1 failed', 'HTTP 429\nrate limited');
    const text = formatAgentDebugLog(getAgentDebugSnapshot());
    expect(text).toContain('[ERROR] request #1 failed');
    expect(text).toContain('\n    HTTP 429\n    rate limited');
  });

  test('formatElapsed switches to minutes', () => {
    expect(formatElapsed(5_000)).toBe('5s');
    expect(formatElapsed(65_000)).toBe('1m 5s');
  });
});

describe('agentRequestGuard', () => {
  test('aborts when no data arrives within the idle window', async () => {
    const guard = createRequestIdleGuard(undefined, 40);
    await new Promise((resolve) => {
      guard.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    expect(guard.timedOut()).toBe(true);
    guard.dispose();
  });

  test('reset restarts the idle window', async () => {
    const guard = createRequestIdleGuard(undefined, 40);
    await new Promise((resolve) => setTimeout(resolve, 25));
    guard.reset();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(guard.timedOut()).toBe(false);
    guard.dispose();
  });

  test('forwards the caller abort signal', async () => {
    const caller = new AbortController();
    const guard = createRequestIdleGuard(caller.signal, 5_000);
    caller.abort();
    expect(guard.signal.aborted).toBe(true);
    expect(guard.callerAborted()).toBe(true);
    expect(guard.timedOut()).toBe(false);
    guard.dispose();
  });

  test('classifies user abort, timeout and network errors differently', () => {
    const guard = createRequestIdleGuard(undefined, 60_000);
    guard.dispose();
    expect(describeRequestFailure(new Error('Failed to fetch'), guard).kind).toBe(
      'network',
    );

    const caller = new AbortController();
    const abortedGuard = createRequestIdleGuard(caller.signal, 60_000);
    caller.abort();
    expect(
      describeRequestFailure(new Error('aborted'), abortedGuard).kind,
    ).toBe('aborted');
    abortedGuard.dispose();

    const timedOutGuard = createRequestIdleGuard(undefined, 1);
    timedOutGuard.dispose();
    const timeoutFailure = {
      kind: 'timeout',
      message: `no data from the model for 60s`,
    };
    expect(
      describeRequestFailure(undefined, {
        ...timedOutGuard,
        timedOut: () => true,
      }).kind,
    ).toBe('timeout');
    expect(failureToUserMessage(timeoutFailure)).toContain('request timed out');
  });

  test('HTTP failures keep status, Retry-After and body', async () => {
    const response = new Response('rate limited', {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'retry-after': '30' },
    });
    const body = await readResponseErrorBody(response);
    const failure = httpFailureFromResponse(response, body);
    expect(failure.kind).toBe('http');
    expect(failure.status).toBe(429);
    expect(failure.message).toBe('HTTP 429 Too Many Requests');
    expect(failure.detail).toContain('retry-after: 30');
    expect(failure.detail).toContain('rate limited');
    expect(failureToUserMessage(failure)).toContain('HTTP 429');
  });
});
