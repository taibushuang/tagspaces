/**
 * Issue collection feature (需求与缺陷收集) — shared renderer types.
 *
 * Field layout must stay in sync with the authoritative definition in
 * src/main/issueStore.ts (kept separate so the renderer never imports main
 * process modules).
 */

export type IssueType = 'bug' | 'feature';
export type IssueStatus = 'open' | 'done';
export type IssueSeverity = 'high' | 'medium' | 'low';
export type IssueSource = 'ui' | 'agent';

export interface IssueContext {
  appVersion?: string;
  platform?: string;
  /** OS kernel/build version (e.g. os.release()) for environment reports. */
  osVersion?: string;
  /** UI language at report time (app.getLocale()). */
  appLanguage?: string;
  locationName?: string;
  locationPath?: string;
  folderPath?: string;
  agentSessionId?: string;
  /** Paths of the entries selected in the main view at report time (max 10). */
  selectedEntries?: string[];
  /** The most recent failed agent tool call at report time (defect evidence). */
  lastToolError?: {
    tool: string;
    args?: string;
    error: string;
    at: number;
  };
}

export interface IssueItem {
  id: string;
  /**
   * Stable reference id ("{machineTag}-BUG-001" / "-REQ-001"), assigned once
   * at create time (main process) and never renumbered. Must stay in sync
   * with src/main/issueStore.ts.
   */
  ref: string;
  type: IssueType;
  title: string;
  description?: string;
  severity: IssueSeverity;
  status: IssueStatus;
  context?: IssueContext;
  source: IssueSource;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface IssueStats {
  total: number;
  open: number;
  done: number;
}

export interface IssueListResult {
  items: IssueItem[];
  stats: IssueStats;
}

export interface IssueFilter {
  type?: IssueType;
  status?: IssueStatus;
  keyword?: string;
}

export type IssueCreateInput = Pick<IssueItem, 'title'> &
  Partial<
    Omit<IssueItem, 'id' | 'title' | 'createdAt' | 'updatedAt' | 'resolvedAt'>
  >;

export type IssueUpdateInput = Partial<Omit<IssueItem, 'id' | 'createdAt'>>;

export interface IssueExportResult {
  canceled: boolean;
  count: number;
  filePath: string | null;
  machineTag?: string;
}

export interface IssuePathInfo {
  file: string;
  dir: string;
  version: string;
  platform: string;
  osVersion: string;
  appLanguage: string;
  /** 4-char machine tag used to prefix issue reference ids. */
  machineTag: string;
}

export interface IssueUpdateManyResult {
  updated: number;
  missing: string[];
}

export type IssueTypeFilter = 'all' | IssueType;
export type IssueStatusFilter = 'all' | IssueStatus;

export const ISSUE_TYPES: IssueType[] = ['bug', 'feature'];
export const ISSUE_STATUSES: IssueStatus[] = ['open', 'done'];
export const ISSUE_SEVERITIES: IssueSeverity[] = ['high', 'medium', 'low'];

/**
 * Reference-id lookup ([machineTag-]BUG-001) — refs are assigned once at
 * create time by the main process and stored on each item, so this is a pure
 * read (no numbering logic here; the rule lives only in issueStore.ts).
 */
export function buildIssueRefs(items: IssueItem[]): Map<string, string> {
  return new Map(items.filter((i) => i.ref).map((i) => [i.id, i.ref]));
}

export function filterIssues(
  items: IssueItem[],
  filter: { type: IssueTypeFilter; status: IssueStatusFilter; keyword: string },
): IssueItem[] {
  const keyword = filter.keyword.trim().toLowerCase();
  return items.filter((item) => {
    if (filter.type !== 'all' && item.type !== filter.type) return false;
    if (filter.status !== 'all' && item.status !== filter.status) return false;
    if (keyword) {
      const hay = `${item.title} ${item.description ?? ''} ${
        item.context?.locationName ?? ''
      }`.toLowerCase();
      if (!hay.includes(keyword)) return false;
    }
    return true;
  });
}
