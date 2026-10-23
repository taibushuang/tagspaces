/**
 * Type-safe wrapper around window.electronIO.ipcRenderer.invoke for
 * channels that have a contract in src/main/ipcContracts.ts. The raw
 * invoke() accepts unknown[] args with no compile-time link between the
 * renderer call site and the main-process handler — this helper restores
 * that link: wrong arg shape or channel key fails tsc on the caller side.
 *
 * For new IPC channels: add the contract to IpcContracts, call this helper
 * from the renderer, and annotate the main handler's params with the same
 * contract types (see skillImportIpc.ts for the pattern).
 */

import type { IpcContracts } from '../../main/ipcContracts';

export function typedInvoke<K extends keyof IpcContracts>(
  channel: K,
  ...args: IpcContracts[K]['args']
): Promise<IpcContracts[K]['result']> {
  return window.electronIO.ipcRenderer.invoke(channel, ...args) as Promise<
    IpcContracts[K]['result']
  >;
}
