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
 * Renderer-side mirror of the pure scheduling helpers in
 * src/main/agentScheduler.ts.
 *
 * The main module also owns the file-backed store (fs-extra + crypto), so it
 * must never be imported by the renderer — doing so drags Node-only modules
 * into the browser bundle. Only the types are shared (type-only imports are
 * erased at compile time). Keep the implementations below in sync with the
 * main-process functions; the main process remains the single source of truth
 * for scheduling semantics.
 */

import type { AgentScheduledTask } from '../../main/agentScheduler';

export type { AgentScheduledTask } from '../../main/agentScheduler';

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

/** Human-readable rendering of a 5-field cron (English canonical). */
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

/**
 * Tasks whose last scheduled fire is older than the missed threshold —
 * the data source for the startup catch-up banner.
 */
export function findOverdue(
  tasks: AgentScheduledTask[],
  now: number,
  missedThresholdMs: number = MISSED_THRESHOLD_MS,
): AgentScheduledTask[] {
  return tasks.filter(
    (t) => t.enabled && t.nextRunAt <= now - missedThresholdMs,
  );
}
