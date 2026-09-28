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
 * AI summary blocks for entry descriptions (DESIGN-office-ai-workflow §7.4).
 *
 * Descriptions are user-visible content: a human may have written there
 * first. The rules are:
 * - empty description → write the AI block
 * - human content without an AI block → append the AI block after it
 * - an existing AI block → replace it (update), keep everything else
 */

import { format } from 'date-fns';

export const AI_SUMMARY_MARKER = '> 🤖 AI 摘要';

export function buildAiSummaryBlock(summary: string): string {
  const today = format(new Date(), 'yyyy-MM-dd');
  const quoted = summary
    .trim()
    .split('\n')
    .map((line) => '> ' + line)
    .join('\n');
  return `${AI_SUMMARY_MARKER} ${today}：\n${quoted}`;
}

/**
 * Merge an AI summary into an existing description following the rules
 * above. Pure function — trivially unit-testable.
 */
export function applyAiSummary(existing: string, summary: string): string {
  const block = buildAiSummaryBlock(summary);
  const base = (existing || '').replace(/\s+$/, '');
  if (!base.trim()) {
    return block;
  }
  const markerIndex = base.indexOf(AI_SUMMARY_MARKER);
  if (markerIndex === -1) {
    return `${base}\n\n${block}`;
  }
  // The AI block lives at the tail (from the marker line to the end) —
  // replace it wholesale, keep the human part untouched.
  const head = base.slice(0, markerIndex).replace(/\s+$/, '');
  return head ? `${head}\n\n${block}` : block;
}
