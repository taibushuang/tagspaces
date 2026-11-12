/**
 * TagSpaces - universal file and folder organizer
 * Copyright (C) 2017-present TagSpaces GmbH
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
import { REHYDRATE } from 'redux-persist/lib/constants';

/**
 * One-time migration for the notes perspective (2026-11): profiles persisted
 * before it existed have an enabledPerspectives list without it, which would
 * keep the new perspective hidden after upgrade. Rehydrated profiles get it
 * merged in once; the flag in settings prevents re-adding it after the user
 * deliberately disables it again.
 *
 * The flag is written even when notes is already enabled (fresh installs ship
 * it by default). Otherwise a fresh-install user who disables notes would get
 * it resurrected on the next start, because the flag would never be set.
 *
 * Kept free of Redux/React imports so it can be unit-tested directly.
 */
export const NOTES_PERSPECTIVE_MIGRATION_FLAG = 'notesPerspectiveMigrated';

export function migrateNotesPerspective(
  state: any,
  action: any,
  notesPerspectiveId: string,
  extEnabledPerspectives?: unknown,
) {
  if (action?.type !== REHYDRATE || action?.key !== 'root') {
    return state;
  }
  const rehydratedSettings = state?.settings;
  if (
    !rehydratedSettings ||
    rehydratedSettings[NOTES_PERSPECTIVE_MIGRATION_FLAG]
  ) {
    return state;
  }
  const enabled: unknown = rehydratedSettings.enabledPerspectives;
  // A deployment-pinned white-list is authoritative; leave persisted
  // preferences untouched and let the selector ignore them.
  if (!Array.isArray(enabled) || extEnabledPerspectives) {
    return state;
  }
  return {
    ...state,
    settings: {
      ...rehydratedSettings,
      enabledPerspectives: enabled.includes(notesPerspectiveId)
        ? enabled
        : [...enabled, notesPerspectiveId],
      [NOTES_PERSPECTIVE_MIGRATION_FLAG]: true,
    },
  };
}
