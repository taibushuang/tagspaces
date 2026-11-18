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
 */

/**
 * In-memory diagnostic log for agent runs: model request start/end, HTTP
 * failures (status + response body), timeouts, network errors and tool
 * failures. The chat bubble only carries a short warning; when a request
 * stalls there is nothing in the bubble at all, which is why the agent panel
 * exposes this log in a dedicated debug view.
 *
 * Module-level (not React state) so entries survive the panel being
 * unmounted, and a ring buffer so an endless agent loop cannot grow memory
 * unboundedly.
 */
import { format } from 'date-fns';

export type AgentDebugLevel = 'info' | 'warn' | 'error';

export type AgentDebugEntry = {
  id: number;
  at: number;
  level: AgentDebugLevel;
  title: string;
  detail?: string;
};

export const MAX_AGENT_DEBUG_ENTRIES = 500;
const MAX_DETAIL_CHARS = 4000;

let entries: AgentDebugEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

export function logAgentDebug(
  level: AgentDebugLevel,
  title: string,
  detail?: string,
): AgentDebugEntry {
  const entry: AgentDebugEntry = {
    id: nextId,
    at: Date.now(),
    level,
    title,
    ...(detail ? { detail: detail.slice(0, MAX_DETAIL_CHARS) } : {}),
  };
  nextId += 1;
  entries = [...entries, entry];
  if (entries.length > MAX_AGENT_DEBUG_ENTRIES) {
    entries = entries.slice(entries.length - MAX_AGENT_DEBUG_ENTRIES);
  }
  notify();
  return entry;
}

/**
 * Snapshot for useSyncExternalStore — returns the same array reference until
 * an entry is appended/cleared, so React does not re-render on every read.
 */
export function getAgentDebugSnapshot(): AgentDebugEntry[] {
  return entries;
}

export function subscribeAgentDebugLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearAgentDebugLog(): void {
  if (entries.length === 0) {
    return;
  }
  entries = [];
  notify();
}

/** Plain-text dump for the copy button (chronological, newest last). */
export function formatAgentDebugLog(list: AgentDebugEntry[] = entries): string {
  if (list.length === 0) {
    return '';
  }
  return list
    .map((entry) => {
      const head = `${format(entry.at, 'yyyy-MM-dd HH:mm:ss.SSS')} [${entry.level.toUpperCase()}] ${entry.title}`;
      if (!entry.detail) {
        return head;
      }
      return `${head}\n${entry.detail
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n')}`;
    })
    .join('\n');
}

/** Human-readable elapsed time for the "last event" line. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
