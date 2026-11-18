/**
 * Shared agent confirmation dialogs (exec authorization + delete consent).
 *
 * Single source of truth for the run_command authorization flow and the
 * delete confirmation. Both ChatProvider (file-sidebar chat) and
 * AgentSessionsContextProvider (AgentPanel) use this helper.
 *
 * Exec authorization is a SINGLE dialog: allow/deny plus an explicit
 * "remember, don't ask again" checkbox (checkbox state is passed to the
 * confirm callback). The earlier two-step dialog ("allow → remember?")
 * buried the permanent grant behind a second English-only prompt, which read
 * as "you can only run once" and was easy to dismiss. Elevated commands still
 * never get a checkbox.
 *
 * Dismissal (Esc / X / backdrop) never fires ConfirmDialog's button callback,
 * so the confirm dialogs pass an explicit `onDismiss` that resolves the promise
 * (exec: treat as deny; delete: treat as deny).
 */

import type { NotificationContextData } from '-/hooks/notificationContext';

type OpenConfirm = NotificationContextData['openConfirmDialog'];
type Translate = (key: string, options?: Record<string, unknown>) => string;

export type ExecConfirmPayload = {
  command: string;
  cwd?: string;
  prefix: string;
  /** Key persisted on approval (prefix for simple lines, full line for compound ones). */
  rememberKey?: string;
  canRemember: boolean;
};

export type DeleteConfirmPayload = {
  folderPath: string;
  items: Array<{ name: string; size?: number }>;
  reason?: string;
};

/**
 * One-step authorization for run_command. The optional checkbox remembers the
 * grant (prefix for simple lines, exact line for compound ones) only when the
 * user explicitly checks it; leaving it unchecked runs the command once.
 */
export function requestExecConfirmationDialog(
  openConfirmDialog: OpenConfirm,
  { command, cwd, prefix, rememberKey, canRemember }: ExecConfirmPayload,
  t: Translate = (key) => key,
): Promise<{ approved: boolean; remember: boolean }> {
  const rememberIsPrefix =
    !rememberKey ||
    rememberKey === prefix ||
    rememberKey === prefix.toLowerCase();
  const checkLabel = canRemember
    ? rememberIsPrefix
      ? t('core:aiAgentExecRememberPrefix', { prefix })
      : t('core:aiAgentExecRememberLine')
    : undefined;

  return new Promise<{ approved: boolean; remember: boolean }>((resolve) => {
    openConfirmDialog(
      t('core:aiAgentExecTitle'),
      [
        t('core:aiAgentExecDescription'),
        command,
        ...(cwd ? [t('core:aiAgentExecCwd', { cwd })] : []),
        t('core:aiAgentExecPrefix', { prefix }),
        ...(canRemember ? [] : [t('core:aiAgentExecElevatedNote')]),
      ].join('\n'),
      (result, checked) => {
        resolve({
          approved: !!result,
          remember: !!result && canRemember && !!checked,
        });
      },
      'agentExecCancelButton',
      'agentExecConfirmButton',
      'agentExecDialogContentTID',
      undefined,
      undefined,
      undefined,
      t('core:aiAgentExecAllow'),
      t('core:aiAgentExecDeny'),
      // Dismissing the allow dialog = deny (never leaves the promise pending).
      () => resolve({ approved: false, remember: false }),
      checkLabel,
      false,
    );
  });
}

/** One-step consent for trash-only deletion (per containing folder). */
export function requestDeleteConfirmationDialog(
  openConfirmDialog: OpenConfirm,
  { folderPath, items, reason }: DeleteConfirmPayload,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    openConfirmDialog(
      'Allow the AI Agent to delete?',
      [
        `Move ${items.length} item(s) from this folder to the system trash (recoverable):`,
        folderPath,
        ...(reason ? [`Reason: ${reason}`] : []),
      ].join('\n'),
      (result) => resolve(!!result),
      'agentDeleteCancelButton',
      'agentDeleteConfirmButton',
      'agentDeleteDialogContentTID',
      items.map((i) =>
        typeof i.size === 'number' && i.size >= 0
          ? `${i.name} (${i.size} bytes)`
          : i.name,
      ),
      undefined,
      undefined,
      'Delete (to trash)',
      'Cancel',
      // Dismissing = deny (never leaves the promise pending).
      () => resolve(false),
    );
  });
}
