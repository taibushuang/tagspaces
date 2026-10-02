/**
 * IPC wiring for the Todo feature. Loads the TodoDatabase against the
 * per-user data directory and registers the todo:* channels. Kept separate
 * from todoStore.ts so the store itself stays unit-testable without Electron.
 */

import { app, dialog, ipcMain } from 'electron';
import path from 'path';
import { TodoDatabase } from './todoStore';

export default function initTodoStore(): TodoDatabase {
  const dir = path.join(app.getPath('userData'), 'todo');
  const db = new TodoDatabase(path.join(dir, 'todos.json'));
  db.load();

  ipcMain.handle('todo:list', async (_event, filter) => db.list(filter));
  ipcMain.handle('todo:create', async (_event, input) => db.create(input));
  ipcMain.handle('todo:update', async (_event, id, patch) =>
    db.update(id, patch),
  );
  ipcMain.handle('todo:remove', async (_event, id) => db.remove(id));
  ipcMain.handle('todo:getPath', async () => ({ file: db.getPath(), dir }));

  ipcMain.handle('todo:exportMarkdown', async (_event, includeDone) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export todos',
      defaultPath: path.join(app.getPath('documents'), 'todos.md'),
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'Text', extensions: ['txt'] },
      ],
    });
    if (canceled || !filePath) {
      return { canceled: true, count: 0, filePath: null };
    }
    const count = db.exportMarkdown(filePath, Boolean(includeDone));
    return { canceled: false, count, filePath };
  });

  return db;
}
