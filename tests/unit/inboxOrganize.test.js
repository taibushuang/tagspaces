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
import { describe, expect, test, beforeAll, beforeEach } from '@playwright/test';
import {
  getInboxLastOrganized,
  inboxLastOrganizedMs,
  markInboxOrganized,
  newEntriesSince,
} from '-/utils/inboxOrganize';

let store = {};
beforeAll(() => {
  globalThis.window = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = String(v);
      },
    },
  };
});
beforeEach(() => {
  store = {};
});

const file = (name, lmdt) => ({ name, path: '/inbox/' + name, isFile: true, lmdt });

describe('inboxOrganize 标记', () => {
  test('markInboxOrganized 写入并可读回', () => {
    const at = markInboxOrganized('/inbox/Downloads');
    expect(getInboxLastOrganized()['/inbox/Downloads']).toBe(at);
    expect(inboxLastOrganizedMs('/inbox/Downloads')).toBe(Date.parse(at));
  });

  test('再次整理覆盖旧标记', () => {
    markInboxOrganized('/inbox/Downloads');
    const first = inboxLastOrganizedMs('/inbox/Downloads');
    const at2 = markInboxOrganized('/inbox/Downloads');
    expect(inboxLastOrganizedMs('/inbox/Downloads')).toBeGreaterThanOrEqual(first);
    expect(getInboxLastOrganized()['/inbox/Downloads']).toBe(at2);
  });

  test('未整理过返回 0', () => {
    expect(inboxLastOrganizedMs('/inbox/never')).toBe(0);
  });

  test('超过上限裁剪最旧（保留最近 50 个）', () => {
    for (let i = 0; i < 55; i += 1) {
      markInboxOrganized('/inbox/p' + i);
    }
    const keys = Object.keys(getInboxLastOrganized());
    expect(keys).toHaveLength(50);
    expect(keys).not.toContain('/inbox/p0');
    expect(keys).toContain('/inbox/p54');
  });
});

describe('newEntriesSince', () => {
  test('lmdt 严格大于阈值才算新文件（等值不算）', () => {
    const entries = [file('a.pdf', 100), file('b.pdf', 101)];
    expect(newEntriesSince(entries, 100)).toHaveLength(1);
    expect(newEntriesSince(entries, 100)[0].name).toBe('b.pdf');
    expect(newEntriesSince(entries, 101)).toHaveLength(0);
  });

  test('只算文件，文件夹不算', () => {
    const entries = [
      file('a.pdf', 200),
      { name: 'folder', path: '/inbox/folder', isFile: false, lmdt: 300 },
    ];
    expect(newEntriesSince(entries, 0)).toHaveLength(1);
  });

  test('跳过隐藏/系统名（.DS_Store / desktop.ini / 点开头）', () => {
    const entries = [
      file('.DS_Store', 999),
      file('desktop.ini', 999),
      file('.hidden.pdf', 999),
      file('real.pdf', 999),
    ];
    expect(newEntriesSince(entries, 0)).toHaveLength(1);
    expect(newEntriesSince(entries, 0)[0].name).toBe('real.pdf');
  });

  test('非法输入返回空数组', () => {
    expect(newEntriesSince(undefined, 0)).toEqual([]);
    expect(newEntriesSince(null, 0)).toEqual([]);
  });
});
