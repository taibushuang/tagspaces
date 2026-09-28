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
 * Verification for TODO-ai-capabilities #6: Chinese full-text search recall
 * on the current engine baseline (tagspaces-search with CJK tokenizer).
 * The agent's search_files rides on this engine, so a pass here means
 * Chinese document content is retrievable by the agent.
 */
import { describe, expect, test } from '@playwright/test';
import { searchLocationIndex } from '@tagspaces/tagspaces-search';

const ENTRIES = [
  {
    name: '需求v3.docx',
    path: '/工作库/项目/CRM升级/需求v3.docx',
    isFile: true,
    size: 12000,
    extension: 'docx',
    textContent:
      '本需求文档描述了CRM升级项目的登录模块改造要求，包括单点登录与多因素认证。',
    tags: [{ title: '需求' }],
  },
  {
    name: '气候政策报告.pdf',
    path: '/工作库/知识库/气候政策报告.pdf',
    isFile: true,
    size: 800000,
    extension: 'pdf',
    textContent:
      '本报告分析了2026年气候政策的最新变化，重点讨论碳交易机制与排放标准。',
    tags: [{ title: '已归档' }],
  },
  {
    name: 'meeting-notes.md',
    path: '/工作库/项目/CRM升级/meeting-notes.md',
    isFile: true,
    size: 3000,
    extension: 'md',
    textContent: 'Quarterly review of the CRM upgrade project milestones.',
    tags: [{ title: '会议纪要' }],
  },
  {
    name: '测试用例.xlsx',
    path: '/工作库/知识库/测试用例.xlsx',
    isFile: true,
    size: 50000,
    extension: 'xlsx',
    textContent: '功能测试用例集合，覆盖登录、权限与报表模块。',
    tags: [],
  },
];

function search(entries, searchQuery) {
  return searchLocationIndex(entries, {
    searchType: 'fuzzy',
    maxSearchResults: 50,
    searchBoxing: 'location',
    ...searchQuery,
  });
}

describe('CJK full-text search (TODO #6)', () => {
  test('multi-char Chinese content query recalls the right document', async () => {
    const results = await search(ENTRIES, { textQuery: '气候政策' });
    expect(results.some((e) => e.name === '气候政策报告.pdf')).toBe(true);
    expect(results.some((e) => e.name === 'meeting-notes.md')).toBe(false);
  });

  test('partial Chinese term (single word) still matches', async () => {
    const results = await search(ENTRIES, { textQuery: '登录' });
    expect(results.some((e) => e.name === '需求v3.docx')).toBe(true);
    expect(results.some((e) => e.name === '测试用例.xlsx')).toBe(true);
  });

  test('Chinese filename is found', async () => {
    const results = await search(ENTRIES, { textQuery: '测试用例' });
    expect(results.some((e) => e.name === '测试用例.xlsx')).toBe(true);
  });

  test('Chinese tag combined with text via tagsAND', async () => {
    const results = await search(ENTRIES, {
      textQuery: 'CRM',
      tagsAND: [{ title: '需求' }],
    });
    expect(results.some((e) => e.name === '需求v3.docx')).toBe(true);
    expect(results.some((e) => e.name === 'meeting-notes.md')).toBe(false);
  });

  test('English query does not lose precision', async () => {
    const results = await search(ENTRIES, { textQuery: 'milestones' });
    expect(results.some((e) => e.name === 'meeting-notes.md')).toBe(true);
  });
});
