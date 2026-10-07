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
 * edits and non-destructive moves/copies — deliberately NO delete or rename
 * tools (see DESIGN-ai-agent.md §4).
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
import {
  buildDeepseekPowResponse,
  parseDeepseekStream,
} from '-/services/deepseekPow';
import {
  ORGANIZE_DEFAULT_CONFIG,
  fingerprint,
  planOrganize,
  sameFingerprint,
  validateMovePlan,
  validateOrganizeConfig,
} from '-/utils/fileOrganizer';
import {
  appendOrganizeRecord,
  getOrganizeRecord,
  readOrganizeHistory,
  updateOrganizeRecord,
} from '-/utils/organizeHistory';
import type { OrganizeItem, OrganizeRecord } from '-/utils/organizeHistory';
import { markInboxOrganized } from '-/utils/inboxOrganize';
import { getUuid } from '@tagspaces/tagspaces-common/utils-io';
import AppConfig from '-/AppConfig';
import { TS } from '-/tagspaces.namespace';
import todoApi from '-/components/todo/todoService';
import { TodoItem } from '-/components/todo/todoTypes';

/** Direct children of `path` may not exceed this when planning an organize. */
const ORGANIZE_PLAN_LIMIT = 500;

function parentDirPath(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx > 0 ? p.slice(0, idx) : p;
}

function baseName(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

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
  /**
   * Copy an entry into another folder, leaving the source in place (no
   * overwrite). Used for inboxes whose archive mode is 'copy'. Optional —
   * when absent the copy mode is unavailable in this context.
   */
  copyFile?: (sourcePath: string, targetFolderPath: string) => Promise<boolean>;
  /**
   * Move/rename an entry to an EXACT target path (creates the destination
   * folder; never overwrites — rejects when the target exists). Used by the
   * folder-organize tools to file items into category folders and to restore
   * them under a unique name ("name (1).ext") when the original is taken.
   */
  moveToPath: (sourcePath: string, targetPath: string) => Promise<boolean>;
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
  /**
   * Register an existing folder on disk as a TagSpaces location. Returns the
   * created location or throws. Used by the disk-organize skill to materialize
   * the plan the user approved.
   */
  createLocation: (
    name: string,
    path: string,
    options?: {
      isDefault?: boolean;
      isReadOnly?: boolean;
    },
  ) => Promise<{ ok: boolean; name: string; path: string }>;
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

const DISK_INIT_STATE_KEY = 'tsDiskInitState';

export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!(window as any).electronIO;
}

// --- deepseek_search (deep web search through the DeepSeek web session) ---
// The free web chat has no public API; the programmatic client replays the
// origin-sensitive requests inside the embedded DeepSeek webview via the
// 'deepseek-web-drive' IPC (main process), with the PoW header solved locally.
// One chat session spans the whole run and parent_message_id is chained, so
// concurrent searches would corrupt the chain — serialize them.
const DEEPSEEK_SEARCH_TIMEOUT = 45000;
let deepseekSearchChain: Promise<unknown> = Promise.resolve();
let deepseekSearchSessionId: number | null = null;
let deepseekSearchParentId: number | null = null;

async function deepseekSearchOnce(
  question: string,
): Promise<{ answer: string; citations: string[] }> {
  const io = (window as any).electronIO?.ipcRenderer;
  const drive = (action: string, args?: any) =>
    io.invoke('deepseek-web-drive', action, args);

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () =>
        reject(
          new Error(`DeepSeek 搜索超时（${DEEPSEEK_SEARCH_TIMEOUT / 1000}s）`),
        ),
      DEEPSEEK_SEARCH_TIMEOUT,
    ),
  );
  const work = (async () => {
    if (!deepseekSearchSessionId) {
      const created: any = await drive('create-session');
      if (created?.error || !created?.id) {
        throw new Error(
          `${created?.error || '创建会话失败'}（请在 AI 弹窗的 DeepSeek 标签打开并登录）`,
        );
      }
      deepseekSearchSessionId = created.id;
      deepseekSearchParentId = null;
    }
    const chal: any = await drive('challenge');
    const ch = chal?.challenge;
    if (chal?.error || !ch) {
      throw new Error(chal?.error || '获取 PoW 挑战失败');
    }
    const powHeader = await buildDeepseekPowResponse({
      ...ch,
      target_path: '/api/v0/chat/completion',
    });
    const res: any = await drive('completion', {
      body: {
        chat_session_id: deepseekSearchSessionId,
        parent_message_id: deepseekSearchParentId,
        model_type: null,
        prompt: question,
        ref_file_ids: [],
        thinking_enabled: false,
        search_enabled: true,
        action: null,
        preempt: false,
      },
      powHeader,
    });
    if (res?.error || !res?.ok) {
      throw new Error(res?.error || res?.text || 'completion 请求失败');
    }
    const parsed = parseDeepseekStream(res.text || '');
    if (parsed.nextParent) deepseekSearchParentId = parsed.nextParent;
    const answer = parsed.content.trim();
    if (!answer) {
      throw new Error('DeepSeek 返回了空答案（可能未登录或触发风控）');
    }
    return { answer, citations: parsed.citations };
  })();
  // If the timeout wins, the still-running completion must not surface an
  // unhandled rejection.
  work.catch(() => {});
  return Promise.race([work, timeout]);
}

function deepseekSearch(question: string) {
  const run = () => deepseekSearchOnce(question);
  const p = deepseekSearchChain.then(run, run);
  deepseekSearchChain = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

export type InboxMode = 'move' | 'copy';
export type Inbox = { path: string; mode: InboxMode };
export type DiskInitState = {
  done?: boolean;
  at?: number;
  /**
   * Folders that collect incoming files. Each carries an archive mode:
   * 'move' = the source is removed after filing, 'copy' = the original stays.
   * Legacy state stored plain strings (implicit 'move'); those are normalized
   * on read by normalizeInboxes.
   */
  inboxes?: Inbox[];
  /** Locations created during the initialization. */
  locations?: Array<{ name: string; path: string }>;
  /** Short summary of the agreed filing rules. */
  rulesSummary?: string;
};

/**
 * Coerce one raw inbox entry (legacy plain string or {path, mode}) into a
 * normalized inbox object. Returns undefined for empty paths. Unknown modes
 * fall back to 'move'.
 */
export function normalizeInbox(raw: any): Inbox | undefined {
  const path =
    typeof raw === 'string' ? raw.trim() : String(raw?.path || '').trim();
  if (!path) return undefined;
  const mode: InboxMode =
    raw && typeof raw === 'object' && raw.mode === 'copy' ? 'copy' : 'move';
  return { path, mode };
}

export function normalizeInboxes(raw: any): Inbox[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeInbox)
    .filter((i: Inbox | undefined): i is Inbox => !!i);
}

export function readDiskInitState(): DiskInitState | undefined {
  try {
    const raw = localStorage.getItem(DISK_INIT_STATE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.inboxes)) {
      parsed.inboxes = normalizeInboxes(parsed.inboxes);
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function writeDiskInitState(state: DiskInitState): void {
  try {
    localStorage.setItem(DISK_INIT_STATE_KEY, JSON.stringify(state));
  } catch {
    // storage unavailable (private mode) — the guard is best-effort
  }
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
        'moved or copied between local locations (this is how an inbox is ' +
        'filed into an archive location); only cloud locations are ' +
        'restricted to internal moves.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        const locations = deps.listLocations();
        return {
          count: locations.length,
          locations: locations.map((l) => ({ name: l.name, path: l.path })),
          note: 'filing across local locations is supported (e.g. inbox -> archive); cloud locations only move inside themselves',
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
        'Move a file or folder into another folder — the destination may be ' +
        'in the same location or in a different connected location (this is ' +
        'how an inbox is filed: e.g. Downloads -> a work or archive location). ' +
        'Never overwrites an existing target. Move first, then tag the moved ' +
        'entry. Cross-location moves involving a cloud location are rejected. ' +
        'Set keepSource: true to COPY instead — the original stays where it ' +
        'is; use this for inboxes whose archive mode is "copy".',
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
          keepSource: {
            type: 'boolean',
            description:
              'copy instead of move — leave the original in place ' +
              '(for inboxes with archive mode "copy")',
          },
        },
        required: ['sourcePath', 'targetFolder'],
      },
      execute: async (args) => {
        const sourcePath = requireString(args, 'sourcePath');
        const targetFolder = requireString(args, 'targetFolder');
        const keepSource = Boolean(args?.keepSource);
        if (keepSource && !deps.copyFile) {
          return {
            error:
              'copy is not available in this context — the embedded web build ' +
              'cannot copy files. File the entry with a plain move instead, or ' +
              'tell the user this inbox needs the desktop app for copy-mode ' +
              'archiving.',
          };
        }
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
        const ok = keepSource
          ? await deps.copyFile(sourcePath, targetFolder)
          : await deps.moveFile(sourcePath, targetFolder);
        if (!ok) {
          return {
            error: `the ${keepSource ? 'copy' : 'move'} failed (check notifications for details)`,
          };
        }
        return {
          ok: true,
          newPath: `${target}/${name}`,
          ...(keepSource ? { sourceLeftInPlace: true } : {}),
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
      name: 'web_search',
      description:
        'Search the web and return titles, URLs and snippets (fast, ~0.5s). ' +
        'Use it to look up information, find references or verify facts; ' +
        'pair with fetch_web when you need the body of a specific page. ' +
        'Default engines are [bing, baidu, juejin] — narrow to [baidu] for ' +
        'Chinese everyday content or [juejin] for technical content.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'the search query — ask it as one clear phrase',
          },
          limit: {
            type: 'number',
            description: 'how many results to return, 1-50 (default 8)',
          },
          engines: {
            type: 'array',
            items: { type: 'string' },
            description: 'search engines to use; default [bing, baidu, juejin]',
          },
        },
        required: ['query'],
      },
      execute: async (args) => {
        if (!isElectron()) {
          return {
            error:
              'web_search is only available in the desktop app (needs the local open-websearch daemon)',
          };
        }
        try {
          const result = await (window as any).electronIO.ipcRenderer.invoke(
            'webSearch',
            args || {},
          );
          return result && result.error ? { error: result.error } : result;
        } catch (e: any) {
          return { error: e?.message || String(e) };
        }
      },
    },
    {
      name: 'fetch_web',
      description:
        'Fetch the body text of a web page (default up to 6000 chars). Use ' +
        'after web_search to read the 1-2 pages you actually need in detail. ' +
        'Returns title, finalUrl and content; content is truncated at ' +
        'max_chars.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'full http(s) URL to fetch' },
          max_chars: {
            type: 'number',
            description: 'max chars to return, default 6000, min 1000',
          },
        },
        required: ['url'],
      },
      execute: async (args) => {
        if (!isElectron()) {
          return {
            error:
              'fetch_web is only available in the desktop app (needs the local open-websearch daemon)',
          };
        }
        try {
          const result = await (window as any).electronIO.ipcRenderer.invoke(
            'fetchWeb',
            args || {},
          );
          return result && result.error ? { error: result.error } : result;
        } catch (e: any) {
          return { error: e?.message || String(e) };
        }
      },
    },
    {
      name: 'deepseek_search',
      description:
        'Deep web search: DeepSeek itself browses multiple sources and ' +
        'returns a synthesized conclusion with citations. Slow (10-45s) and ' +
        'requires the DeepSeek web app to be logged in (open the AI dialog > ' +
        'DeepSeek tab once). Use it when web_search results are too scattered ' +
        'or you want a direct answer instead of links.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'the full question to research and synthesize',
          },
        },
        required: ['question'],
      },
      execute: async (args) => {
        const question =
          args && typeof args.question === 'string' ? args.question.trim() : '';
        if (!question) return { error: 'missing question' };
        if (!isElectron()) {
          return {
            error: 'deepseek_search is only available in the desktop app',
          };
        }
        try {
          return await deepseekSearch(question);
        } catch (e: any) {
          return { error: e?.message || String(e) };
        }
      },
    },
    {
      name: 'organize_preview',
      description:
        'Plan the organization of a folder: classify its direct children by ' +
        'file type into destination sub-folders (Documents/Images/Videos/' +
        'Audio/Archives/Apps/Other by default) and report skipped items with ' +
        'reasons (system/hidden files, oversized files, existing category ' +
        'folders, and plain folders by default). READ-ONLY — nothing is ' +
        'moved. Always call this first, show the user the plan and get their ' +
        'approval, THEN run organize_apply with the selected moves. Custom ' +
        'rules can be passed via config: { categories: { Name: { extensions: ' +
        '[".ext", ...] }, ... }, excludedExtensions, maxFileSizeMb, ' +
        'includeFolders } — the category with an empty extensions list is the ' +
        'catch-all.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'folder to organize; defaults to the current folder',
          },
          config: {
            type: 'object',
            description: 'optional custom classification rules (see default)',
          },
        },
        required: [],
      },
      execute: async (args) => {
        const root =
          args?.path && typeof args.path === 'string' && args.path.trim()
            ? args.path.trim()
            : deps.currentDirectoryPath;
        if (!root) {
          return { error: 'no folder to organize — pass a path' };
        }
        let config;
        try {
          config = validateOrganizeConfig(args?.config);
        } catch (e: any) {
          return { error: e?.message || String(e) };
        }
        let children;
        try {
          children = await deps.listChildren(root);
        } catch (e: any) {
          return { error: e?.message || String(e) };
        }
        if (children.length > ORGANIZE_PLAN_LIMIT) {
          return {
            error: `folder has ${children.length} items — split it into smaller batches (limit ${ORGANIZE_PLAN_LIMIT} per run)`,
          };
        }
        const { organizable, skipped } = planOrganize(root, children, config);
        return {
          root,
          config,
          summary: {
            count: organizable.length,
            totalSize: organizable.reduce((sum, r) => sum + r.size, 0),
          },
          organizable: organizable.map((r) => ({
            path: r.path,
            name: r.name,
            size: r.size,
            category: r.category,
            targetPath: r.targetPath,
          })),
          skipped: skipped.map((r) => ({
            path: r.path,
            name: r.name,
            reason: r.reason,
          })),
        };
      },
    },
    {
      name: 'organize_apply',
      description:
        'Execute an organization plan: move files into their category ' +
        'folders. Pass root, the moves [{ from, to }] selected from ' +
        'organize_preview (a subset is fine), and the same config you used ' +
        'for the preview. Destination folders are created as needed and files ' +
        'are NEVER overwritten — if the target name already exists the move ' +
        'fails for that item and it is reported. Records the moves in history ' +
        'so organize_undo can restore them.',
      parameters: {
        type: 'object',
        properties: {
          root: {
            type: 'string',
            description: 'the folder being organized (from organize_preview)',
          },
          moves: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                from: { type: 'string', description: 'source path' },
                to: { type: 'string', description: 'target path' },
              },
              required: ['from', 'to'],
            },
            description: 'moves to apply (from organize_preview.organizable)',
          },
          config: {
            type: 'object',
            description: 'the same config used for organize_preview',
          },
        },
        required: ['root', 'moves'],
      },
      execute: async (args) => {
        const root =
          args?.root && typeof args.root === 'string' ? args.root.trim() : '';
        const moves = Array.isArray(args?.moves) ? args.moves : [];
        if (!root || moves.length === 0) {
          return {
            error:
              'root and moves are required — run organize_preview first and pass its moves',
          };
        }
        let config;
        try {
          config = validateOrganizeConfig(args?.config);
        } catch (e: any) {
          return { error: e?.message || String(e) };
        }
        const { valid, invalid } = validateMovePlan(root, moves);
        if (valid.length === 0) {
          return {
            error: 'no valid moves to apply',
            invalid: invalid.map((mv) => ({
              from: mv.from,
              to: mv.to,
              reason: mv.reason,
            })),
          };
        }
        const record: OrganizeRecord = {
          id: getUuid(),
          root,
          date: new Date().toISOString(),
          config,
          status: 'pending',
          items: valid.map(
            (mv): OrganizeItem => ({
              original: mv.from,
              moved: mv.to,
              category: baseName(parentDirPath(mv.to)),
              fingerprint: { size: 0, lmdt: 0 },
              state: 'pending',
            }),
          ),
        };
        appendOrganizeRecord(record);
        const moved: Array<{ from: string; to: string }> = [];
        const failed: Array<{ from: string; to: string; error: string }> = [];
        for (const mv of valid) {
          const item = record.items.find((i) => i.original === mv.from);
          try {
            const entry = await deps.findEntry(mv.from);
            if (!entry) {
              throw new Error('file disappeared before the move');
            }
            if (item) item.fingerprint = fingerprint(entry);
            await deps.moveToPath(mv.from, mv.to);
            if (item) item.state = 'moved';
            moved.push({ from: mv.from, to: mv.to });
          } catch (e: any) {
            const err = e?.message || String(e);
            if (item) {
              item.state = 'failed';
              item.error = err;
            }
            failed.push({ from: mv.from, to: mv.to, error: err });
          }
        }
        record.status =
          failed.length === 0
            ? 'done'
            : moved.length > 0
              ? 'partial'
              : 'failed';
        updateOrganizeRecord(record.id, {
          status: record.status,
          items: record.items,
        });
        return {
          recordId: record.id,
          status: record.status,
          moved,
          failed,
          invalid: invalid.map((mv) => ({
            from: mv.from,
            to: mv.to,
            reason: mv.reason,
          })),
        };
      },
    },
    {
      name: 'organize_undo',
      description:
        'Restore files moved by a previous organize_apply, back to their ' +
        'original location. Pass recordId to pick a specific record, or omit ' +
        'it to restore the most recent one. Files are only restored when they ' +
        'are unchanged since the move (fingerprint check); if the original ' +
        'name is already taken they are restored under "name (1).ext" so ' +
        'nothing is overwritten. Use organize_history to list records.',
      parameters: {
        type: 'object',
        properties: {
          recordId: {
            type: 'string',
            description: 'organize record id; omit for the most recent',
          },
        },
        required: [],
      },
      execute: async (args) => {
        const record = getOrganizeRecord(args?.recordId);
        if (!record) {
          return {
            error: 'no matching organize record — run organize_history first',
          };
        }
        const restored: Array<{ moved: string; restoredTo: string }> = [];
        const failed: Array<{ moved: string; error: string }> = [];
        for (const item of record.items) {
          if (item.state !== 'moved') continue;
          try {
            const entry = await deps.findEntry(item.moved);
            if (!entry) {
              throw new Error('file is no longer at its moved location');
            }
            if (!sameFingerprint(fingerprint(entry), item.fingerprint)) {
              throw new Error(
                'file changed since the move — left in place to avoid touching it',
              );
            }
            const parent = parentDirPath(item.original);
            const originalTaken = !!(await deps.findEntry(item.original));
            let target = item.original;
            if (originalTaken) {
              const taken = new Set(
                (await deps.listChildren(parent)).map((c) =>
                  c.name.toLocaleLowerCase(),
                ),
              );
              let n = 1;
              const dot = item.original.lastIndexOf('.');
              const slash = Math.max(
                item.original.lastIndexOf('/'),
                item.original.lastIndexOf('\\'),
              );
              let candidate = item.original;
              while (taken.has(baseName(candidate).toLocaleLowerCase())) {
                candidate =
                  dot > slash + 1
                    ? `${item.original.slice(0, dot)} (${n})${item.original.slice(dot)}`
                    : `${item.original} (${n})`;
                n += 1;
              }
              target = candidate;
            }
            await deps.moveToPath(item.moved, target);
            item.state = 'restored';
            restored.push({ moved: item.moved, restoredTo: target });
          } catch (e: any) {
            item.state = 'failed';
            item.error = e?.message || String(e);
            failed.push({ moved: item.moved, error: item.error });
          }
        }
        record.status = 'undone';
        updateOrganizeRecord(record.id, {
          status: record.status,
          items: record.items,
        });
        return { recordId: record.id, restored, failed, status: record.status };
      },
    },
    {
      name: 'organize_history',
      description:
        'List the folder-organization history: each organize_apply records ' +
        'an entry with its id, root folder, date, status and how many files ' +
        'were moved. Use the id as recordId for organize_undo.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        return readOrganizeHistory().map((r) => ({
          id: r.id,
          root: r.root,
          date: r.date,
          status: r.status,
          movedCount: r.items.filter((i) => i.state === 'moved').length,
        }));
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
    {
      name: 'init_scan',
      description:
        'One-shot disk initialization scan for the disk-organize skill. ' +
        'Walks the user home directory (or the given roots) with a bounded ' +
        'depth and a per-profile extension filter, and returns aggregated ' +
        'directory stats — never a full file list. Read-only, nothing is ' +
        'uploaded. Sensitive folders (credentials, keychains, browser data, ' +
        'chat databases) are skipped. Call this only AFTER the interview is ' +
        'complete, exactly once per initialization.',
      parameters: {
        type: 'object',
        properties: {
          profile: {
            type: 'string',
            enum: [
              'programming',
              'office',
              'design',
              'academic',
              'mixed',
              'other',
            ],
            description:
              'the user work profile from the interview — drives which file ' +
              'extensions are counted',
          },
          roots: {
            type: 'array',
            items: { type: 'string' },
            description:
              'absolute directories to scan; defaults to the user home directory',
          },
          depth: {
            type: 'number',
            description: 'max recursion depth below each root (default 4)',
          },
          maxResults: {
            type: 'number',
            description:
              'cap on counted (matching) files; extra matches are dropped and truncated is set',
          },
          force: {
            type: 'boolean',
            description:
              'set to true only when the user explicitly asks to redo the initialization',
          },
        },
        required: [],
      },
      execute: async (args) => {
        if (!isElectron()) {
          return {
            error:
              'disk scan is only available in the desktop app (it reads the local filesystem via the main process)',
          };
        }
        const state = readDiskInitState();
        if (state?.done && !args?.force) {
          return {
            error:
              'disk initialization was already completed on this machine. ' +
              'Do not run it again unless the user explicitly asks for a redo ' +
              '(then pass force: true).',
            doneAt: state.at,
          };
        }
        try {
          const opts: any = {};
          if (args?.profile) opts.profile = args.profile;
          if (Array.isArray(args?.roots) && args.roots.length > 0) {
            opts.roots = args.roots;
          }
          if (typeof args?.depth === 'number') opts.depth = args.depth;
          if (typeof args?.maxResults === 'number') {
            opts.maxEntries = args.maxResults;
          }
          const result = await (window as any).electronIO.ipcRenderer.invoke(
            'initScan',
            opts,
          );
          if (result?.error) {
            return { error: result.error };
          }
          return result;
        } catch (e: any) {
          return { error: e?.message || String(e) };
        }
      },
    },
    {
      name: 'create_location',
      description:
        'Register an existing folder on disk as a TagSpaces location. Used ' +
        'by the disk-organize skill to materialize the plan the user ' +
        'approved (e.g. an archive location and the Downloads inbox). The ' +
        'folder must already exist — this tool never creates or moves ' +
        'folders, and never overwrites an existing location pointing at the ' +
        'same path.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'location name shown in the location manager',
          },
          path: {
            type: 'string',
            description: 'absolute path of an existing folder to connect',
          },
          isDefault: {
            type: 'boolean',
            description: 'open this location on app start',
          },
          isReadOnly: {
            type: 'boolean',
            description: 'never modify files inside this location',
          },
        },
        required: ['name', 'path'],
      },
      execute: async (args) => {
        const name = requireString(args, 'name');
        const targetPath = requireString(args, 'path');
        const duplicate = deps
          .listLocations()
          .some((l) => l.path === targetPath);
        if (duplicate) {
          return {
            error: `a location for ${targetPath} already exists; do not create a duplicate`,
          };
        }
        try {
          const created = await deps.createLocation(name, targetPath, {
            isDefault: Boolean(args?.isDefault),
            isReadOnly: Boolean(args?.isReadOnly),
          });
          return { ok: true, name: created.name, path: created.path };
        } catch (e: any) {
          const msg = e?.message || String(e);
          if (/EPERM|EACCES/.test(msg)) {
            return {
              error:
                `${msg}\n\nThis folder is protected by macOS (TCC). Offer to ` +
                'open the settings page with the open_privacy_settings tool ' +
                '(System Settings > Privacy & Security > Full Disk Access), ' +
                'ask the user to enable TagSpaces there, then retry. Do not ' +
                'retry in a loop — wait for the user to confirm.',
            };
          }
          return { error: msg };
        }
      },
    },
    {
      name: 'open_privacy_settings',
      description:
        'Open the operating system privacy settings page where the user ' +
        'grants this app access to protected folders (macOS: Privacy & ' +
        'Security > Full Disk Access; Windows: broad file system access). ' +
        'Use it when a create_location or file write fails with EPERM/EACCES ' +
        'on a protected folder (Desktop, Downloads, Documents), so the user ' +
        'does not have to find the page manually.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        try {
          const result = await window.electronIO?.ipcRenderer?.invoke(
            'openPrivacySettings',
          );
          if (!result) {
            return {
              error:
                'not available in this context (the embedded web build has ' +
                'no access to the OS settings)',
            };
          }
          return result;
        } catch (e: any) {
          return { error: e?.message || String(e) };
        }
      },
    },
    {
      name: 'finish_disk_init',
      description:
        'Mark the disk initialization as complete. Call exactly once, after ' +
        'the user approved the plan and every location in it has been ' +
        'created with create_location. Pass the inboxes (the folders that ' +
        'collect incoming files — usually the system Downloads folder and ' +
        'often the Desktop), each with its archive mode: "move" (default — ' +
        'the source is removed once filed) or "copy" (the original stays in ' +
        'the inbox). Also pass the locations you created and a short summary ' +
        'of the filing rules, so later organizing runs know where things ' +
        'belong without re-reading the whole plan. Once this is set, ' +
        'init_scan refuses to run again unless the user explicitly asks for ' +
        'a redo.',
      parameters: {
        type: 'object',
        properties: {
          inboxes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: 'absolute path of the inbox folder',
                },
                mode: {
                  type: 'string',
                  enum: ['move', 'copy'],
                  description:
                    'what happens to the source when a file is filed out of ' +
                    'this inbox: move (default) removes it, copy leaves the ' +
                    'original behind',
                },
              },
              required: ['path'],
            },
            description:
              'inboxes the user confirmed, each with its archive mode ' +
              '(plain path strings are accepted and default to move)',
          },
          locations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                path: { type: 'string' },
              },
              required: ['name', 'path'],
            },
            description: 'locations created for the approved plan',
          },
          rulesSummary: {
            type: 'string',
            description:
              'short summary of the agreed filing rules: which file types ' +
              'or projects go to which location, plus naming/tag conventions',
          },
        },
        required: ['inboxes'],
      },
      execute: async (args) => {
        const rawInboxes = Array.isArray(args?.inboxes) ? args.inboxes : [];
        const inboxes = normalizeInboxes(rawInboxes);
        if (inboxes.length === 0) {
          return {
            error:
              'at least one inbox path is required — pass the folders the ' +
              'user confirmed as inboxes (e.g. Downloads, Desktop)',
          };
        }
        const locations = Array.isArray(args?.locations)
          ? args.locations
              .filter((l: any) => l && typeof l.path === 'string')
              .map((l: any) => ({
                name: String(l.name || ''),
                path: String(l.path),
              }))
          : undefined;
        const rulesSummary =
          typeof args?.rulesSummary === 'string' && args.rulesSummary.trim()
            ? args.rulesSummary.trim()
            : undefined;
        const previous = readDiskInitState();
        const now = Date.now();
        writeDiskInitState({
          done: true,
          at: now,
          inboxes,
          ...(locations && locations.length > 0 ? { locations } : {}),
          ...(rulesSummary ? { rulesSummary } : {}),
        });
        return { ok: true, previous, finishedAt: now, inboxes };
      },
    },
    {
      name: 'read_disk_init',
      description:
        'Read the stored disk-initialization result: which folders are ' +
        'registered as inboxes (Downloads, Desktop, ...) with their archive ' +
        'mode (move = source removed after filing, copy = original kept), ' +
        'plus the agreed filing rules. Call this whenever the user asks to ' +
        'tidy, organize or file incoming files, so files are moved to the ' +
        'right destination instead of being reshuffled inside the inbox.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        const state = readDiskInitState();
        if (!state) {
          return {
            error:
              'disk initialization has not been run yet — the inbox setup ' +
              'and filing rules are unknown. Ask the user whether they want ' +
              'the global initialization first.',
          };
        }
        return state;
      },
    },
    {
      name: 'update_disk_init',
      description:
        'Change the stored disk-initialization result without re-running ' +
        'the whole interview + scan flow. Use it when the user wants to add ' +
        'or remove an inbox (e.g. "also treat my Desktop as an inbox"), ' +
        'change an inbox archive mode (e.g. "keep the originals in ' +
        'Downloads when filing" — pass the path with mode "copy"; an ' +
        'already-registered path is updated in place), register more filing ' +
        'destinations, or adjust the filing rules. Paths are absolute; ' +
        'additions that are already registered are ignored unless they carry ' +
        'a different mode, and removing an unknown inbox is ignored too.',
      parameters: {
        type: 'object',
        properties: {
          addInboxes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: 'absolute inbox path (e.g. Desktop)',
                },
                mode: {
                  type: 'string',
                  enum: ['move', 'copy'],
                  description:
                    'archive mode for this inbox: move (default) removes the ' +
                    'source once filed, copy leaves the original behind',
                },
              },
              required: ['path'],
            },
            description:
              'inboxes to register or reconfigure; plain path strings are ' +
              'accepted and default to move',
          },
          removeInboxes: {
            type: 'array',
            items: { type: 'string' },
            description: 'absolute inbox paths to unregister',
          },
          addLocations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                path: { type: 'string' },
              },
              required: ['name', 'path'],
            },
            description:
              'filing destinations to register (e.g. a location just ' +
              'created with create_location)',
          },
          rulesSummary: {
            type: 'string',
            description: 'replace the stored filing-rules summary',
          },
        },
        required: [],
      },
      execute: async (args) => {
        const state = readDiskInitState();
        if (!state?.done) {
          return {
            error:
              'disk initialization has not been run yet — run the global ' +
              'initialization first, then use this tool to adjust it.',
          };
        }
        const normalize = (p: string) => String(p || '').trim();
        const addInboxes = normalizeInboxes(args?.addInboxes);
        const removeInboxes = (
          Array.isArray(args?.removeInboxes) ? args.removeInboxes : []
        )
          .map(normalize)
          .filter(Boolean);
        const addLocations = Array.isArray(args?.addLocations)
          ? args.addLocations
              .filter((l: any) => l && typeof l.path === 'string')
              .map((l: any) => ({
                name: String(l.name || ''),
                path: String(l.path),
              }))
          : [];
        const rulesSummary =
          typeof args?.rulesSummary === 'string' && args.rulesSummary.trim()
            ? args.rulesSummary.trim()
            : state.rulesSummary;
        // Keep existing inboxes unless removed; addInboxes wins on duplicate
        // paths so an existing inbox can be switched to a different mode.
        const inboxByPath = new Map<string, Inbox>();
        for (const ib of state.inboxes || []) {
          inboxByPath.set(ib.path, ib);
        }
        for (const ib of addInboxes) {
          inboxByPath.set(ib.path, ib);
        }
        const inboxes = Array.from(inboxByPath.values()).filter(
          (ib) => !removeInboxes.includes(ib.path),
        );
        if (inboxes.length === 0) {
          return {
            error:
              'refusing to remove the last inbox — at least one inbox must ' +
              'stay registered',
          };
        }
        const byPath = new Map<string, { name: string; path: string }>();
        [...(state.locations || []), ...addLocations].forEach((l) => {
          if (l.path) {
            byPath.set(l.path, l);
          }
        });
        const locations = Array.from(byPath.values());
        const next: DiskInitState = {
          done: true,
          at: state.at,
          inboxes,
          locations,
          ...(rulesSummary ? { rulesSummary } : {}),
        };
        writeDiskInitState(next);
        return { ok: true, previous: state, state: next };
      },
    },
    {
      name: 'mark_inbox_organized',
      description:
        'Mark one or more inboxes as organized "now" after a successful ' +
        'inbox-filing pass. Pass inboxPath to mark a single inbox, or omit it ' +
        'to mark every registered inbox (the ones you just filed). The daily ' +
        'inbox reminder only shows an inbox again once it has files newer ' +
        'than this marker. Call it at the END of the daily pass, after you ' +
        'filed the files, tagged them and wrote the 整理记录.',
      parameters: {
        type: 'object',
        properties: {
          inboxPath: {
            type: 'string',
            description:
              'absolute path of one inbox to mark; omit to mark all registered inboxes',
          },
        },
        required: [],
      },
      execute: async (args) => {
        const state = readDiskInitState();
        const inboxes = state?.inboxes || [];
        const requested =
          args?.inboxPath && typeof args.inboxPath === 'string'
            ? args.inboxPath.trim()
            : '';
        const targets = requested
          ? inboxes.filter((ib) => ib.path === requested)
          : inboxes;
        const paths = (
          targets.length ? targets : requested ? [{ path: requested }] : []
        )
          .map((ib) => ib.path)
          .filter(Boolean);
        const at = new Date().toISOString();
        paths.forEach((p) => markInboxOrganized(p));
        return { ok: true, marked: paths, at };
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
