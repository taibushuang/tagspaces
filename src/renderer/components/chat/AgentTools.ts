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
import {
  executeCustomTool,
  filterEnabledTools,
  getCustomTools,
  getDisabledTools,
} from '-/components/chat/agentCapabilities';
import {
  AI_SUMMARY_MARKER,
  applyAiSummary,
  isSummaryStale,
} from '-/components/chat/agentDescription';
import { parseSearchOperators } from '-/components/chat/searchQueryParser';
import { extractPDFcontent } from '-/services/thumbsgenerator';
import {
  extractOfficeText,
  isOfficeDocumentPath,
} from '-/services/officeTextExtractor';
import AppConfig from '-/AppConfig';
import { TS } from '-/tagspaces.namespace';
import todoApi from '-/components/todo/todoService';
import { TodoItem } from '-/components/todo/todoTypes';

export type AgentToolDeps = {
  agentSearch: (searchQuery: TS.SearchQuery) => Promise<TS.FileSystemEntry[]>;
  /** Index of the current location (may be empty if not yet built). */
  getIndex: () => TS.FileSystemEntry[] | undefined;
  /**
   * Resolve one path to an entry — in-memory index first, on-disk index
   * fallback (same source as agentSearch). Tools MUST use this instead of
   * scanning getIndex() directly, otherwise paths returned by search_files
   * are unresolvable while the interactive index is not loaded.
   */
  findEntry: (path: string) => Promise<TS.FileSystemEntry | undefined>;
  /** Children of any folder in any connected location. */
  listChildren: (
    path: string,
    recursive?: boolean,
  ) => Promise<TS.FileSystemEntry[]>;
  /** Connected locations (name + path) — lets the agent work globally. */
  listLocations: () => Array<{ name: string; path: string }>;
  /** Per-folder knowledge base in `<location>/.ts/ai/kb/`. */
  kbList: (
    locationPath?: string,
  ) => Promise<
    Array<{ id: string; title: string; excerpt: string; updatedAt: number }>
  >;
  kbRead: (id: string, locationPath?: string) => Promise<string>;
  kbWrite: (
    title: string,
    content: string,
    locationPath?: string,
  ) => Promise<{ id: string; path: string }>;
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
  /** Create/overwrite a text file. Rejects on IO errors; honors overwrite. */
  writeTextFile: (
    path: string,
    content: string,
    overwrite: boolean,
  ) => Promise<void>;
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

/**
 * Folder-scan variant: includes the current description plus incremental
 * staleness so the agent can compose hierarchical folder summaries and
 * skip fresh summaries in one listing call (DESIGN-office-ai-workflow §7).
 * An entry can be skipped only when hasAiSummary && !summaryStale.
 */
function entryToScanSummary(entry: TS.FileSystemEntry) {
  const description = entry.meta?.description || '';
  return {
    ...entryToSummary(entry),
    hasAiSummary: description.includes(AI_SUMMARY_MARKER),
    summaryStale: isSummaryStale(description, entry.lmdt),
    description,
  };
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

const TODO_STATUSES = ['open', 'doing', 'done'];
const TODO_PRIORITIES = ['high', 'medium', 'low'];
const TODO_UNAVAILABLE =
  'todo tools are only available in the desktop app (todo data is stored on the main process)';

function isTodoAvailable(): boolean {
  return typeof window !== 'undefined' && !!(window as any).electronIO;
}

/** Compact, token-safe view of a todo item for the agent loop. */
function todoToSummary(item: TodoItem) {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    priority: item.priority,
    ...(item.dueDate ? { dueDate: item.dueDate } : {}),
    ...(item.project ? { project: item.project } : {}),
    ...(item.tags.length > 0 ? { tags: item.tags } : {}),
  };
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

  const tools: AgentTool[] = [
    {
      name: 'list_locations',
      description:
        'List the connected TagSpaces locations (name + absolute path). ' +
        'Call this first when no specific folder is open: it shows which ' +
        'folders on this machine you can search and organize. Files can be ' +
        'moved only within one location (folder), never across locations.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        const locations = deps.listLocations();
        return {
          count: locations.length,
          locations: locations.map((l) => ({ name: l.name, path: l.path })),
          note: 'organize within each location; moving across locations is not supported',
        };
      },
    },
    {
      name: 'search_knowledge_base',
      description:
        'Search the per-folder knowledge base stored in `<location>/.ts/ai/kb/`. ' +
        'Returns matching entries (id, title, excerpt). Omit query to list all ' +
        'entries. Use read_knowledge_entry for full content and ' +
        'write_knowledge_entry to record results (e.g. after organizing a ' +
        'folder, write an organizing record).',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'keyword to filter entries by title or content',
          },
          locationPath: {
            type: 'string',
            description:
              'absolute location path; defaults to the current location',
          },
        },
        required: [],
      },
      execute: async (args) => {
        const entries = await deps.kbList(args?.locationPath);
        const query = String(args?.query || '')
          .trim()
          .toLowerCase();
        const filtered = query
          ? entries.filter(
              (e) =>
                e.title.toLowerCase().includes(query) ||
                e.excerpt.toLowerCase().includes(query),
            )
          : entries;
        return { count: filtered.length, entries: filtered };
      },
    },
    {
      name: 'read_knowledge_entry',
      description:
        'Read the full content of one knowledge base entry (markdown). ' +
        'Get ids from search_knowledge_base.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'entry id (file name)' },
          locationPath: {
            type: 'string',
            description:
              'absolute location path; defaults to the current location',
          },
        },
        required: ['id'],
      },
      execute: async (args) => {
        const id = requireString(args, 'id');
        try {
          const content = await deps.kbRead(id, args?.locationPath);
          return { id, content, truncated: content.length >= 8000 };
        } catch (e: any) {
          return { error: e?.message || String(e) };
        }
      },
    },
    {
      name: 'write_knowledge_entry',
      description:
        'Write a markdown entry into the folder knowledge base ' +
        '(<location>/.ts/ai/kb/). Use it to persist organizing records, ' +
        'summaries of folder structure, or reusable rules discovered while ' +
        'working. An existing file is never overwritten — a numbered variant ' +
        'is created instead. Built-in articles cannot be written this way.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'entry title (becomes the # heading and file name)',
          },
          content: {
            type: 'string',
            description: 'markdown body (below the title heading)',
          },
          locationPath: {
            type: 'string',
            description:
              'absolute location path; defaults to the current location',
          },
        },
        required: ['title', 'content'],
      },
      execute: async (args) => {
        const title = requireString(args, 'title');
        const content = requireString(args, 'content');
        try {
          const saved = await deps.kbWrite(title, content, args?.locationPath);
          return { ok: true, ...saved };
        } catch (e: any) {
          return { error: e?.message || String(e) };
        }
      },
    },
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
        'List the children (files and sub-folders) of a folder. Each entry ' +
        'carries its current description plus hasAiSummary/summaryStale — ' +
        'skip entries where hasAiSummary is true AND summaryStale is false ' +
        '(capped at 50 entries; truncated=true means the folder is very ' +
        'large — prefer a separate summary note). ' +
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
          // The interactive index is not loaded — fall back to the on-disk
          // index of the owning location (works for any connected folder,
          // even when no location is currently open).
          const children = await deps.listChildren(folderPath, recursive);
          if (children.length === 0) {
            return {
              error:
                'location index is not loaded and the folder has no indexed children; use search_files instead',
            };
          }
          return {
            folder: folderPath,
            recursive,
            count: children.length,
            ...(children.length > SEARCH_RESULT_LIMIT && {
              truncated: true,
              note: 'only the first entries are listed — for very large folders prefer a separate summary note',
            }),
            entries: children
              .slice(0, SEARCH_RESULT_LIMIT)
              .map(entryToScanSummary),
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
          recursive,
          count: children.length,
          ...(children.length > SEARCH_RESULT_LIMIT && {
            truncated: true,
            note:
              `only the first ${SEARCH_RESULT_LIMIT} entries are listed — ` +
              'for very large folders prefer summarizing into a separate ' +
              'note file (write_deliverable) and keeping the description short',
          }),
          entries: children
            .slice(0, SEARCH_RESULT_LIMIT)
            .map(entryToScanSummary),
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
        const entry = await deps.findEntry(path);
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
        const entry = await deps.findEntry(path);
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
        const entry = await deps.findEntry(path);
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
        const indexEntry = await deps.findEntry(path);
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
        const entry = await deps.findEntry(path);
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
            ? existing.includes(AI_SUMMARY_MARKER)
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
        'check whether a document already has an up-to-date AI summary ' +
        '(hasAiSummary && !summaryStale) before summarizing it again, and ' +
        'to collect child descriptions when composing a folder summary.',
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
        const lmdt = (await deps.findEntry(path))?.lmdt;
        const hasAiSummary = description.includes(AI_SUMMARY_MARKER);
        return {
          path,
          hasAiSummary,
          summaryStale: isSummaryStale(description, lmdt),
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
        const entry = await deps.findEntry(sourcePath);
        if (!entry) {
          return {
            error:
              'source path not found in the current location index (if the index was just reloaded, re-run search_files and use a path from its results)',
          };
        }
        const targetIsKnown =
          target === norm(deps.currentLocationPath) ||
          !!(await deps.findEntry(target));
        if (!targetIsKnown) {
          return {
            error: 'target folder not found in the current location index',
          };
        }
        const name = source.split('/').pop();
        if (await deps.findEntry(`${target}/${name}`)) {
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
    {
      name: 'write_deliverable',
      description:
        "写文本方案 — create the goal's deliverable document (方案/报告/回复内容) " +
        'as a markdown file. Guardrails: ' +
        'only .md/.txt; an existing file is never overwritten unless it was ' +
        'AI-generated (contains the AI summary marker) or is empty.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'absolute path of the file to write (must end in .md or .txt)',
          },
          content: {
            type: 'string',
            description: 'markdown/text content to write',
          },
          overwrite: {
            type: 'boolean',
            description:
              'replace an existing file (allowed only when the existing file is AI-generated or empty)',
          },
        },
        required: ['path', 'content'],
      },
      execute: async (args) => {
        const path = requireString(args, 'path');
        const content = String(args?.content ?? '');
        if (!content.trim()) {
          return { error: 'content is empty — nothing to write' };
        }
        const lower = path.toLowerCase();
        if (!lower.endsWith('.md') && !lower.endsWith('.txt')) {
          return { error: 'only .md and .txt files can be written' };
        }
        const overwrite = args?.overwrite === true;
        const existing = await deps.findEntry(path);
        if (existing && !overwrite) {
          return {
            error:
              'file already exists — set overwrite=true only if you are sure it is AI-generated content',
          };
        }
        if (existing && overwrite) {
          const bytes = await deps.readFileBytes(path);
          const existingContent = new TextDecoder('utf-8').decode(bytes).trim();
          if (
            existingContent &&
            !existingContent.includes('🤖 AI 摘要') &&
            !existingContent.includes('🤖 AI Summary')
          ) {
            return {
              error:
                'refusing to overwrite: the existing file looks human-written (no AI summary marker)',
            };
          }
        }
        try {
          await deps.writeTextFile(path, content, overwrite && !!existing);
        } catch (e: any) {
          return { error: e?.message || String(e) };
        }
        return {
          ok: true,
          path,
          bytes: content.length,
          replacedExisting: !!existing,
        };
      },
    },
    {
      name: 'todo_list',
      description:
        'List todos from the personal todo list (未完成置顶：open → doing → done). ' +
        'Returns stats plus up to 50 items — enough to pick the id you need, ' +
        'then act with todo_complete / todo_update_status.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: TODO_STATUSES,
            description: 'filter by status; omit for all',
          },
          keyword: {
            type: 'string',
            description: 'text to search in title/description',
          },
          limit: {
            type: 'number',
            description: `max items to return (default ${SEARCH_RESULT_LIMIT})`,
          },
        },
        required: [],
      },
      execute: async (args) => {
        if (!isTodoAvailable()) return { error: TODO_UNAVAILABLE };
        try {
          const status = args?.status;
          if (status !== undefined && !TODO_STATUSES.includes(status)) {
            return { error: `invalid status: ${status}` };
          }
          const result = await todoApi.list({
            status,
            keyword:
              typeof args?.keyword === 'string' && args.keyword.trim()
                ? args.keyword.trim()
                : undefined,
          });
          const limit = Math.min(
            Number(args?.limit) || SEARCH_RESULT_LIMIT,
            SEARCH_RESULT_LIMIT,
          );
          return {
            total: result.stats.total,
            stats: result.stats,
            items: result.items.slice(0, limit).map(todoToSummary),
          };
        } catch (e: any) {
          return { error: e?.message || String(e) };
        }
      },
    },
    {
      name: 'todo_create',
      description:
        'Create a todo in the personal todo list (新建待办). ' +
        'Only the title is required; priority defaults to medium.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'todo title (required)' },
          description: { type: 'string', description: 'optional detail' },
          priority: {
            type: 'string',
            enum: TODO_PRIORITIES,
            description: 'default medium',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'optional tags',
          },
          project: {
            type: 'string',
            description: 'optional project/category',
          },
          dueDate: {
            type: 'string',
            description: 'optional due date, YYYY-MM-DD',
          },
        },
        required: ['title'],
      },
      execute: async (args) => {
        if (!isTodoAvailable()) return { error: TODO_UNAVAILABLE };
        try {
          const priority = args?.priority;
          if (priority !== undefined && !TODO_PRIORITIES.includes(priority)) {
            return { error: `invalid priority: ${priority}` };
          }
          const item = await todoApi.create({
            title: requireString(args, 'title'),
            description:
              typeof args?.description === 'string' && args.description.trim()
                ? args.description.trim()
                : undefined,
            priority,
            tags: Array.isArray(args?.tags)
              ? args.tags.map((tag) => String(tag))
              : undefined,
            project:
              typeof args?.project === 'string' && args.project.trim()
                ? args.project.trim()
                : undefined,
            dueDate:
              typeof args?.dueDate === 'string' && args.dueDate.trim()
                ? args.dueDate.trim()
                : undefined,
          });
          return { ok: true, todo: todoToSummary(item) };
        } catch (e: any) {
          return { error: e?.message || String(e) };
        }
      },
    },
    {
      name: 'todo_complete',
      description:
        'Mark a todo as done (标记完成). The todo moves to the done state ' +
        'and out of the pending list.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'todo id (see todo_list)' },
        },
        required: ['id'],
      },
      execute: async (args) => {
        if (!isTodoAvailable()) return { error: TODO_UNAVAILABLE };
        try {
          const item = await todoApi.update(requireString(args, 'id'), {
            status: 'done',
          });
          return { ok: true, todo: todoToSummary(item) };
        } catch (e: any) {
          return { error: e?.message || String(e) };
        }
      },
    },
    {
      name: 'todo_update_status',
      description:
        'Update the status of a todo: open (待办), doing (进行中) or done (已完成).',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'todo id (see todo_list)' },
          status: {
            type: 'string',
            enum: TODO_STATUSES,
            description: 'new status',
          },
        },
        required: ['id', 'status'],
      },
      execute: async (args) => {
        if (!isTodoAvailable()) return { error: TODO_UNAVAILABLE };
        try {
          const status = args?.status;
          if (!TODO_STATUSES.includes(status)) {
            return { error: `invalid status: ${status}` };
          }
          const item = await todoApi.update(requireString(args, 'id'), {
            status,
          });
          return { ok: true, todo: todoToSummary(item) };
        } catch (e: any) {
          return { error: e?.message || String(e) };
        }
      },
    },
  ];

  const customTools: AgentTool[] = getCustomTools()
    .filter((def) => def.enabled)
    .map((def) => ({
      name: def.name,
      description: `${def.description} (user-defined HTTP tool)`,
      parameters: def.parameters,
      execute: (args: any) =>
        executeCustomTool(def, JSON.stringify(args ?? {})),
    }));
  return filterEnabledTools([...tools, ...customTools]);
}
