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
 * Persistence for folder-organization history — a journal of what organize_apply
 * moved, so organize_undo can put files back. Stored in localStorage (same
 * philosophy as the `tsDiskInitState` disk-init marker), capped to the most
 * recent records.
 */
import { Fingerprint, OrganizeConfig } from '-/utils/fileOrganizer';

const HISTORY_KEY = 'tsOrganizeHistory';
const MAX_RECORDS = 20;

export type OrganizeItemState = 'pending' | 'moved' | 'restored' | 'failed';
export type OrganizeRecordStatus =
  | 'pending'
  | 'done'
  | 'partial'
  | 'failed'
  | 'undone';

export type OrganizeItem = {
  original: string;
  moved: string;
  category: string;
  fingerprint: Fingerprint;
  state: OrganizeItemState;
  error?: string;
};

export type OrganizeRecord = {
  id: string;
  root: string;
  date: string;
  config: OrganizeConfig;
  status: OrganizeRecordStatus;
  items: OrganizeItem[];
};

export function readOrganizeHistory(): OrganizeRecord[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeOrganizeHistory(records: OrganizeRecord[]): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify(records.slice(-MAX_RECORDS)),
    );
  } catch {
    /* storage full / unavailable — keep in-memory only */
  }
}

export function appendOrganizeRecord(record: OrganizeRecord): void {
  const records = readOrganizeHistory();
  records.push(record);
  writeOrganizeHistory(records);
}

export function updateOrganizeRecord(
  id: string,
  patch: Partial<OrganizeRecord>,
): void {
  const records = readOrganizeHistory();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return;
  records[idx] = { ...records[idx], ...patch };
  writeOrganizeHistory(records);
}

export function getOrganizeRecord(
  id: string | undefined,
): OrganizeRecord | undefined {
  const records = readOrganizeHistory();
  if (id) return records.find((r) => r.id === id);
  return records[records.length - 1];
}
