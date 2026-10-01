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
  deleteCustomSkill,
  deleteCustomTool,
  executeCustomTool,
  filterEnabledTools,
  getCustomSkills,
  getCustomTools,
  getDisabledTools,
  sanitizeToolFunctionName,
  saveCustomSkill,
  saveCustomTool,
  setToolEnabled,
} from '-/components/chat/agentCapabilities';

// Node test env has no localStorage — provide a minimal in-memory stub.
if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    clear: () => mem.clear(),
  };
}

const tool = (id, name) => ({
  id,
  name,
  displayName: name,
  description: 'test tool',
  parameters: { type: 'object', properties: {} },
  endpoint: { url: 'https://example.com/hook', method: 'POST' },
  enabled: true,
});

describe('agentCapabilities', () => {
  test('sanitizeToolFunctionName produces OpenAI-safe names', () => {
    expect(sanitizeToolFunctionName('Weather 查询')).toBe('custom_Weather');
    expect(sanitizeToolFunctionName('  my tool #2 ')).toBe('custom_my_tool_2');
    expect(sanitizeToolFunctionName('数据导入')).toBe('custom_tool');
    expect(sanitizeToolFunctionName('abc')).toBe('custom_abc');
  });

  test('custom tools round-trip through storage and delete works', () => {
    expect(getCustomTools()).toEqual([]);
    saveCustomTool(tool('t1', 'custom_alpha'));
    saveCustomTool(tool('t2', 'custom_beta'));
    expect(getCustomTools().length).toBe(2);
    deleteCustomTool('t1');
    expect(getCustomTools().map((t) => t.id)).toEqual(['t2']);
  });

  test('custom skills round-trip and enabled filter works', () => {
    saveCustomSkill({ id: 's1', name: 'a', instruction: 'do a', enabled: true });
    saveCustomSkill({ id: 's2', name: 'b', instruction: 'do b', enabled: false });
    const enabled = getCustomSkills().filter((s) => s.enabled);
    expect(enabled.map((s) => s.id)).toEqual(['s1']);
    deleteCustomSkill('s1');
    deleteCustomSkill('s2');
    expect(getCustomSkills()).toEqual([]);
  });

  test('filterEnabledTools respects the disabled set', () => {
    setToolEnabled('search_files', false);
    const tools = [{ name: 'search_files' }, { name: 'add_tags' }];
    expect(filterEnabledTools(tools).map((t) => t.name)).toEqual(['add_tags']);
    setToolEnabled('search_files', true);
    expect(filterEnabledTools(tools).length).toBe(2);
    expect(getDisabledTools()).toEqual([]);
  });

  test('executeCustomTool posts args and returns response text', async () => {
    let captured;
    globalThis.fetch = async (url, init) => {
      captured = { url, init };
      return {
        ok: true,
        text: async () => JSON.stringify({ done: true }),
      };
    };
    const result = await executeCustomTool(tool('t', 'custom_x'), '{"q":1}');
    expect(JSON.parse(result)).toEqual({ done: true });
    expect(captured.url).toBe('https://example.com/hook');
    expect(JSON.parse(captured.init.body)).toEqual({ q: 1 });
  });

  test('executeCustomTool reports HTTP errors and rejects bad URLs', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
      text: async () => 'boom',
    });
    const httpError = await executeCustomTool(tool('t', 'custom_x'), '{}');
    expect(JSON.parse(httpError).error).toBe('HTTP 500');

    const bad = { ...tool('t', 'custom_x'), endpoint: { url: 'ftp://x' } };
    const badResult = await executeCustomTool(bad, '{}');
    expect(JSON.parse(badResult).error).toContain('http(s)');
  });
});
