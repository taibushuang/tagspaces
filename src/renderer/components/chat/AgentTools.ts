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
import { applyAiSummary } from '-/components/chat/agentDescription';
import { parseSearchOperators } from '-/components/chat/searchQueryParser';
import { extractPDFcontent } from '-/services/thumbsgenerator';
import {
  extractOfficeText,
  isOfficeDocumentPath,
} from '-/services/officeTextExtractor';
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
  /** Raw bytes for binary documents (pdf / docx / pptx / xlsx). */
  readFileBytes: (path: string) => Promise<ArrayBuffer>;
  /** Absolute path of the current location root. */
  currentLocationPath: string;
  /** Move an entry into another folder of the same location (no overwrite). */
  moveFile: (sourcePath: string, targetFolderPath: string) => Promise<boolean>;
  /** Current description of an entry (empty string when none). */
  getDescription: (path: string) => Promise<string>;
  /** Persist a new description for an entry (file or folder). */
  setDescription: (
    entry: TS.FileSystemEntry,
    description: string,
  ) => Promise<boolean>;
};

const SEARCH_RESULT_LIMIT = 50;
const READ_FILE_CHAR_LIMIT = 20000;
/** Files bigger than this are refused for reading (token safety). */
const READ_FILE_MAX_BYTES = 2 * 1024 * 1024;
/**
 * Office/PDF documents carry layout noise (embedded media) but extract to
 * small text — allow a larger input ceiling than plain text files.
 */
const OFFICE_READ_MAX_BYTES = 20 * 1024 * 1024;

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
        'Preferred parameter is `query` with tscmd-style operators: ' +
        'plain words (free text, AND), "quoted phrases", +tag (must have), ' +
        '-tag (must not have), |tag (any-of group), --type:documents ' +
        '(type group: images/notes/documents/audio/video/archives/ebooks/' +
        'emails/folders/files/untagged — or comma-separated extensions ' +
        'like --type:pdf,docx). Example: "登录 +设计 -已归档 --type:pdf". ' +
        'Legacy textQuery/tags parameters still work.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'search expression with operators, e.g. "登录 +设计 -已归档 --type:pdf"',
          },
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
        const parsed = parseSearchOperators(
          String(args?.query ?? args?.textQuery ?? ''),
        );
        const legacyTags = Array.isArray(args?.tags)
          ? args.tags.map((t: any) => String(t))
          : [];
        const tagsOR = Array.from(
          new Set([...parsed.tagsOR, ...legacyTags]),
        ).map((title: string) => ({ title }));
        const results = await deps.agentSearch({
          ...(parsed.textQuery && { textQuery: parsed.textQuery }),
          ...(parsed.tagsAND.length > 0 && {
            tagsAND: parsed.tagsAND.map((title: string) => ({ title })),
          }),
          ...(tagsOR.length > 0 && { tagsOR }),
          ...(parsed.tagsNOT.length > 0 && {
            tagsNOT: parsed.tagsNOT.map((title: string) => ({ title })),
          }),
          ...(parsed.fileTypes.length > 0 && {
            fileTypes: parsed.fileTypes,
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
        'List the children (files and sub-folders) of a folder. ' +
        'Uses the current location index; omit the path for the folder ' +
        'currently open in the main view. Set recursive=true to include ' +
        'all descendants (needed for folder-wide scans).',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'absolute folder path; defaults to the current folder',
          },
          recursive: {
            type: 'boolean',
            description:
              'include all descendants of the folder, not just direct children',
          },
        },
        required: [],
      },
      execute: async (args) => {
        const folderPath = args?.path
          ? String(args.path)
          : deps.currentDirectoryPath;
        const recursive = args?.recursive === true;
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
          if (!recursive) {
            // direct children only: no further slash below the target
            return !norm(e.path.slice(target.length + 1)).includes('/');
          }
          return true;
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
        'Read the text content of a file. Supports text-based files ' +
        '(documents, markdown, code, …), PDF and Office documents ' +
        '(docx / pptx / xlsx — text is extracted, layout is not preserved). ' +
        'Large files are truncated.',
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
        const isOffice = isOfficeDocumentPath(path);
        const isPdf = path.toLowerCase().endsWith('.pdf');
        if (!isReadableTextFile(path) && !isOffice && !isPdf) {
          return {
            error: `not a supported file type; supported: text files (${AppConfig.aiSupportedFiletypes.text.join(
              ', ',
            )}), pdf, docx, pptx, xlsx`,
          };
        }
        const indexEntry = findEntryByPath(deps.getIndex(), path);
        const maxBytes =
          isOffice || isPdf ? OFFICE_READ_MAX_BYTES : READ_FILE_MAX_BYTES;
        if (indexEntry && indexEntry.size > maxBytes) {
          return {
            error: `file too large to read (${indexEntry.size} bytes)`,
          };
        }
        let content: string;
        if (isOffice) {
          const bytes = await deps.readFileBytes(path);
          content = extractOfficeText(bytes, path);
        } else if (isPdf) {
          const bytes = await deps.readFileBytes(path);
          content = await extractPDFcontent(bytes);
        } else {
          content = await deps.loadTextFile(path);
        }
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
    {
      name: 'set_description',
      description:
        'Write a summary/description for a file or folder into its ' +
        'metadata description (visible in the entry properties panel). ' +
        'Use this for "summarize this document/folder" requests instead of ' +
        'only printing the summary. Human-written description content is ' +
        'always preserved — the AI summary is stored as a marked block that ' +
        'is appended or updated, never overwriting manual notes.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'absolute path of the file or folder',
          },
          summary: {
            type: 'string',
            description:
              'the summary text (markdown allowed). Keep it concise: ' +
              'what this document/folder is about, key conclusions, ' +
              'open action items if any.',
          },
        },
        required: ['path', 'summary'],
      },
      execute: async (args) => {
        const path = requireString(args, 'path');
        const summary = requireString(args, 'summary');
        const entry = findEntryByPath(deps.getIndex(), path);
        if (!entry) {
          return {
            error: 'path not found in the current location index',
          };
        }
        let existing = '';
        try {
          existing = await deps.getDescription(path);
        } catch (e) {
          existing = '';
        }
        const finalDescription = applyAiSummary(existing, summary);
        const ok = await deps.setDescription(entry, finalDescription);
        if (!ok) {
          return { error: 'failed to save the description' };
        }
        return {
          ok: true,
          path,
          mode: existing.trim()
            ? existing.includes('🤖 AI 摘要')
              ? 'updated'
              : 'appended'
            : 'created',
          descriptionLength: finalDescription.length,
        };
      },
    },
    {
      name: 'get_description',
      description:
        'Read the current description of a file or folder. Use it to ' +
        'check whether a document already has an AI summary before ' +
        'summarizing it again, and to collect child descriptions when ' +
        'composing a folder summary.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'absolute path of the file or folder',
          },
        },
        required: ['path'],
      },
      execute: async (args) => {
        const path = requireString(args, 'path');
        let description = '';
        try {
          description = await deps.getDescription(path);
        } catch (e) {
          description = '';
        }
        return {
          path,
          hasAiSummary: description.includes('🤖 AI 摘要'),
          description,
        };
      },
    },
    {
      name: 'move_file',
      description:
        'Move a file or folder into another folder of the same location ' +
        '(filing / archiving, e.g. sorting an inbox). Never overwrites an ' +
        'existing target. Move first, then tag the moved entry.',
      parameters: {
        type: 'object',
        properties: {
          sourcePath: {
            type: 'string',
            description: 'absolute path of the file or folder to move',
          },
          targetFolder: {
            type: 'string',
            description: 'absolute path of the destination folder',
          },
        },
        required: ['sourcePath', 'targetFolder'],
      },
      execute: async (args) => {
        const sourcePath = requireString(args, 'sourcePath');
        const targetFolder = requireString(args, 'targetFolder');
        const norm = (p: string) =>
          p.replace(/[\\/]+/g, '/').replace(/\/$/, '');
        const source = norm(sourcePath);
        const target = norm(targetFolder);
        if (source === target) {
          return { error: 'source and target folder are the same' };
        }
        if (target.startsWith(`${source}/`)) {
          return { error: 'cannot move a folder into itself' };
        }
        const index = deps.getIndex();
        const entry = findEntryByPath(index, source);
        if (!entry) {
          return {
            error: 'source path not found in the current location index',
          };
        }
        const targetIsKnown =
          target === norm(deps.currentLocationPath) ||
          findEntryByPath(index, target);
        if (!targetIsKnown) {
          return {
            error: 'target folder not found in the current location index',
          };
        }
        const name = source.split('/').pop();
        if (index && index.some((e) => norm(e.path) === `${target}/${name}`)) {
          return {
            error: `an entry named "${name}" already exists in the target folder — nothing was moved`,
          };
        }
        const ok = await deps.moveFile(sourcePath, targetFolder);
        if (!ok) {
          return { error: 'the move failed (check notifications for details)' };
        }
        return {
          ok: true,
          newPath: `${target}/${name}`,
          note: 'the location index refreshes automatically after the move',
        };
      },
    },
  ];
}
