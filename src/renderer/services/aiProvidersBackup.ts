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
 * Self-healing backup for the AI provider configuration.
 *
 * The redux-persist slice has been observed to lose `settings.aiProviders`
 * occasionally (startup race, root cause not pinned down) — the user's
 * endpoint URL + API key vanish and must be re-entered by hand. This module
 * keeps a rolling backup of the provider list under a dedicated localStorage
 * key and restores it when redux-persist comes back empty.
 */

import { AIProvider } from '-/components/chat/ChatTypes';
import {
  actions as SettingsActions,
  getAIProviders,
} from '-/reducers/settings';

const BACKUP_KEY = 'tsAiProvidersBackup';
const BACKUP_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

type Backup = { ts: number; providers: AIProvider[] };

function readBackup(): Backup | undefined {
  try {
    const raw = localStorage.getItem(BACKUP_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Backup;
    if (!Array.isArray(parsed.providers) || parsed.providers.length === 0) {
      return undefined;
    }
    if (Date.now() - parsed.ts > BACKUP_MAX_AGE_MS) {
      return undefined;
    }
    return parsed;
  } catch (e) {
    return undefined;
  }
}

/**
 * Store the current (non-empty) provider list. Called after every store
 * update once rehydration has finished.
 */
export function backupAiProviders(state: any): void {
  try {
    if (!state?._persist?.rehydrated) return;
    const providers = getAIProviders(state);
    if (!Array.isArray(providers) || providers.length === 0) return;
    const current = readBackup();
    if (
      current &&
      JSON.stringify(current.providers) === JSON.stringify(providers)
    ) {
      return;
    }
    localStorage.setItem(
      BACKUP_KEY,
      JSON.stringify({ ts: Date.now(), providers } as Backup),
    );
  } catch (e) {
    /* backup must never break the store */
  }
}

/**
 * If redux-persist recovered no providers but a backup exists, dispatch the
 * backup back into the store. Called once, from the persistStore callback.
 */
export function restoreAiProvidersIfNeeded(store: {
  getState: () => any;
  dispatch: (a: any) => any;
}): void {
  try {
    const state = store.getState();
    if (!state?._persist?.rehydrated) return;
    const providers = getAIProviders(state);
    if (Array.isArray(providers) && providers.length > 0) return;
    const backup = readBackup();
    if (!backup) return;
    store.dispatch(SettingsActions.setAiProviders(backup.providers));
    console.log(
      '[ai-backup] restored',
      backup.providers.length,
      'AI provider(s) from backup',
    );
  } catch (e) {
    console.warn('[ai-backup] restore failed:', e);
  }
}
