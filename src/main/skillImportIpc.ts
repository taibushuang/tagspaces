/**
 * IPC wiring for the external-skill importer. The scanner lives in
 * skillScanner.ts (electron-free, unit-testable); this file registers the
 * skillsScan channel against userData/skillImport as the storage dir.
 */

import { app, ipcMain } from 'electron';
import path from 'path';
import type { SkillDeleteCopyRequest, SkillScanRequest } from './ipcContracts';
import {
  deleteImportedCopy,
  prepareSkillImport,
  scanAll,
} from './skillScanner';

export default function initSkillImport(): void {
  const storageDir = path.join(app.getPath('userData'), 'skillImport');
  const importedRoot = path.join(storageDir, 'imported');
  // Param annotations come from the shared IPC contracts
  // (src/main/ipcContracts.ts) so renderer/main drift fails tsc.
  ipcMain.handle('skillsScan', (_event, options: SkillScanRequest = {}) =>
    scanAll(storageDir, options),
  );
  ipcMain.handle('skillsImportDir', async (_event, srcDir: string) =>
    prepareSkillImport(String(srcDir || ''), importedRoot),
  );
  ipcMain.handle(
    'skillsDeleteCopy',
    async (_event, payload: SkillDeleteCopyRequest) => {
      const removed = deleteImportedCopy(
        String(payload?.name || ''),
        String(payload?.sourceDir || ''),
        importedRoot,
      );
      return { removed };
    },
  );
}
