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
import { SearchTypeGroups } from '@tagspaces/tagspaces-common/AppConfig';
import { parseSearchOperators } from '-/components/chat/searchQueryParser';

describe('parseSearchOperators', () => {
  test('plain text query', () => {
    expect(parseSearchOperators('登录模块')).toEqual({
      textQuery: '登录模块',
      tagsAND: [],
      tagsOR: [],
      tagsNOT: [],
      fileTypes: [],
    });
  });

  test('AND / NOT / OR tag operators', () => {
    const parsed = parseSearchOperators('登录 +设计 -已归档 |需求 |会议纪要');
    expect(parsed.textQuery).toBe('登录');
    expect(parsed.tagsAND).toEqual(['设计']);
    expect(parsed.tagsNOT).toEqual(['已归档']);
    expect(parsed.tagsOR).toEqual(['需求', '会议纪要']);
  });

  test('quoted phrases stay in the text query', () => {
    const parsed = parseSearchOperators('"user story" +cite');
    expect(parsed.textQuery).toBe('user story');
    expect(parsed.tagsAND).toEqual(['cite']);
  });

  test('--type:<group> resolves to the type group extensions', () => {
    const parsed = parseSearchOperators('--type:pdf,docx 报告');
    expect(parsed.fileTypes).toEqual(['pdf', 'docx']);
    expect(parsed.textQuery).toBe('报告');
  });

  test('--type group form and separated value form', () => {
    const grouped = parseSearchOperators('--type:documents');
    // extension groups expand to their extension list (engine semantics)
    expect(grouped.fileTypes).toEqual(SearchTypeGroups.documents);
    const separated = parseSearchOperators('--type images');
    expect(separated.fileTypes).toEqual(SearchTypeGroups.images);
    expect(separated.textQuery).toBe('');
  });

  test('--type special groups keep their marker value', () => {
    expect(parseSearchOperators('--type:folders').fileTypes).toEqual(['folders']);
    expect(parseSearchOperators('--type:untagged').fileTypes).toEqual([
      'untagged',
    ]);
  });

  test('XML entities in tags are decoded', () => {
    const parsed = parseSearchOperators('+R&amp;D -<draft>');
    expect(parsed.tagsAND).toEqual(['R&D']);
    expect(parsed.tagsNOT).toEqual(['<draft>']);
  });

  test('negative numbers are not parsed as NOT tags', () => {
    const parsed = parseSearchOperators('report -2024');
    expect(parsed.tagsNOT).toEqual([]);
    expect(parsed.textQuery).toBe('report -2024');
  });

  test('empty query', () => {
    expect(parseSearchOperators('')).toEqual({
      textQuery: '',
      tagsAND: [],
      tagsOR: [],
      tagsNOT: [],
      fileTypes: [],
    });
  });
});
