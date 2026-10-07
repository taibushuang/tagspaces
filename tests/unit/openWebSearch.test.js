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
import { _internals } from '../../src/main/openWebSearch';

const { parseSse, pickEngines, clamp, safeJson, truncate, KNOWN_ENGINES, DEFAULT_ENGINES } =
  _internals;

describe('openWebSearch 内部纯函数', () => {
  test('parseSse 逐行解析 data:，忽略脏行', () => {
    const text = [
      'event: message',
      'data: {"result":{"content":[{"type":"text","text":"hi"}]}}',
      '',
      'data: not-json',
      '',
    ].join('\n');
    const msgs = parseSse(text);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].result.content[0].text).toBe('hi');
  });

  test('parseSse 非 SSE 的裸 JSON 也能解析', () => {
    expect(parseSse('{"a":1}')).toEqual([{ a: 1 }]);
    expect(parseSse('')).toEqual([]);
    expect(parseSse('plain text')).toEqual([]);
  });

  test('pickEngines 过滤掉服务端不支持的引擎（zhihu 这类会被整单 400 掉）', () => {
    expect(pickEngines(['zhihu'])).toEqual(DEFAULT_ENGINES);
    expect(pickEngines(['bing', 'zhihu', 'baidu'])).toEqual(['bing', 'baidu']);
    expect(pickEngines([])).toEqual(DEFAULT_ENGINES);
    expect(pickEngines(undefined)).toEqual(DEFAULT_ENGINES);
    expect(pickEngines(['Baidu'])).toEqual(['baidu']);
  });

  test('KNOWN_ENGINES 覆盖默认引擎与服务端白名单', () => {
    expect(KNOWN_ENGINES).toContain('bing');
    expect(KNOWN_ENGINES).toContain('baidu');
    expect(KNOWN_ENGINES).toContain('juejin');
    expect(DEFAULT_ENGINES.every((e) => KNOWN_ENGINES.includes(e))).toBe(true);
  });

  test('clamp 卡上下界并给默认值', () => {
    expect(clamp(undefined, 1, 50, 8)).toBe(8);
    expect(clamp(999, 1, 50, 8)).toBe(50);
    expect(clamp(-5, 1, 50, 8)).toBe(1);
    expect(clamp(12.6, 1, 50, 8)).toBe(13);
    expect(clamp(NaN, 1, 50, 8)).toBe(8);
  });

  test('truncate 到达上限才截断', () => {
    expect(truncate('abc', 10)).toBe('abc');
    const long = 'x'.repeat(30);
    expect(truncate(long, 10).startsWith('x'.repeat(10))).toBe(true);
    expect(truncate(long, 10)).toContain('30 字');
  });

  test('safeJson 只吃合法对象', () => {
    expect(safeJson('{"a":1}')).toEqual({ a: 1 });
    expect(safeJson('[1,2]')).toEqual(null);
    expect(safeJson('hi')).toEqual(null);
  });
});
