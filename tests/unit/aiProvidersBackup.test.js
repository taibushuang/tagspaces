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
import { describe, expect, test } from '@playwright/test';
import {
  backupAiProviders,
  restoreAiProvidersIfNeeded,
} from '-/services/aiProvidersBackup';

const ark = [
  {
    id: 'p1',
    engine: 'openai-compatible',
    name: '火山方舟 Ark',
    url: 'https://ark.example/api/v3',
    enable: true,
  },
];

// Node test env has no localStorage — provide a minimal in-memory stub.
if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    clear: () => mem.clear(),
  };
}

function fakeStore(rehydrated, providers) {
  const state = {
    _persist: { rehydrated },
    settings: { aiProviders: providers },
  };
  const dispatched = [];
  return {
    state,
    dispatched,
    getState: () => state,
    dispatch: (a) => {
      dispatched.push(a);
      return a;
    },
  };
}

describe('aiProvidersBackup', () => {
  test('backup skips before rehydration and for empty provider lists', () => {
    localStorage.removeItem('tsAiProvidersBackup');
    const cold = fakeStore(false, ark);
    backupAiProviders(cold.state);
    expect(localStorage.getItem('tsAiProvidersBackup')).toBe(null);

    const empty = fakeStore(true, []);
    backupAiProviders(empty.state);
    expect(localStorage.getItem('tsAiProvidersBackup')).toBe(null);
  });

  test('backup stores non-empty provider list after rehydration', () => {
    localStorage.removeItem('tsAiProvidersBackup');
    const store = fakeStore(true, ark);
    backupAiProviders(store.state);
    const raw = localStorage.getItem('tsAiProvidersBackup');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw);
    expect(parsed.providers).toEqual(ark);
  });

  test('restore dispatches backup when persisted list is empty', () => {
    localStorage.setItem(
      'tsAiProvidersBackup',
      JSON.stringify({ ts: Date.now(), providers: ark }),
    );
    const store = fakeStore(true, []);
    restoreAiProvidersIfNeeded(store);
    expect(store.dispatched).toHaveLength(1);
  });

  test('restore is a no-op when providers exist or no backup', () => {
    localStorage.removeItem('tsAiProvidersBackup');
    const hasProviders = fakeStore(true, ark);
    restoreAiProvidersIfNeeded(hasProviders);
    expect(hasProviders.dispatched).toHaveLength(0);

    localStorage.setItem(
      'tsAiProvidersBackup',
      JSON.stringify({ ts: Date.now(), providers: ark }),
    );
    const hasProviders2 = fakeStore(true, ark);
    restoreAiProvidersIfNeeded(hasProviders2);
    expect(hasProviders2.dispatched).toHaveLength(0);
  });
});
