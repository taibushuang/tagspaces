/**
 * Shared agent confirmation dialogs (exec authorization + delete consent).
 *
 * Single source of truth for the two-step "allow command → remember prefix?"
 * flow and the delete confirmation. Both ChatProvider (file-sidebar chat) and
 * AgentSessionsContextProvider (AgentPanel) previously kept their own copies —
 * the drift already produced one bug (the second dialog never appeared) and
 * this helper fixes it once.
 *
 * Two traps handled here:
 * - React 18 auto-batching: opening the SECOND dialog synchronously inside
 *   the first dialog's callback gets overwritten by the first dialog's
 *   onClose (same event handler → one batch → final open=false, promise
 *   never resolves). Deferring the second open by one tick (setTimeout 0)
 *   lets the first batch commit first.
 * - Dismissal (Esc / X / backdrop) never fires ConfirmDialog's button
 *   callback, so a promise keyed on it would hang forever. The confirm
 *   dialogs here pass an explicit `onDismiss` that resolves the promise
 *   (exec: treat as deny; remember-dialog: treat as "Ask every time").
 */

import type { NotificationContextData } from '-/hooks/NotificationContextProvider';

type OpenConfirm = NotificationContextData['openConfirmDialog'];

export type ExecConfirmPayload = {
  command: string;
  cwd?: string;
  prefix: string;
  canRemember: boolean;
};

export type DeleteConfirmPayload = {
  folderPath: string;
  items: Array<{ name: string; size?: number }>;
  reason?: string;
};

/**
 * Two-step authorization for run_command:
 * 1. "Allow the AI Agent to run this command?" — confirm = Run once, cancel = Deny;
 * 2. "Remember for future runs?" — SAFE DEFAULT is "Ask every time" (the
 *    right/confirm button); "Remember prefix" is the explicit left choice.
 */
export function requestExecConfirmationDialog(
  openConfirmDialog: OpenConfirm,
  { command, cwd, prefix, canRemember }: ExecConfirmPayload,
): Promise<{ approved: boolean; remember: boolean }> {
  return new Promise<{ approved: boolean; remember: boolean }>((resolve) => {
    openConfirmDialog(
      'Allow the AI Agent to run this command?',
      [
        'The agent requests to execute the following shell command:',
        command,
        ...(cwd ? [`Working directory: ${cwd}`] : []),
        `Prefix: "${prefix}"`,
        ...(canRemember
          ? []
          : ['(elevated-privilege commands are never remembered)']),
      ].join('\n'),
      (result) => {
        if (!result) {
          resolve({ approved: false, remember: false });
          return;
        }
        // Defer by one tick: opening the second dialog synchronously here is
        // swallowed by React 18 batching (the first dialog's onClose runs in
        // the same handler and overwrites the open state), leaving the
        // promise pending forever. A fresh task lets the batch commit first.
        setTimeout(() => {
          openConfirmDialog(
            'Remember for future runs?',
            canRemember
              ? `Remember = "${prefix}"-style authorization; future matching commands run WITHOUT asking. Compound lines are always re-confirmed when their content changes. Grants persist in userData/exec/grants.json (delete the file to revoke all).`
              : 'This command cannot be remembered.',
            (rememberResult) => {
              resolve({
                approved: true,
                remember: canRemember && !rememberResult,
              });
            },
            'agentExecRememberButton',
            'agentExecAskButton',
            'agentExecRememberContentTID',
            undefined,
            undefined,
            undefined,
            'Ask every time',
            'Remember prefix',
            // Dismissing the remember dialog is the conservative choice:
            // approve the current run but do NOT remember.
            () => resolve({ approved: true, remember: false }),
          );
        }, 0);
      },
      'agentExecCancelButton',
      'agentExecConfirmButton',
      'agentExecDialogContentTID',
      undefined,
      undefined,
      undefined,
      'Run once',
      'Deny',
      // Dismissing the allow dialog = deny (never leaves the promise pending).
      () => resolve({ approved: false, remember: false }),
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
