/**
 * IPC wiring for the issue collection feature (需求与缺陷收集). Loads the
 * IssueDatabase against the per-user data directory and registers the
 * issue:* channels. Kept separate from issueStore.ts so the store itself
 * stays unit-testable without Electron.
 */

import { app, dialog, ipcMain } from 'electron';
import os from 'os';
import path from 'path';
import { IssueDatabase, ensureMachineTag } from './issueStore';

export default function initIssueStore(): IssueDatabase {
  const dir = path.join(app.getPath('userData'), 'issues');
  // Machine tag is computed lazily on first use (panel open / export / agent
  // report) — the hardware-id probe (execSync) must not slow down app start.
  let machineTagCache: string | undefined;
  const getMachineTag = () => {
    if (machineTagCache === undefined) {
      machineTagCache = ensureMachineTag(dir);
    }
    return machineTagCache;
  };
  const db = new IssueDatabase(path.join(dir, 'issues.json'), getMachineTag);
  db.load();

  ipcMain.handle('issue:list', async (_event, filter) => db.list(filter));
  ipcMain.handle('issue:create', async (_event, input) => db.create(input));
  ipcMain.handle('issue:update', async (_event, id, patch) =>
    db.update(id, patch),
  );
  ipcMain.handle('issue:updateMany', async (_event, ids, patch) =>
    db.updateMany(Array.isArray(ids) ? ids.map(String) : [], patch),
  );
  ipcMain.handle('issue:remove', async (_event, id) => db.remove(id));
  ipcMain.handle('issue:getPath', async () => ({
    file: db.getPath(),
    dir,
    version: app.getVersion(),
    platform: process.platform,
    osVersion: os.release(),
    appLanguage: app.getLocale(),
    machineTag: getMachineTag(),
  }));

  ipcMain.handle('issue:exportMarkdown', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export issues',
      defaultPath: path.join(app.getPath('documents'), 'issues.md'),
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'Text', extensions: ['txt'] },
      ],
    });
    if (canceled || !filePath) {
      return { canceled: true, count: 0, filePath: null };
    }
    const count = db.exportMarkdown(filePath, getMachineTag());
    return { canceled: false, count, filePath, machineTag: getMachineTag() };
  });

  return db;
}
