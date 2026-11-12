import { describe, expect, test } from '@playwright/test';
import {
  migrateNotesPerspective,
  NOTES_PERSPECTIVE_MIGRATION_FLAG,
} from '-/reducers/notesPerspectiveMigration';
import { REHYDRATE } from 'redux-persist/lib/constants';

const rehydrate = (payload) => ({
  type: REHYDRATE,
  key: 'root',
  payload,
});

const state = (enabled, flag) => ({
  settings: {
    enabledPerspectives: enabled,
    ...(flag ? { [NOTES_PERSPECTIVE_MIGRATION_FLAG]: true } : {}),
  },
});

describe('migrateNotesPerspective', () => {
  test('non-REHYDRATE actions pass through untouched', () => {
    const s = { settings: { enabledPerspectives: ['grid'] } };
    expect(
      migrateNotesPerspective(s, { type: 'some/action' }, 'notes'),
    ).toBe(s);
  });

  test('rehydrates other persist keys pass through untouched', () => {
    const s = { settings: { enabledPerspectives: ['grid'] } };
    expect(migrateNotesPerspective(s, { type: REHYDRATE, key: 'other' }, 'notes')).toBe(s);
  });

  test('old profile without notes: notes appended and flag written', () => {
    const result = migrateNotesPerspective(
      state(['grid', 'list']),
      rehydrate({}),
      'notes',
    );
    expect(result.settings.enabledPerspectives).toEqual([
      'grid',
      'list',
      'notes',
    ]);
    expect(result.settings[NOTES_PERSPECTIVE_MIGRATION_FLAG]).toBe(true);
  });

  test('fresh install with notes already enabled: flag written, list unchanged', () => {
    const result = migrateNotesPerspective(
      state(['grid', 'list', 'notes']),
      rehydrate({}),
      'notes',
    );
    expect(result.settings.enabledPerspectives).toEqual([
      'grid',
      'list',
      'notes',
    ]);
    expect(result.settings[NOTES_PERSPECTIVE_MIGRATION_FLAG]).toBe(true);
  });

  test('flag present: user-disabled notes is NOT resurrected', () => {
    const s = state(['grid', 'list'], true);
    expect(migrateNotesPerspective(s, rehydrate({}), 'notes')).toBe(s);
  });

  test('ext-locked deployments leave persisted preferences untouched', () => {
    const s = { settings: { enabledPerspectives: ['grid'] } };
    expect(
      migrateNotesPerspective(s, rehydrate({}), 'notes', ['grid']),
    ).toBe(s);
  });

  test('missing settings slice passes through untouched', () => {
    const s = {};
    expect(migrateNotesPerspective(s, rehydrate({}), 'notes')).toBe(s);
  });
});
