/**
 * IPC wiring for the external-skill importer. The scanner lives in
 * skillScanner.ts (electron-free, unit-testable); this file registers the
 * skillsScan channel against userData/skillImport as the storage dir.
 */

import { app, ipcMain } from 'electron';
import path from 'path';
import {
  deleteImportedCopy,
  prepareSkillImport,
  scanAll,
} from './skillScanner';

export default function initSkillImport(): void {
  const storageDir = path.join(app.getPath('userData'), 'skillImport');
  const importedRoot = path.join(storageDir, 'imported');
  ipcMain.handle('skillsScan', async (_event, options) =>
    scanAll(storageDir, options || {}),
  );
  ipcMain.handle('skillsImportDir', async (_event, srcDir) =>
    prepareSkillImport(String(srcDir || ''), importedRoot),
  );
  ipcMain.handle('skillsDeleteCopy', async (_event, payload) => {
    const removed = deleteImportedCopy(
      String(payload?.name || ''),
      String(payload?.sourceDir || ''),
      importedRoot,
    );
    return { removed };
  });
}
