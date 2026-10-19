/**
 * IssueDatabase — file-backed store for the feature-request / bug collection
 * list (需求与缺陷收集清单).
 *
 * Design mirrors TodoDatabase (JSON file + in-memory copy, validation,
 * atomic writes, rotating backups; no database engine, no native deps).
 * Entries come from two sources: the UI panel and the AI Agent
 * (report_issue tool), so every item records its source plus an optional
 * context snapshot (app version, platform, location/folder) captured at
 * report time.
 *
 * This module is deliberately free of any `electron` import so it can be
 * unit tested in a plain Node environment. The IPC wiring lives in
 * issueStoreIpc.ts.
 */

import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';

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
   * at create time and never renumbered — the export document, the panel and
   * the agent all reference entries by it. Legacy items (pre-ref) are
   * backfilled at load in newest-first-per-type order.
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

export interface IssueFilter {
  type?: IssueType;
  status?: IssueStatus;
  keyword?: string;
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

export type IssueCreateInput = Pick<IssueItem, 'title'> &
  Partial<
    Omit<IssueItem, 'id' | 'title' | 'createdAt' | 'updatedAt' | 'resolvedAt'>
  >;

export type IssueUpdateInput = Partial<Omit<IssueItem, 'id' | 'createdAt'>>;

export const ISSUE_TYPES: IssueType[] = ['bug', 'feature'];
export const ISSUE_STATUSES: IssueStatus[] = ['open', 'done'];
export const ISSUE_SEVERITIES: IssueSeverity[] = ['high', 'medium', 'low'];
export const ISSUE_SOURCES: IssueSource[] = ['ui', 'agent'];

const SCHEMA_VERSION = 1;
const MAX_BACKUPS = 10;
const DEFAULT_SOURCE: IssueSource = 'ui';
const CONTEXT_FIELD_LIMIT = 1024;
const MACHINE_TAG_RE = /^[A-HJ-NP-Z2-9]{4}$/; // 无易混淆字符（无 I/O/0/1）

function isIssueType(v: unknown): v is IssueType {
  return typeof v === 'string' && ISSUE_TYPES.includes(v as IssueType);
}

function isIssueStatus(v: unknown): v is IssueStatus {
  return typeof v === 'string' && ISSUE_STATUSES.includes(v as IssueStatus);
}

function isIssueSeverity(v: unknown): v is IssueSeverity {
  return typeof v === 'string' && ISSUE_SEVERITIES.includes(v as IssueSeverity);
}

function normalizeOptionalString(
  v: unknown,
  limit: number,
): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
}

function sanitizeIssueContext(v: unknown): IssueContext | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const raw = v as Record<string, unknown>;
  const out: IssueContext = {};
  let hasAny = false;
  for (const key of [
    'appVersion',
    'platform',
    'osVersion',
    'appLanguage',
    'locationName',
    'locationPath',
    'folderPath',
    'agentSessionId',
  ] as const) {
    const value = normalizeOptionalString(raw[key], CONTEXT_FIELD_LIMIT);
    if (value) {
      out[key] = value;
      hasAny = true;
    }
  }
  // Selected entries: paths only, capped (10 × 256 chars).
  if (Array.isArray(raw.selectedEntries)) {
    const paths = raw.selectedEntries
      .filter((p): p is string => typeof p === 'string' && !!p.trim())
      .map((p) => p.trim().slice(0, 256))
      .slice(0, 10);
    if (paths.length > 0) {
      out.selectedEntries = paths;
      hasAny = true;
    }
  }
  // Last failed tool call: a compact defect-evidence snapshot.
  const lte = raw.lastToolError as Record<string, unknown> | undefined;
  if (
    lte &&
    typeof lte === 'object' &&
    typeof lte.error === 'string' &&
    lte.error.trim()
  ) {
    out.lastToolError = {
      tool: normalizeOptionalString(lte.tool, 100) || 'unknown',
      ...(normalizeOptionalString(lte.args, 500) && {
        args: normalizeOptionalString(lte.args, 500),
      }),
      error: lte.error.trim().slice(0, 1000),
      at: typeof lte.at === 'number' ? lte.at : 0,
    };
    hasAny = true;
  }
  return hasAny ? out : undefined;
}

/**
 * Build a valid partial IssueItem from loose input (UI form or model-generated
 * tool args). Throws with a human-readable message on invalid input so the
 * caller can surface it without persisting.
 */
function sanitizeIssueInput(
  input: IssueCreateInput | IssueUpdateInput,
  requireTitle: boolean,
): Partial<IssueItem> {
  const out: Partial<IssueItem> = {};

  if (input.title !== undefined) {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title) throw new Error('Title is required');
    if (title.length > 200) throw new Error('Title too long (max 200 chars)');
    out.title = title;
  }

  if (input.description !== undefined) {
    out.description = normalizeOptionalString(input.description, 5000);
  }

  if (input.type !== undefined) {
    if (!isIssueType(input.type)) {
      throw new Error('Invalid type (expected bug or feature)');
    }
    out.type = input.type;
  }

  if (input.severity !== undefined) {
    if (!isIssueSeverity(input.severity)) throw new Error('Invalid severity');
    out.severity = input.severity;
  }

  if (input.status !== undefined) {
    if (!isIssueStatus(input.status)) throw new Error('Invalid status');
    out.status = input.status;
  }

  if (input.context !== undefined) {
    out.context = sanitizeIssueContext(input.context);
  }

  if (input.source !== undefined) {
    if (!ISSUE_SOURCES.includes(input.source as IssueSource)) {
      throw new Error('Invalid source');
    }
    out.source = input.source as IssueSource;
  }

  if (requireTitle && !out.title) throw new Error('Title is required');
  return out;
}

function isValidIssueItem(i: unknown): i is IssueItem {
  if (!i || typeof i !== 'object') return false;
  const item = i as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    typeof item.title === 'string' &&
    isIssueType(item.type) &&
    isIssueStatus(item.status) &&
    isIssueSeverity(item.severity) &&
    typeof item.createdAt === 'string' &&
    typeof item.updatedAt === 'string'
  );
}

/**
 * Stable per-machine short tag (e.g. "A7F3") used to prefix issue reference
 * ids so entries from different machines are distinguishable.
 *
 * Generation basis, in priority order:
 * 1. an existing `<dir>/machine.tag` file — the tag never changes once
 *    written, keeping already-exported documents' numbering meaningful.
 *    NOTE the conscious trade-off: cloning/restoring the whole userData
 *    directory copies this file too, so a cloned machine keeps the original
 *    tag. Accepted because stable numbering outweighs identity here —
 *    delete `machine.tag` on the clone to force re-derivation;
 * 2. a hash of the hardware machine id (macOS IOPlatformUUID / Windows
 *    MachineGuid / Linux /etc/machine-id) — deterministic per machine;
 * 3. random from a confusion-safe alphabet (no I/O/0/1) when the hardware
 *    id is unavailable.
 *
 * The tag space is 4 chars (~1M) — enough to tell a handful of machines
 * apart, not a cryptographic identity. Only the tag (a hash, never the raw
 * UUID) leaves the machine via the exported markdown.
 */
export function ensureMachineTag(
  dir: string,
  getMachineId: () => string | undefined = getHardwareMachineId,
): string {
  fs.ensureDirSync(dir);
  const tagFile = path.join(dir, 'machine.tag');
  try {
    if (fs.existsSync(tagFile)) {
      const existing = fs.readFileSync(tagFile, 'utf8').trim().toUpperCase();
      if (MACHINE_TAG_RE.test(existing)) return existing;
    }
    let tag = '';
    const machineId = getMachineId();
    if (machineId) {
      tag = deriveTagFromMachineId(machineId);
    } else {
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      tag = Array.from({ length: 4 }, () =>
        alphabet.charAt(Math.floor(Math.random() * alphabet.length)),
      ).join('');
    }
    fs.writeFileSync(tagFile, tag, 'utf8');
    return tag;
  } catch {
    // read-only dir etc. — fall back to a session-only tag
    return 'LOCAL';
  }
}

/** Map a hardware machine id deterministically into the 4-char tag space. */
export function deriveTagFromMachineId(machineId: string): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const digest = createHash('sha256')
    .update(machineId.trim().toLowerCase())
    .digest();
  let tag = '';
  for (let i = 0; tag.length < 4 && i < digest.length; i += 1) {
    const v = digest[i];
    const a = alphabet[v % 32];
    if (!tag.includes(a)) tag += a; // rejection sampling: keep chars unique
  }
  return tag.padEnd(4, alphabet[0]);
}

/** Best-effort hardware machine id per platform (no native deps). */
export function getHardwareMachineId(): string | undefined {
  try {
    if (process.platform === 'darwin') {
      const out = execSync('ioreg -rd1 -c IOPlatformExpertDevice', {
        encoding: 'utf8',
        timeout: 3000,
      });
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      return m?.[1];
    }
    if (process.platform === 'win32') {
      const out = execSync(
        'reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid',
        { encoding: 'utf8', timeout: 3000 },
      );
      const m = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
      return m?.[1];
    }
    if (process.platform === 'linux') {
      for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        if (fs.existsSync(p)) {
          const id = fs.readFileSync(p, 'utf8').trim();
          if (id) return id;
        }
      }
    }
  } catch {
    // restricted environment — caller falls back to a random tag
  }
  return undefined;
}

/**
 * Render the full collection as a handoff markdown document — everything a
 * developer (or an AI coding session) needs per entry: full description,
 * environment snapshot, related files and the last failed tool call. Entries
 * are referenced by their persistent ref (`{machineTag}-BUG-001`, assigned at
 * create and never renumbered); items missing a ref (hand-made in tests) fall
 * back to positional numbering.
 */
export function renderIssuesMarkdown(
  items: IssueItem[],
  machineTag?: string,
): string {
  const now = new Date().toISOString();
  const open = items.filter((i) => i.status === 'open').length;
  const lines: string[] = [
    '# 需求与缺陷收集',
    '',
    `> 导出时间: ${now.slice(0, 19).replace('T', ' ')}` +
      `${machineTag ? ` · 机器标识: ${machineTag}` : ''}` +
      ` · 共 ${items.length} 条（待处理 ${open} / 已处理 ${items.length - open}）`,
    '',
  ];
  const sections: Array<{ heading: string; type: IssueType; prefix: string }> =
    [
      { heading: '## 待修复缺陷 (bug)', type: 'bug', prefix: 'BUG' },
      { heading: '## 待开发功能 (feature)', type: 'feature', prefix: 'REQ' },
    ];
  for (const section of sections) {
    // newest first so BUG-001 is the most recent report
    const group = items
      .filter((i) => i.type === section.type)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (group.length === 0) continue;
    lines.push(section.heading, '');
    group.forEach((item, idx) => {
      const ref =
        item.ref ||
        `${machineTag ? `${machineTag}-` : ''}${section.prefix}-${String(idx + 1).padStart(3, '0')}`;
      lines.push(`### [${ref}] ${item.title.replace(/\r?\n/g, ' ')}`, '');
      lines.push(
        `- 状态: ${item.status === 'done' ? '已处理 (done)' : '待处理 (open)'}` +
          ` | 类型: ${item.type}` +
          (item.type === 'bug' ? ` | 严重程度: ${item.severity}` : '') +
          ` | 来源: ${item.source === 'agent' ? 'AI Agent 上报' : '手动'}`,
      );
      lines.push(
        `- 上报时间: ${item.createdAt.slice(0, 19).replace('T', ' ')}` +
          (item.resolvedAt
            ? ` · 处理时间: ${item.resolvedAt.slice(0, 19).replace('T', ' ')}`
            : ''),
      );
      const ctx = item.context;
      if (ctx) {
        const env = [
          ctx.appVersion && `应用 v${ctx.appVersion}`,
          ctx.platform &&
            `${ctx.platform}${ctx.osVersion ? ` (${ctx.osVersion})` : ''}`,
          ctx.appLanguage && `语言 ${ctx.appLanguage}`,
        ].filter(Boolean);
        if (env.length > 0) lines.push(`- 环境: ${env.join(' · ')}`);
        const where = [
          ctx.locationName &&
            `位置 ${ctx.locationName}${ctx.locationPath ? ` (${ctx.locationPath})` : ''}`,
          ctx.folderPath && `文件夹 ${ctx.folderPath}`,
        ].filter(Boolean);
        if (where.length > 0) lines.push(`- 场景: ${where.join(' · ')}`);
      }
      lines.push('');
      lines.push('#### 详情', '');
      lines.push(item.description?.trim() || '（无补充说明）', '');
      if (ctx?.selectedEntries?.length) {
        lines.push('#### 相关文件', '');
        ctx.selectedEntries.forEach((p) => lines.push(`- ${p}`));
        lines.push('');
      }
      if (ctx?.lastToolError) {
        const e = ctx.lastToolError;
        lines.push('#### 最近工具错误（缺陷现场）', '');
        lines.push(`- 工具: ${e.tool}`);
        if (e.args) lines.push(`- 参数: \`${e.args}\``);
        lines.push(`- 错误: ${e.error}`);
        if (e.at) {
          lines.push(`- 时间: ${new Date(e.at).toISOString()}`);
        }
        lines.push('');
      }
      lines.push('---', '');
    });
  }
  return lines.join('\n');
}

export class IssueDatabase {
  private issues: IssueItem[] = [];

  private filePath: string;

  /** Per-type ref counters, seeded from existing refs at load. */
  private counters: Record<IssueType, number> = { bug: 0, feature: 0 };

  /** Lazy machine-tag provider — only invoked when the first ref is needed. */
  private getMachineTag: () => string;

  constructor(filePath: string, getMachineTag: () => string = () => '') {
    if (!filePath) throw new Error('IssueDatabase requires a file path');
    this.filePath = filePath;
    this.getMachineTag = getMachineTag;
  }

  getPath(): string {
    return this.filePath;
  }

  /** Load the store from disk. Recovers from rotating backups when corrupt. */
  load(): { ok: boolean; recoveredFromBackup: boolean } {
    fs.ensureDirSync(path.dirname(this.filePath));
    const candidates = [this.filePath];
    for (let i = 0; i < MAX_BACKUPS; i += 1) {
      candidates.push(this.backupPath(i));
    }
    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      if (fs.existsSync(candidate)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
          const issues =
            parsed && Array.isArray(parsed.issues) ? parsed.issues : [];
          this.issues = issues.filter((t) => isValidIssueItem(t));
          this.seedRefsAndCounters();
          return { ok: true, recoveredFromBackup: i > 0 };
        } catch (err) {
          // Try the next backup; a corrupt file must never wipe the store.
        }
      }
    }
    this.issues = [];
    this.counters = { bug: 0, feature: 0 };
    return { ok: false, recoveredFromBackup: false };
  }

  /**
   * Legacy migration + counter seeding: items stored before refs existed get
   * a ref backfilled in the historical numbering order (bug/feature groups,
   * newest-first); counters continue from the highest number ever used, so
   * numbers are never reused even after deletions. Backfilled refs are
   * persisted on the next mutation.
   */
  private seedRefsAndCounters(): void {
    this.counters = { bug: 0, feature: 0 };
    const tag = this.getMachineTag();
    const parseNum = (ref: string, prefix: string) => {
      const m = ref.match(new RegExp(`^(?:[A-Z0-9]{4}-)?${prefix}-(\\d+)$`));
      return m ? parseInt(m[1], 10) : 0;
    };
    for (const item of this.issues) {
      const prefix = item.type === 'bug' ? 'BUG' : 'REQ';
      if (item.ref) {
        this.counters[item.type] = Math.max(
          this.counters[item.type],
          parseNum(item.ref, prefix),
        );
      }
    }
    for (const type of ['bug', 'feature'] as IssueType[]) {
      const prefix = type === 'bug' ? 'BUG' : 'REQ';
      const legacy = this.issues
        .filter((i) => i.type === type && !i.ref)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      for (const item of legacy) {
        this.counters[type] += 1;
        item.ref = `${tag ? `${tag}-` : ''}${prefix}-${String(this.counters[type]).padStart(3, '0')}`;
      }
    }
  }

  /** Allocate the next stable ref for the type (counters never go backwards). */
  private nextRef(type: IssueType): string {
    const tag = this.getMachineTag();
    const prefix = type === 'bug' ? 'BUG' : 'REQ';
    this.counters[type] += 1;
    return `${tag ? `${tag}-` : ''}${prefix}-${String(this.counters[type]).padStart(3, '0')}`;
  }

  list(filter: IssueFilter = {}): IssueListResult {
    const { type, status, keyword } = filter;
    const items = this.issues.filter((item) => {
      if (type && item.type !== type) return false;
      if (status && item.status !== status) return false;
      if (keyword) {
        const hay =
          `${item.title} ${item.description ?? ''} ` +
          `${item.context?.locationName ?? ''}`.toLowerCase();
        if (!hay.includes(keyword.toLowerCase())) return false;
      }
      return true;
    });
    // newest first — a collection list reads best in report order
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const open = this.issues.filter((i) => i.status === 'open').length;
    return {
      items,
      stats: {
        total: this.issues.length,
        open,
        done: this.issues.length - open,
      },
    };
  }

  create(input: IssueCreateInput): IssueItem {
    const sanitized = sanitizeIssueInput(input, true);
    const now = new Date().toISOString();
    const type = sanitized.type ?? 'bug';
    const item: IssueItem = {
      id: randomUUID(),
      ref: this.nextRef(type),
      title: sanitized.title!,
      description: sanitized.description,
      type,
      severity: sanitized.severity ?? 'medium',
      status: sanitized.status ?? 'open',
      context: sanitized.context,
      source: sanitized.source ?? DEFAULT_SOURCE,
      createdAt: now,
      updatedAt: now,
    };
    this.issues.push(item);
    this.persist();
    return item;
  }

  update(id: string, patch: IssueUpdateInput): IssueItem {
    const merged = this.applyUpdate(id, patch);
    this.persist();
    return merged;
  }

  /**
   * Batch status change (e.g. mark a batch of exported bugs as resolved).
   * One persist at the end — not one per item (each persist is a full atomic
   * write plus 10 backup rotations). Unknown ids are skipped and reported.
   * Duplicate ids are applied once.
   */
  updateMany(
    ids: string[],
    patch: { status: IssueStatus },
  ): { updated: number; missing: string[] } {
    const unique = [...new Set(ids.map(String))];
    const missing: string[] = [];
    let updated = 0;
    for (const id of unique) {
      try {
        this.applyUpdate(id, patch);
        updated += 1;
      } catch {
        missing.push(id);
      }
    }
    if (updated > 0) this.persist();
    return { updated, missing };
  }

  /** In-memory update, no persist — callers decide when to write. */
  private applyUpdate(id: string, patch: IssueUpdateInput): IssueItem {
    const index = this.issues.findIndex((i) => i.id === id);
    if (index < 0) throw new Error('Issue not found');
    const sanitized = sanitizeIssueInput(patch, false);
    const prev = this.issues[index];
    const merged: IssueItem = {
      ...prev,
      ...sanitized,
      id: prev.id,
      createdAt: prev.createdAt,
      // source and ref are immutable — later edits must not rewrite who
      // reported it or renumber the entry; context stays patchable so the
      // report_issue tool can enrich it with the app version after create
      source: prev.source,
      ref: prev.ref,
      context: sanitized.context ?? prev.context,
    };
    if (merged.status === 'done' && prev.status !== 'done') {
      merged.resolvedAt = new Date().toISOString();
    } else if (merged.status !== 'done' && prev.status === 'done') {
      merged.resolvedAt = undefined;
    }
    merged.updatedAt = new Date().toISOString();
    this.issues[index] = merged;
    return merged;
  }

  remove(id: string): number {
    const before = this.issues.length;
    this.issues = this.issues.filter((i) => i.id !== id);
    const removed = before - this.issues.length;
    if (removed > 0) this.persist();
    return removed;
  }

  /** Export the full collection to a Markdown file at targetPath. */
  exportMarkdown(targetPath: string, machineTag?: string): number {
    const md = renderIssuesMarkdown(this.issues, machineTag);
    fs.ensureDirSync(path.dirname(targetPath));
    fs.writeFileSync(targetPath, md, 'utf8');
    return this.issues.length;
  }

  private backupPath(index: number): string {
    return `${this.filePath}.bak.${index}`;
  }

  /** Atomic write: temp file then rename, with rotating backups. */
  private persist(): void {
    fs.ensureDirSync(path.dirname(this.filePath));
    const tmp = `${this.filePath}.tmp`;
    const data = JSON.stringify(
      {
        schemaVersion: SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        issues: this.issues,
      },
      null,
      2,
    );

    if (fs.existsSync(this.filePath)) {
      const last = this.backupPath(MAX_BACKUPS - 1);
      if (fs.existsSync(last)) fs.removeSync(last);
      for (let i = MAX_BACKUPS - 2; i >= 0; i -= 1) {
        const cur = this.backupPath(i);
        if (fs.existsSync(cur)) {
          fs.moveSync(cur, this.backupPath(i + 1), { overwrite: true });
        }
      }
      fs.copyFileSync(this.filePath, this.backupPath(0));
    }

    fs.writeFileSync(tmp, data, 'utf8');
    fs.moveSync(tmp, this.filePath, { overwrite: true });
  }
}
