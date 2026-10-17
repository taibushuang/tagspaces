/**
 * IPC wiring for the scheduled agent tasks feature: loads the
 * AgentSchedulerStore against the per-user data directory, registers the
 * scheduledTask:* channels and runs a 30s tick that broadcasts due tasks.
 * Kept separate from agentScheduler.ts so the store stays unit-testable
 * without Electron.
 *
 * Division of labour (see PLAN-agent-scheduled-tasks.md): the main process
 * only decides WHEN a task is due (persistence + time computation +
 * broadcast); the renderer decides HOW to run it (session, context,
 * runAgent, result reporting).
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import {
  AgentSchedulerStore,
  ScheduledTaskUpdateInput,
  isDue,
} from './agentScheduler';

const TICK_MS = 30_000;

export default function initAgentScheduler(): AgentSchedulerStore {
  const dir = path.join(app.getPath('userData'), 'agent-scheduler');
  const store = new AgentSchedulerStore(path.join(dir, 'tasks.json'));
  store.load();
  // Instant the main process came up. The 30s tick only auto-fires tasks that
  // come due AFTER this point — anything already overdue when the app started
  // was missed while the app was closed (or the machine off) and must go
  // through the catch-up banner + manual run instead of auto-running on open
  // (PLAN §6.3: no auto batch-run of unattended write tasks). Tasks that come
  // due after startup — including while the machine later sleeps — still
  // auto-fire on wake, since the process stayed alive the whole time.
  const startupTime = Date.now();

  ipcMain.handle('scheduledTask:list', async () => store.list());
  ipcMain.handle('scheduledTask:create', async (_event, input) =>
    store.create(input),
  );
  ipcMain.handle('scheduledTask:update', async (_event, id, patch) =>
    store.update(id, patch),
  );
  ipcMain.handle('scheduledTask:delete', async (_event, id) =>
    store.remove(id),
  );
  ipcMain.handle('scheduledTask:getPath', async () => ({
    file: store.getPath(),
    dir,
  }));
  ipcMain.handle('scheduledTask:getRole', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return 'unknown';
    return (win as { isMainAgentWindow?: boolean }).isMainAgentWindow
      ? 'main'
      : 'child';
  });
  ipcMain.handle('scheduledTask:reportResult', async (_event, id, result) =>
    store.reportResult(id, result),
  );
  // Manual "run now": re-seed the due broadcast for this task. `force: true`
  // lets an explicit run-now execute even a disabled task — the user asked for
  // it directly, which overrides the pause.
  ipcMain.handle('scheduledTask:runNow', async (_event, id) => {
    const task = store.list().find((t) => t.id === id) || null;
    if (task) broadcastDue(task.id, true);
    return task;
  });

  setInterval(() => {
    const now = Date.now();
    for (const task of store.list()) {
      if (isDue(task, now) && task.nextRunAt > startupTime) {
        broadcastDue(task.id, false);
      }
    }
  }, TICK_MS);

  return store;
}

/**
 * The single window that may execute scheduled tasks = the app's main window.
 * MD-document child windows (createNewWindowInstance) are marked false and
 * never receive the due broadcast, so a task can never run twice. When no
 * main window is alive (explicit quit path), nothing is broadcast — missed
 * tasks are caught up by findOverdue on the next main-window mount.
 */
function pickExecutorWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find(
    (win) =>
      !win.isDestroyed() &&
      (win as { isMainAgentWindow?: boolean }).isMainAgentWindow,
  );
}

function broadcastDue(taskId: string, force: boolean): void {
  const win = pickExecutorWindow();
  if (win) {
    win.webContents.send('scheduledTaskDue', { taskId, force });
  }
}

// Re-exported so the type stays handy for the renderer tool layer.
export type { ScheduledTaskUpdateInput };
