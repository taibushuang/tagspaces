/**
 * TagSpaces - universal file and folder organizer
 * Copyright (C) 2024-present TagSpaces GmbH
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
 */
import { describe, expect, test } from '@playwright/test';
import { requestExecConfirmationDialog } from '-/components/chat/agentConfirm';

function fakeOpen() {
  const calls = [];
  function openConfirmDialog(...args) {
    const [
      title,
      description,
      callback,
      cancelTID,
      confirmTID,
      contentTID,
      list,
      prompt,
      help,
      confirmText,
      cancelText,
      onDismiss,
      checkLabel,
      checkDefaultChecked,
    ] = args;
    calls.push({
      title,
      description,
      callback,
      cancelTID,
      confirmTID,
      contentTID,
      list,
      prompt,
      help,
      confirmText,
      cancelText,
      onDismiss,
      checkLabel,
      checkDefaultChecked,
    });
  }
  return { openConfirmDialog, calls };
}

const fakeT = (key, options) =>
  options && options.prefix ? `${key}:${options.prefix}` : key;

describe('requestExecConfirmationDialog (single dialog + remember checkbox)', () => {
  test('offers a remember checkbox for simple commands', async () => {
    const { openConfirmDialog, calls } = fakeOpen();
    const promise = requestExecConfirmationDialog(
      openConfirmDialog,
      {
        command: 'echo hi',
        cwd: '/tmp',
        prefix: 'echo',
        rememberKey: 'echo',
        canRemember: true,
      },
      fakeT,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].title).toBe('core:aiAgentExecTitle');
    expect(calls[0].description).toContain('echo hi');
    expect(calls[0].description).toContain('core:aiAgentExecCwd');
    expect(calls[0].checkLabel).toBe('core:aiAgentExecRememberPrefix:echo');
    expect(calls[0].checkDefaultChecked).toBe(false);
    expect(calls[0].confirmText).toBe('core:aiAgentExecAllow');
    expect(calls[0].cancelText).toBe('core:aiAgentExecDeny');
    calls[0].callback(true, true);
    await expect(promise).resolves.toEqual({ approved: true, remember: true });
  });

  test('unchecked = run once, no grant', async () => {
    const { openConfirmDialog, calls } = fakeOpen();
    const promise = requestExecConfirmationDialog(
      openConfirmDialog,
      {
        command: 'echo hi',
        prefix: 'echo',
        rememberKey: 'echo',
        canRemember: true,
      },
      fakeT,
    );
    calls[0].callback(true, false);
    await expect(promise).resolves.toEqual({
      approved: true,
      remember: false,
    });
  });

  test('deny and dismissal resolve without a grant', async () => {
    const deny = fakeOpen();
    const denyPromise = requestExecConfirmationDialog(
      deny.openConfirmDialog,
      { command: 'echo hi', prefix: 'echo', canRemember: true },
      fakeT,
    );
    deny.calls[0].callback(false, true);
    await expect(denyPromise).resolves.toEqual({
      approved: false,
      remember: false,
    });

    const dismiss = fakeOpen();
    const dismissPromise = requestExecConfirmationDialog(
      dismiss.openConfirmDialog,
      { command: 'echo hi', prefix: 'echo', canRemember: true },
      fakeT,
    );
    dismiss.calls[0].onDismiss();
    await expect(dismissPromise).resolves.toEqual({
      approved: false,
      remember: false,
    });
  });

  test('compound commands remember the exact line, not the prefix', async () => {
    const { openConfirmDialog, calls } = fakeOpen();
    requestExecConfirmationDialog(
      openConfirmDialog,
      {
        command: 'echo one && echo two',
        prefix: 'echo',
        rememberKey: 'echo one && echo two',
        canRemember: true,
      },
      fakeT,
    );
    expect(calls[0].checkLabel).toBe('core:aiAgentExecRememberLine');
  });

  test('elevated commands never offer a checkbox and never remember', async () => {
    const { openConfirmDialog, calls } = fakeOpen();
    const promise = requestExecConfirmationDialog(
      openConfirmDialog,
      {
        command: 'sudo rm x',
        prefix: 'sudo',
        rememberKey: '',
        canRemember: false,
      },
      fakeT,
    );
    expect(calls[0].checkLabel).toBeUndefined();
    expect(calls[0].description).toContain('core:aiAgentExecElevatedNote');
    calls[0].callback(true, true);
    await expect(promise).resolves.toEqual({
      approved: true,
      remember: false,
    });
  });
});
