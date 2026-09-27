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
 * Tool set exposed to the AI agent. Read-only operations plus reversible tag
 * edits — deliberately NO rename/move/delete tools (see DESIGN-ai-agent.md §4).
 *
 * The factory pattern keeps this module context-free: ChatProvider wires the
 * actual TagSpaces capabilities (search, tagging, IO) into `deps` so tools
 * always operate on the user's current location/selection.
 */
import { AgentTool } from '-/components/chat/AgentService';
import AppConfig from '-/AppConfig';
import { TS } from '-/tagspaces.namespace';

export type AgentToolDeps = {
  agentSearch: (searchQuery: TS.SearchQuery) => Promise<TS.FileSystemEntry[]>;
  /** Index of the current location (may be empty if not yet built). */
  getIndex: () => TS.FileSystemEntry[] | undefined;
  currentLocationName: string;
  currentDirectoryPath: string;
  selectedEntries: TS.FileSystemEntry[];
  addTagsToFsEntry: (
    entry: TS.FileSystemEntry,
    tags: Array<TS.Tag>,
  ) => Promise<TS.FileSystemEntry>;
  removeTagsFromEntry: (
    entry: TS.FileSystemEntry,
    tags?: Array<TS.Tag>,
  ) => Promise<string>;
  loadTextFile: (path: string) => Promise<string>;
};

const SEARCH_RESULT_LIMIT = 50;
const READ_FILE_CHAR_LIMIT = 20000;
/** Files bigger than this are refused for reading (token safety). */
const READ_FILE_MAX_BYTES = 2 * 1024 * 1024;

function entryToSummary(entry: TS.FileSystemEntry) {
  return {
    name: entry.name,
    path: entry.path,
    isFile: entry.isFile,
    size: entry.size,
    ...(entry.tags && entry.tags.length > 0
      ? { tags: entry.tags.map((t) => t.title) }
      : {}),
  };
}

function findEntryByPath(
  index: TS.FileSystemEntry[] | undefined,
  path: string,
): TS.FileSystemEntry | undefined {
  if (!index) {
    return undefined;
  }
  const norm = (p: string) => p.replace(/[\\/]+/g, '/');
  const target = norm(path);
  return (
    index.find((e) => norm(e.path) === target) ||
    // tolerate missing/extra extension casing
    index.find((e) => norm(e.path).toLowerCase() === target.toLowerCase())
  );
}

function isReadableTextFile(path: string): boolean {
  const lower = path.toLowerCase();
  // extensions are stored without a leading dot (AppConfig convention)
  return AppConfig.aiSupportedFiletypes.text.some((ext) =>
    lower.endsWith(`.${ext.toLowerCase()}`),
  );
}

function requireString(args: any, field: string): string {
  const value = args?.[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`missing required string parameter: ${field}`);
  }
  return value;
}

/**
 * Build the agent tool list. All tools return plain JSON-serializable
 * objects; thrown errors are caught by the agent loop and reported to the
 * model as { error } results.
 */
export function createAgentTools(deps: AgentToolDeps): AgentTool[] {
  const scopeParam = {
    type: 'string',
    enum: ['location', 'global'],
    description:
      'location = current location only, global = all connected locations',
  };

  return [
    {
      name: 'search_files',
      description:
        'Search files and folders in the connected TagSpaces locations. ' +
        'Combines an optional free-text query with optional tag names ' +
        '(OR semantics). Returns paths that can feed other tools.',
      parameters: {
        type: 'object',
        properties: {
          textQuery: {
            type: 'string',
            description: 'free text to match in file/folder names and content',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'tag titles to match (OR)',
          },
          scope: scopeParam,
          maxResults: {
            type: 'number',
            description: `maximum results to return (1-${SEARCH_RESULT_LIMIT})`,
          },
        },
        required: [],
      },
      execute: async (args) => {
        const maxResults = Math.max(
          1,
          Math.min(
            SEARCH_RESULT_LIMIT,
            Math.round(Number(args?.maxResults) || 25),
          ),
        );
        const results = await deps.agentSearch({
          ...(args?.textQuery && { textQuery: String(args.textQuery) }),
          ...(Array.isArray(args?.tags) &&
            args.tags.length > 0 && {
              tagsOR: args.tags.map((t: any) => ({ title: String(t) })),
            }),
          searchBoxing: args?.scope === 'global' ? 'global' : 'location',
          searchType: 'fuzzy',
          maxSearchResults: maxResults,
        } as TS.SearchQuery);
        return {
          count: results.length,
          currentLocation: deps.currentLocationName,
          entries: results.map(entryToSummary),
        };
      },
    },
    {
      name: 'list_folder',
      description:
        'List the direct children (files and sub-folders) of a folder. ' +
        'Uses the current location index; omit the path for the folder ' +
        'currently open in the main view.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'absolute folder path; defaults to the current folder',
          },
        },
        required: [],
      },
      execute: async (args) => {
        const folderPath = args?.path
          ? String(args.path)
          : deps.currentDirectoryPath;
        const index = deps.getIndex();
        if (!index || index.length === 0) {
          return {
            error: 'location index is not loaded yet; use search_files instead',
          };
        }
        const norm = (p: string) =>
          p.replace(/[\\/]+/g, '/').replace(/\/$/, '');
        const target = norm(folderPath);
        const children = index.filter((e) => {
          const normalized = norm(e.path);
          if (normalized === target || !normalized.startsWith(`${target}/`)) {
            return false;
          }
          // direct children only: no further slash below the target
          return !norm(e.path.slice(target.length + 1)).includes('/');
        });
        return {
          folder: folderPath,
          count: children.length,
          entries: children.slice(0, SEARCH_RESULT_LIMIT).map(entryToSummary),
        };
      },
    },
    {
      name: 'get_entry_tags',
      description: 'Read the tags (and description) of one file or folder.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'absolute path of the entry' },
        },
        required: ['path'],
      },
      execute: async (args) => {
        const path = requireString(args, 'path');
        const entry = findEntryByPath(deps.getIndex(), path);
        if (!entry) {
          return {
            error: `entry not found in the location index: ${path}`,
          };
        }
        return {
          path: entry.path,
          tags: (entry.tags || []).map((t) => t.title),
        };
      },
    },
    {
      name: 'add_tags',
      description:
        'Add one or more tags to a file or folder. Tags are reversible ' +
        '(see remove_tags). Use tag titles like "invoice"; multi-word tags ' +
        'use dashes, e.g. "tax-2026".',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'absolute path of the entry' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'tag titles to add',
          },
        },
        required: ['path', 'tags'],
      },
      execute: async (args) => {
        const path = requireString(args, 'path');
        const tags: string[] = Array.isArray(args?.tags) ? args.tags : [];
        if (tags.length === 0) {
          throw new Error('tags array is empty');
        }
        const entry = findEntryByPath(deps.getIndex(), path);
        if (!entry) {
          return { error: `entry not found in the location index: ${path}` };
        }
        const newEntry = await deps.addTagsToFsEntry(
          entry,
          tags
            .map((t) => String(t).trim().toLowerCase().replace(/\s+/g, '-'))
            .filter(Boolean)
            .map((title) => ({ title })),
        );
        return {
          ok: true,
          path: newEntry.path,
          tags: (newEntry.tags || []).map((t) => t.title),
        };
      },
    },
    {
      name: 'remove_tags',
      description:
        'Remove one or more tags from a file or folder. Omit "tags" to ' +
        'remove all tags from the entry.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'absolute path of the entry' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'tag titles to remove; omit to remove all tags',
          },
        },
        required: ['path'],
      },
      execute: async (args) => {
        const path = requireString(args, 'path');
        const entry = findEntryByPath(deps.getIndex(), path);
        if (!entry) {
          return { error: `entry not found in the location index: ${path}` };
        }
        const tags: Array<TS.Tag> | undefined = Array.isArray(args?.tags)
          ? args.tags.map((t: any) => ({ title: String(t) }))
          : undefined;
        const newPath = await deps.removeTagsFromEntry(entry, tags);
        return { ok: true, path: newPath };
      },
    },
    {
      name: 'read_file_text',
      description:
        'Read the text content of a file (documents, markdown, code, …). ' +
        'Only text-based file types are supported; large files are truncated.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'absolute path of the file' },
          maxChars: {
            type: 'number',
            description: `maximum characters to return (default ${READ_FILE_CHAR_LIMIT})`,
          },
        },
        required: ['path'],
      },
      execute: async (args) => {
        const path = requireString(args, 'path');
        if (!isReadableTextFile(path)) {
          return {
            error: `not a supported text file type; supported: ${AppConfig.aiSupportedFiletypes.text.join(
              ', ',
            )}`,
          };
        }
        const indexEntry = findEntryByPath(deps.getIndex(), path);
        if (indexEntry && indexEntry.size > READ_FILE_MAX_BYTES) {
          return {
            error: `file too large to read (${indexEntry.size} bytes)`,
          };
        }
        const content = await deps.loadTextFile(path);
        const maxChars = Math.max(
          1,
          Math.min(
            READ_FILE_CHAR_LIMIT,
            Math.round(Number(args?.maxChars) || READ_FILE_CHAR_LIMIT),
          ),
        );
        return {
          path,
          truncated: content.length > maxChars,
          content: content.slice(0, maxChars),
        };
      },
    },
  ];
}
