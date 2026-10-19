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
 * Agent delete capability — pure guardrail logic + per-folder authorization.
 *
 * Design (see DESIGN-ai-agent.md):
 * - Deletion always goes to the SYSTEM TRASH (recoverable) — never a hard
 *   delete; the tool layer has no permanent-delete path at all.
 * - Authorization is enforced deterministically here, not by prompt: every
 *   deletion is authorized by its CONTAINING FOLDER. Without a stored grant
 *   the tool layer must show a confirmation dialog listing the files; an
 *   approval can be remembered per folder (localStorage, capped).
 * - Protected paths are refused outright: location roots, anything inside
 *   `<location>/.ts` metadata, hidden/system entries, paths outside every
 *   connected location.
 */

const DELETE_AUTH_KEY = 'tsAgentDeleteAuth';
const DELETE_HISTORY_KEY = 'tsAgentDeleteHistory';
const MAX_DELETE_GRANTS = 100;
const MAX_DELETE_HISTORY = 20;
/** Maximum paths accepted by one delete_files call. */
export const DELETE_BATCH_LIMIT = 50;

export type DeletePlanItem = {
  path: string;
  name: string;
  isFile: boolean;
  size?: number;
};

export type DeletePlanInvalid = { path: string; reason: string };

export type DeleteRecord = {
  id: string;
  date: string;
  items: Array<{
    path: string;
    name: string;
    isFile: boolean;
    ok: boolean;
    error?: string;
  }>;
};

/** Normalize any platform path for comparison: forward slashes, no trailing separator. */
export function normalizeDeletionPath(p: string): string {
  return String(p || '')
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '');
}

export function parentFolderPath(p: string): string {
  const norm = normalizeDeletionPath(p);
  const idx = norm.lastIndexOf('/');
  return idx > 0 ? norm.slice(0, idx) : norm;
}

export function baseDeletionName(p: string): string {
  const norm = normalizeDeletionPath(p);
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

function isHiddenDeletionName(name: string): boolean {
  const lower = name.toLocaleLowerCase();
  return (
    name.startsWith('.') ||
    lower === 'desktop.ini' ||
    lower === 'thumbs.db' ||
    lower === '.ds_store'
  );
}

/**
 * Return the guardrail reason when the path must NEVER be deleted (agent or
 * otherwise), or undefined when deletion is permitted. Pure — unit-testable.
 */
export function deletionGuardReason(
  path: string,
  locationPaths: string[],
): string | undefined {
  const norm = normalizeDeletionPath(path);
  if (!norm) return 'empty path';
  const roots = (locationPaths || []).map(normalizeDeletionPath);
  const owning = roots.find(
    (root) => norm === root || norm.startsWith(`${root}/`),
  );
  if (!owning) {
    return 'path is outside all connected locations';
  }
  if (norm === owning) {
    return 'refusing to delete a location root folder';
  }
  const relative = norm.slice(owning.length + 1);
  if (relative.split('/').includes('.ts')) {
    return 'refusing to delete TagSpaces metadata (.ts folder)';
  }
  if (isHiddenDeletionName(baseDeletionName(norm))) {
    return 'hidden or system entries are never deleted';
  }
  return undefined;
}

/**
 * Validate a delete plan: normalize, de-duplicate, drop entries protected by
 * the guardrails. `isFile` is the tool's contract: delete_files only accepts
 * files (folders go through delete_folder), delete_folder only folders.
 */
export function validateDeletePlan(
  items: Array<{ path: string; isFile: boolean; name?: string; size?: number }>,
  locationPaths: string[],
  expectedIsFile: boolean,
): { valid: DeletePlanItem[]; invalid: DeletePlanInvalid[] } {
  const valid: DeletePlanItem[] = [];
  const invalid: DeletePlanInvalid[] = [];
  const seen = new Set<string>();
  for (const raw of items || []) {
    const norm = normalizeDeletionPath(raw?.path);
    if (!norm) {
      invalid.push({ path: String(raw?.path || ''), reason: 'empty path' });
      continue;
    }
    if (seen.has(norm)) continue;
    seen.add(norm);
    const guard = deletionGuardReason(norm, locationPaths);
    if (guard) {
      invalid.push({ path: norm, reason: guard });
      continue;
    }
    if (raw.isFile !== expectedIsFile) {
      invalid.push({
        path: norm,
        reason: expectedIsFile
          ? 'is a folder — use delete_folder for empty folders'
          : 'is a file — delete_files only handles files',
      });
      continue;
    }
    valid.push({
      path: norm,
      name: raw.name || baseDeletionName(norm),
      isFile: raw.isFile,
      ...(typeof raw.size === 'number' ? { size: raw.size } : {}),
    });
  }
  return { valid, invalid };
}

// --- per-folder authorization grants (localStorage, capped) ---

type DeleteGrantMap = Record<string, { at: number }>;

function readGrantMap(): DeleteGrantMap {
  if (typeof window === 'undefined' || !window.localStorage) return {};
  try {
    const raw = window.localStorage.getItem(DELETE_AUTH_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeGrantMap(map: DeleteGrantMap): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(DELETE_AUTH_KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable — grants stay session-only */
  }
}

export function isDeleteGranted(folderPath: string): boolean {
  const map = readGrantMap();
  return !!map[normalizeDeletionPath(folderPath)];
}

export function grantDelete(folderPath: string): void {
  const map = readGrantMap();
  const norm = normalizeDeletionPath(folderPath);
  map[norm] = { at: Date.now() };
  // evict the oldest grants when over the cap
  const entries = Object.entries(map).sort(
    (a, b) => (a[1]?.at || 0) - (b[1]?.at || 0),
  );
  const evicted = entries.slice(
    0,
    Math.max(0, entries.length - MAX_DELETE_GRANTS),
  );
  evicted.forEach(([key]) => delete map[key]);
  writeGrantMap(map);
}

export function revokeDelete(folderPath: string): void {
  const map = readGrantMap();
  delete map[normalizeDeletionPath(folderPath)];
  writeGrantMap(map);
}

export function listDeleteGrants(): Array<{ path: string; at: number }> {
  return Object.entries(readGrantMap()).map(([path, v]) => ({
    path,
    at: v?.at || 0,
  }));
}

// --- deletion history (localStorage, capped) — what went to the trash ---

export function readDeleteHistory(): DeleteRecord[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(DELETE_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function appendDeleteRecord(
  record: Omit<DeleteRecord, 'date'> & { date?: string },
): void {
  const records = readDeleteHistory();
  records.push({ ...record, date: record.date || new Date().toISOString() });
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(
        DELETE_HISTORY_KEY,
        JSON.stringify(records.slice(-MAX_DELETE_HISTORY)),
      );
    } catch {
      /* storage full — history is best-effort */
    }
  }
}
