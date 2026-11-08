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

import versionMeta from '-/version.json';

/**
 * Electron runtime version, parsed from the UA string ("... Electron/42.4.0 ...").
 * The renderer cannot read `process.versions` (sandbox + context isolation).
 */
function electronRuntimeVersion(): string | undefined {
  if (typeof navigator === 'undefined' || !navigator.userAgent) {
    return undefined;
  }
  const match = /Electron\/([\d.]+)/.exec(navigator.userAgent);
  return match ? match[1] : undefined;
}

/**
 * Resolve the version to display and report for the running app.
 *
 * `app.getVersion()` in the main process falls back to the Electron *runtime*
 * version when no application `package.json` can be loaded — which is exactly
 * what happens in unpackaged dev runs (`electron path/to/main.js`; nothing under
 * `release/app/dist` is a package). Reporting that number would make issues
 * filed from a dev build claim a release that never existed, so in that case we
 * use the build-time version (`src/renderer/version.json`, written by
 * scripts/versionmeta.js from release/app/package.json on every build).
 *
 * @param versionFromMain version reported by the main process (app.getVersion())
 */
export function resolveAppVersion(versionFromMain?: string): string {
  if (versionFromMain && versionFromMain !== electronRuntimeVersion()) {
    return versionFromMain;
  }
  return versionMeta.version || versionFromMain || '';
}
