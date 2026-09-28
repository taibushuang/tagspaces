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
  AI_SUMMARY_MARKER,
  applyAiSummary,
  buildAiSummaryBlock,
} from '-/components/chat/agentDescription';

describe('agentDescription', () => {
  test('empty description → block only', () => {
    const result = applyAiSummary('', '这是摘要');
    expect(result).toBe(buildAiSummaryBlock('这是摘要'));
    expect(result).toContain(AI_SUMMARY_MARKER);
    expect(result).toContain('这是摘要');
  });

  test('human content is preserved, AI block appended', () => {
    const result = applyAiSummary(
      '人工写的说明，不要动。',
      'AI 摘要内容\n第二行',
    );
    expect(result.startsWith('人工写的说明，不要动。')).toBe(true);
    expect(result).toContain(AI_SUMMARY_MARKER);
    expect(result).toContain('> AI 摘要内容');
    expect(result).toContain('> 第二行');
  });

  test('existing AI block is replaced, human part kept', () => {
    const first = applyAiSummary('人工说明。', '旧摘要');
    const updated = applyAiSummary(first, '新摘要 更新版');
    expect(updated.startsWith('人工说明。')).toBe(true);
    expect(updated).not.toContain('旧摘要');
    expect(updated).toContain('新摘要 更新版');
    // exactly one AI marker remains
    expect(updated.split(AI_SUMMARY_MARKER).length - 1).toBe(1);
  });

  test('multi-line summary is block-quoted', () => {
    const block = buildAiSummaryBlock('一\n二\n三');
    expect(block.split('\n')).toEqual([
      expect.stringContaining(AI_SUMMARY_MARKER),
      '> 一',
      '> 二',
      '> 三',
    ]);
  });
});
