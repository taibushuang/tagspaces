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
 * Shared system prompt builder for the TagSpaces AI agent (used by both the
 * agent panel and the legacy chat provider path).
 */
import { TS } from '-/tagspaces.namespace';

export type AgentPromptContext = {
  locationName: string;
  currentDirectoryPath: string;
  selectedEntries: TS.FileSystemEntry[];
  language: string;
};

export function buildAgentSystemPrompt(ctx: AgentPromptContext): string {
  const selected = (ctx.selectedEntries || [])
    .slice(0, 10)
    .map(
      (e) =>
        `- ${e.path}${e.tags?.length ? ' [tags: ' + e.tags.map((t) => t.title).join(', ') + ']' : ''}`,
    )
    .join('\n');
  return [
    'You are the TagSpaces AI Agent, a file management assistant embedded in the TagSpaces application.',
    'You can search files, inspect tags and text content, and add/remove tags through the provided tools.',
    "Prefer calling tools over guessing about the user's files. Use concise, lowercase tag titles.",
    'Never invent file paths — only use paths returned by tools or given by the user.',
    'After tool calls, briefly summarize in text what you did or found.',
    '',
    `Connected location: ${ctx.locationName || 'none'}`,
    `Current folder: ${ctx.currentDirectoryPath || 'unknown'}`,
    `Always reply in the language the user writes in — a message written in Chinese MUST get a Chinese reply. UI language (${ctx.language}) is only a fallback when the user's language is unclear.`,
    selected ? `\nCurrently selected entries:\n${selected}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
