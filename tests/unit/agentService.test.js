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
import { describe, expect, test } from '@playwright/test';
import {
  MAX_AGENT_INJECTIONS,
  drainInterruptQueue,
} from '-/components/chat/AgentService';

describe('drainInterruptQueue (step-boundary injection)', () => {
  test('empty queue drains nothing', () => {
    const conv = [];
    const queue = { pending: [], injections: 0 };
    const r = drainInterruptQueue(conv, queue, MAX_AGENT_INJECTIONS);
    expect(r.injected).toBe(0);
    expect(r.grantedBudget).toBe(false);
    expect(conv).toEqual([]);
  });

  test('single queued message is injected as a user turn', () => {
    const conv = [{ role: 'assistant', content: 'x' }];
    const queue = { pending: ['keep videos out'], injections: 0 };
    const r = drainInterruptQueue(conv, queue);
    expect(r.injected).toBe(1);
    expect(r.grantedBudget).toBe(true);
    expect(queue.injections).toBe(1);
    expect(queue.pending).toEqual([]);
    expect(conv[conv.length - 1]).toEqual({
      role: 'user',
      content: 'keep videos out',
    });
  });

  test('multiple messages keep their order', () => {
    const conv = [];
    const queue = { pending: ['a', 'b', 'c'], injections: 0 };
    const r = drainInterruptQueue(conv, queue);
    expect(r.injected).toBe(3);
    expect(r.grantedBudget).toBe(true);
    expect(conv.map((m) => m.content)).toEqual(['a', 'b', 'c']);
    expect(conv.every((m) => m.role === 'user')).toBe(true);
  });

  test('blank messages are skipped but still removed from the queue', () => {
    const conv = [];
    const queue = { pending: ['ok', '   ', '', 'fine'], injections: 0 };
    const r = drainInterruptQueue(conv, queue);
    expect(r.injected).toBe(2);
    expect(conv.map((m) => m.content)).toEqual(['ok', 'fine']);
    expect(queue.pending).toEqual([]);
  });

  test('exhausted injection budget stops granting a fresh step window', () => {
    const conv = [];
    // Already at the cap: the message is still delivered (user input must
    // never be dropped), but the run no longer resets its step budget.
    const queue = { pending: ['x'], injections: MAX_AGENT_INJECTIONS };
    const r = drainInterruptQueue(conv, queue);
    expect(r.injected).toBe(1);
    expect(r.grantedBudget).toBe(false);
    expect(queue.injections).toBe(MAX_AGENT_INJECTIONS + 1);
  });

  test('custom maxInjections is honored', () => {
    const conv = [];
    const queue = { pending: ['x'], injections: 1 };
    const r = drainInterruptQueue(conv, queue, 1);
    expect(r.injected).toBe(1);
    expect(r.grantedBudget).toBe(false);
  });
});
