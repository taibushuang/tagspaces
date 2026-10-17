/**
 * agentScheduler.ts — schedule model, cron computation and persistent store
 * for scheduled agent tasks.
 *
 * Zero `electron` imports: pure and unit-testable in plain Node. The IPC
 * wiring and the 30s due-tick live in agentSchedulerIpc.ts. Storage follows
 * todoStore.ts (in-memory master copy + atomic writes + rotating backups).
 *
 * Design decisions (see PLAN-agent-scheduled-tasks.md):
 * - The canonical representation is a 5-field cron string (local time).
 * - cron strings are never authored by humans or the model directly; they are
 *   produced from validated structured fields via scheduleToCron().
 * - dayOfMonth AND dayOfWeek both restricted = OR (standard Vixie cron), but
 *   scheduleToCron refuses to generate such schedules ("pick one" rule).
 * - Fire times align to 15-minute boundaries (minute ⊆ {0,15,30,45}).
 */

import { randomUUID } from 'crypto';
import fs from 'fs-extra';
import path from 'path';

// ---- schedule model --------------------------------------------------------

/** Structured schedule fields produced by the `schedule_task` tool. */
export interface ScheduleFields {
  minute?: number[];
  hour?: number[];
  dayOfMonth?: number[];
  month?: number[];
  dayOfWeek?: number[];
  stepHours?: number;
}

export type RunStatus = 'success' | 'failed' | 'skipped' | 'missed';

export interface RunResult {
  startedAt: number;
  status: RunStatus;
  detail?: string;
}

export interface AgentScheduledTask {
  id: string;
  name: string;
  prompt: string;
  schedule: { cron: string };
  locationId: string;
  /** Dedicated agent session this task runs in (created by the renderer on first run). */
  sessionId?: string;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  nextRunAt: number;
  lastResults: RunResult[];
}

export type ScheduledTaskCreateInput = {
  name: string;
  prompt: string;
  fields: ScheduleFields;
  locationId: string;
};

export type ScheduledTaskUpdateInput = Partial<
  Pick<
    AgentScheduledTask,
    'name' | 'prompt' | 'locationId' | 'enabled' | 'sessionId'
  >
> & { fields?: ScheduleFields };

export const MINUTE_ALIGNED = [0, 15, 30, 45];
const MONTHS_30 = new Set([4, 6, 9, 11]);
const MAX_TASKS = 20;
const MAX_RESULTS = 20;
const SCHEMA_VERSION = 1;
const MAX_BACKUPS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
export const MISSED_THRESHOLD_MS = 12 * 60 * 60 * 1000;
const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

// ---- cron parsing / matching ----------------------------------------------

/** A parsed 5-field cron. `null` for a field means `*` (any value). */
export interface CronSet {
  minute: Set<number> | null;
  hour: Set<number> | null;
  dayOfMonth: Set<number> | null;
  month: Set<number> | null;
  dayOfWeek: Set<number> | null;
}

function parseField(
  field: string,
  min: number,
  max: number,
): Set<number> | null {
  const f = field.trim();
  if (f === '*') return null;
  const out = new Set<number>();
  for (const part of f.split(',')) {
    const stepMatch = /^\*\/(\d+)$/.exec(part);
    if (stepMatch) {
      const step = parseInt(stepMatch[1], 10);
      if (step < 1) throw new Error(`Invalid cron step: ${part}`);
      for (let v = min; v <= max; v += step) out.add(v);
    } else if (/^\d+$/.test(part)) {
      const v = parseInt(part, 10);
      if (v < min || v > max)
        throw new Error(`Cron value out of range: ${part}`);
      out.add(v);
    } else {
      throw new Error(`Invalid cron field: ${part}`);
    }
  }
  return out;
}

export function parseCron(cron: string): CronSet {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression: ${cron}`);
  }
  return {
    minute: parseField(fields[0], 0, 59),
    hour: parseField(fields[1], 0, 23),
    dayOfMonth: parseField(fields[2], 1, 31),
    month: parseField(fields[3], 1, 12),
    dayOfWeek: parseField(fields[4], 0, 6),
  };
}

function dayMatches(cron: CronSet, date: Date): boolean {
  const dom = cron.dayOfMonth ? cron.dayOfMonth.has(date.getDate()) : false;
  const dow = cron.dayOfWeek ? cron.dayOfWeek.has(date.getDay()) : false;
  if (cron.dayOfMonth && cron.dayOfWeek) {
    // Standard cron: when both are restricted, EITHER matches (OR).
    return dom || dow;
  }
  if (cron.dayOfMonth) return dom;
  if (cron.dayOfWeek) return dow;
  return true;
}

/** Whether `date` falls on a fire instant defined by the parsed cron. */
export function matches(cron: CronSet, date: Date): boolean {
  if (cron.minute && !cron.minute.has(date.getMinutes())) return false;
  if (cron.hour && !cron.hour.has(date.getHours())) return false;
  if (cron.month && !cron.month.has(date.getMonth() + 1)) return false;
  return dayMatches(cron, date);
}

function sortedSet(set: Set<number>): number[] {
  return Array.from(set).sort((a, b) => a - b);
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * First fire instant strictly after `from`, walking day by day. Safe default
 * when a field is `*`: minute → {0}, hour → {0} (never a per-minute storm).
 */
export function nextRunAfter(cronStr: string, from: number): number {
  const cron = parseCron(cronStr);
  const minutes = cron.minute ?? new Set([0]);
  const hours = cron.hour ?? new Set([0]);
  const horizon = from + 5 * 366 * DAY_MS;
  let dayStart = startOfDay(from);
  while (dayStart < horizon) {
    const date = new Date(dayStart);
    const monthOk = !cron.month || cron.month.has(date.getMonth() + 1);
    if (monthOk && dayMatches(cron, date)) {
      for (const h of sortedSet(hours)) {
        for (const m of sortedSet(minutes)) {
          const ts = dayStart + h * HOUR_MS + m * MINUTE_MS;
          if (ts > from) return ts;
        }
      }
    }
    dayStart += DAY_MS;
  }
  throw new Error('No next run within horizon for cron: ' + cronStr);
}

function validateField(
  arr: number[] | undefined,
  min: number,
  max: number,
  name: string,
): Set<number> | undefined {
  if (arr === undefined || arr.length === 0) return undefined;
  const set = new Set<number>();
  for (const v of arr) {
    if (!Number.isInteger(v) || v < min || v > max) {
      throw new Error(`${name} out of range (${min}-${max})`);
    }
    set.add(v);
  }
  return set;
}

/**
 * Convert validated structured fields to a 5-field cron string. Throws on
 * invalid input so the IPC layer can surface a `{ error }` to the model.
 * Guards: minute ⊆ {0,15,30,45}; hour & minute required (no every-minute
 * storms); stepHours exclusive with hour; dayOfMonth & dayOfWeek mutually
 * exclusive ("pick one"); impossible dates (Feb 30/31, 31st of 30-day months).
 */
export function scheduleToCron(fields: ScheduleFields): string {
  const { minute, hour, dayOfMonth, month, dayOfWeek, stepHours } = fields;
  if (stepHours !== undefined) {
    if (hour !== undefined) {
      throw new Error('hour and stepHours are mutually exclusive');
    }
    if (!Number.isInteger(stepHours) || stepHours < 1 || stepHours > 23) {
      throw new Error('stepHours must be an integer in 1-23');
    }
    return `0 */${stepHours} * * *`;
  }
  if (!minute || minute.length === 0 || !hour || hour.length === 0) {
    throw new Error('minute and hour are required (use time or stepHours)');
  }
  for (const m of minute) {
    if (!MINUTE_ALIGNED.includes(m)) {
      throw new Error(
        `minute must be one of ${MINUTE_ALIGNED.join('/')} (15-min alignment)`,
      );
    }
  }
  if (
    dayOfWeek &&
    dayOfWeek.length > 0 &&
    dayOfMonth &&
    dayOfMonth.length > 0
  ) {
    throw new Error(
      'dayOfWeek and dayOfMonth cannot both be set — ask the user which one ' +
        'they meant, then resend with only that dimension',
    );
  }
  const minSet = validateField(minute, 0, 59, 'minute');
  const hourSet = validateField(hour, 0, 23, 'hour');
  const domSet = validateField(dayOfMonth, 1, 31, 'dayOfMonth');
  const monSet = validateField(month, 1, 12, 'month');
  const dowSet = validateField(dayOfWeek, 0, 6, 'dayOfWeek');
  if (monSet && domSet) {
    for (const mo of sortedSet(monSet)) {
      for (const d of sortedSet(domSet)) {
        if (mo === 2 && d > 29) {
          throw new Error('February has at most 29 days');
        }
        if (d === 31 && MONTHS_30.has(mo)) {
          throw new Error(`Month ${mo} has no 31st day`);
        }
      }
    }
  }
  const fmt = (set: Set<number> | undefined) =>
    set ? sortedSet(set).join(',') : '*';
  return [
    fmt(minSet),
    fmt(hourSet),
    fmt(domSet),
    fmt(monSet),
    fmt(dowSet),
  ].join(' ');
}

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** Human-readable rendering of a cron (English canonical). */
export function describeSchedule(cron: string): string {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`Invalid cron expression: ${cron}`);
  const [minField, hourField, domField, monField, dowField] = f;
  const hourStep = /^\*\/(\d+)$/.exec(hourField);
  if (hourStep) {
    const n = parseInt(hourStep[1], 10);
    return `every ${n} hour${n === 1 ? '' : 's'}`;
  }
  const hourPart =
    hourField === '*'
      ? 'every hour'
      : `${hourField.padStart(2, '0')}:${(minField === '*' ? '00' : minField).padStart(2, '0')}`;
  const domPart =
    domField === '*'
      ? ''
      : domField
          .split(',')
          .map((d) => `the ${ordinal(parseInt(d, 10))}`)
          .join(', ');
  const monPart =
    monField === '*'
      ? ''
      : monField
          .split(',')
          .map((m) => `month ${m}`)
          .join(', ');
  let dowPart = '';
  if (dowField !== '*') {
    const vals = dowField.split(',').map((s) => parseInt(s, 10));
    if (vals.every((v) => Number.isInteger(v) && v >= 0 && v <= 6)) {
      dowPart = vals.map((v) => WEEKDAYS[v]).join(', ');
    } else {
      dowPart = dowField;
    }
  }
  if (domField !== '*' && dowField !== '*') {
    // Both restricted: standard cron OR semantics — make it explicit.
    return `${hourPart} on ${domPart} or ${dowPart}`;
  }
  const when: string[] = [];
  if (domPart) when.push(`on ${domPart}`);
  if (monPart) when.push(monPart);
  if (dowPart) when.push(`on ${dowPart}`);
  return when.length > 0 ? `${hourPart} ${when.join(', ')}` : hourPart;
}

export function isDue(
  task: Pick<AgentScheduledTask, 'enabled' | 'nextRunAt'>,
  now: number,
): boolean {
  return task.enabled && task.nextRunAt <= now;
}

export function findOverdue(
  tasks: AgentScheduledTask[],
  now: number,
  missedThresholdMs: number = MISSED_THRESHOLD_MS,
): AgentScheduledTask[] {
  return tasks.filter(
    (t) => t.enabled && t.nextRunAt <= now - missedThresholdMs,
  );
}

// ---- persistence (todoStore-style file-backed store) ----------------------

function isValidTask(t: unknown): t is AgentScheduledTask {
  if (!t || typeof t !== 'object') return false;
  const x = t as Record<string, unknown>;
  const s = x.schedule as Record<string, unknown> | undefined;
  return (
    typeof x.id === 'string' &&
    typeof x.name === 'string' &&
    typeof x.prompt === 'string' &&
    !!s &&
    typeof s.cron === 'string' &&
    typeof x.locationId === 'string' &&
    typeof x.enabled === 'boolean' &&
    typeof x.createdAt === 'number' &&
    typeof x.nextRunAt === 'number' &&
    Array.isArray(x.lastResults)
  );
}

export class AgentSchedulerStore {
  private tasks: AgentScheduledTask[] = [];

  private filePath: string;

  constructor(filePath: string) {
    if (!filePath) throw new Error('AgentSchedulerStore requires a file path');
    this.filePath = filePath;
  }

  getPath(): string {
    return this.filePath;
  }

  /** Load the store from disk. Returns true when a previous file existed and parsed OK. */
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
          const tasks =
            parsed && Array.isArray(parsed.tasks) ? parsed.tasks : [];
          this.tasks = tasks.filter((t) => isValidTask(t));
          return { ok: true, recoveredFromBackup: i > 0 };
        } catch (err) {
          // Try the next backup; a corrupt file must never wipe the store.
        }
      }
    }
    this.tasks = [];
    return { ok: false, recoveredFromBackup: false };
  }

  list(): AgentScheduledTask[] {
    return this.tasks.map((t) => ({ ...t, lastResults: [...t.lastResults] }));
  }

  create(input: ScheduledTaskCreateInput): AgentScheduledTask {
    const cron = scheduleToCron(input.fields); // throws on invalid input
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const prompt = typeof input.prompt === 'string' ? input.prompt : '';
    if (!name) throw new Error('name is required');
    if (!prompt.trim()) throw new Error('prompt is required');
    if (typeof input.locationId !== 'string' || !input.locationId) {
      throw new Error('locationId is required');
    }
    if (this.tasks.length >= MAX_TASKS) {
      throw new Error(`Too many scheduled tasks (max ${MAX_TASKS})`);
    }
    const now = Date.now();
    const task: AgentScheduledTask = {
      id: randomUUID(),
      name,
      prompt,
      schedule: { cron },
      locationId: input.locationId,
      enabled: true,
      createdAt: now,
      nextRunAt: nextRunAfter(cron, now),
      lastResults: [],
    };
    this.tasks.push(task);
    this.persist();
    return { ...task, lastResults: [] };
  }

  update(id: string, patch: ScheduledTaskUpdateInput): AgentScheduledTask {
    const index = this.tasks.findIndex((t) => t.id === id);
    if (index < 0) throw new Error('Scheduled task not found');
    const prev = this.tasks[index];
    let cron = prev.schedule.cron;
    if (patch.fields) cron = scheduleToCron(patch.fields); // throws on invalid
    const name =
      patch.name !== undefined
        ? typeof patch.name === 'string'
          ? patch.name.trim()
          : ''
        : prev.name;
    if (!name) throw new Error('name is required');
    const next: AgentScheduledTask = {
      ...prev,
      name,
      prompt: patch.prompt !== undefined ? patch.prompt : prev.prompt,
      locationId:
        patch.locationId !== undefined ? patch.locationId : prev.locationId,
      enabled: patch.enabled !== undefined ? patch.enabled : prev.enabled,
      sessionId:
        patch.sessionId !== undefined ? patch.sessionId : prev.sessionId,
      schedule: { cron },
      lastResults: [...prev.lastResults],
    };
    if (cron !== prev.schedule.cron) {
      next.nextRunAt = nextRunAfter(cron, Date.now());
    } else if (
      patch.enabled === true &&
      prev.enabled === false &&
      next.nextRunAt <= Date.now()
    ) {
      // Re-enabling a task that was paused must not fire immediately on the
      // next tick (its nextRunAt may have gone stale in the past) — schedule
      // from now forward instead of re-running the old past slot.
      next.nextRunAt = nextRunAfter(cron, Date.now());
    }
    this.tasks[index] = next;
    this.persist();
    return { ...next };
  }

  remove(id: string): number {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== id);
    const removed = before - this.tasks.length;
    if (removed > 0) this.persist();
    return removed;
  }

  /** Record a run outcome and advance nextRunAt. Returns the updated task. */
  reportResult(
    id: string,
    result: { status: RunStatus; detail?: string; ranAt: number },
  ): AgentScheduledTask | undefined {
    const index = this.tasks.findIndex((t) => t.id === id);
    if (index < 0) return undefined;
    const t = this.tasks[index];
    const entry: RunResult = {
      startedAt: result.ranAt,
      status: result.status,
      detail: result.detail,
    };
    const lastResults = [...t.lastResults, entry].slice(-MAX_RESULTS);
    const next: AgentScheduledTask = {
      ...t,
      lastResults,
      lastRunAt: result.ranAt,
      nextRunAt: nextRunAfter(t.schedule.cron, Date.now()),
    };
    this.tasks[index] = next;
    this.persist();
    return { ...next };
  }

  private backupPath(index: number): string {
    return `${this.filePath}.bak.${index}`;
  }

  /** Atomic write: temp file then rename, with rotating backups of the previous version. */
  private persist(): void {
    fs.ensureDirSync(path.dirname(this.filePath));
    const tmp = `${this.filePath}.tmp`;
    const data = JSON.stringify(
      {
        schemaVersion: SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        tasks: this.tasks,
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
