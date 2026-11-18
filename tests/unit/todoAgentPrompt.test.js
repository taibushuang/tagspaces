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
import { describe, expect, test } from '@playwright/test';
import { buildAgentSystemPrompt } from '-/components/chat/agentPrompt';
import { buildTodoAgentPrompt } from '-/components/todo/todoUtils';

const dict = {
  'core:todoAgentRunIntro': 'INTRO',
  'core:todoAgentRunInstruction': 'INSTRUCTION',
  'core:todoFieldTitle': 'TITLE',
  'core:todoDescription': 'DESC',
  'core:todoStatus': 'STATUS',
  'core:todoStatusOpen': 'OPEN',
  'core:todoStatusDoing': 'DOING',
  'core:todoPriority': 'PRIORITY',
  'core:todoPriorityHigh': 'HIGH',
  'core:todoPriorityMedium': 'MEDIUM',
  'core:todoPriorityLow': 'LOW',
  'core:todoProject': 'PROJECT',
  'core:todoTags': 'TAGS',
  'core:todoDueDate': 'DUE',
};
const fakeT = (key) => dict[key] ?? key;

function baseItem(overrides) {
  return {
    id: 'todo-1',
    title: 'Prepare quarterly report',
    status: 'open',
    priority: 'high',
    tags: [],
    recurrence: null,
    order: 0,
    archived: false,
    source: 'ui',
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('buildAgentSystemPrompt goal block', () => {
  const baseCtx = {
    locationName: 'Docs',
    currentDirectoryPath: 'C:/Docs',
    selectedEntries: [],
    language: 'en',
  };

  test('marks the todo as the session goal with its id', () => {
    const prompt = buildAgentSystemPrompt({
      ...baseCtx,
      goal: { kind: 'todo', todoId: 'todo-1', title: 'Prepare quarterly report' },
    });
    expect(prompt).toContain('### Session goal (hard requirement)');
    expect(prompt).toContain('Prepare quarterly report');
    expect(prompt).toContain('todo-1');
    expect(prompt).toContain('do not report success without having called todo_complete');
  });

  test('omits the goal block for ordinary sessions', () => {
    const prompt = buildAgentSystemPrompt(baseCtx);
    expect(prompt).not.toContain('Session goal (hard requirement)');
  });
});

describe('buildTodoAgentPrompt', () => {
  test('includes every populated field and the tool instructions', () => {
    const prompt = buildTodoAgentPrompt(
      baseItem({
        description: 'Collect numbers from the team',
        priority: 'high',
        project: 'Finance',
        tags: ['report', 'q4'],
        dueDate: '2026-11-20',
        dueTime: '17:00',
      }),
      fakeT,
    );
    expect(prompt.startsWith('INTRO')).toBe(true);
    expect(prompt).toContain('- TITLE: Prepare quarterly report');
    expect(prompt).toContain('- DESC: Collect numbers from the team');
    expect(prompt).toContain('- STATUS: OPEN');
    expect(prompt).toContain('- PRIORITY: HIGH');
    expect(prompt).toContain('- PROJECT: Finance');
    expect(prompt).toContain('- TAGS: report, q4');
    expect(prompt).toContain('- DUE: 2026-11-20 17:00');
    expect(prompt.endsWith('INSTRUCTION')).toBe(true);
  });

  test('omits optional lines that are not set', () => {
    const prompt = buildTodoAgentPrompt(baseItem({ priority: 'medium' }), fakeT);
    expect(prompt).toContain('- TITLE: Prepare quarterly report');
    expect(prompt).toContain('- PRIORITY: MEDIUM');
    expect(prompt).not.toContain('DESC');
    expect(prompt).not.toContain('PROJECT');
    expect(prompt).not.toContain('TAGS');
    expect(prompt).not.toContain('DUE');
  });

  test('keeps the current status (e.g. doing) in the prompt', () => {
    const prompt = buildTodoAgentPrompt(
      baseItem({ status: 'doing', priority: 'low' }),
      fakeT,
    );
    expect(prompt).toContain('- STATUS: DOING');
    expect(prompt).toContain('- PRIORITY: LOW');
  });
});
