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
 *
 */

/**
 * DeepSeek web integration — traffic observer.
 *
 * chat.deepseek.com has no public API; the free web chat speaks internal
 * endpoints. Instead of hard-coding a guess at that contract, we observe a
 * real request from the user's own logged-in session (embedded webview,
 * partition "persist:deepseekweb") and remember its shape. The renderer's
 * programmatic client then replays it with the session cookies.
 *
 * webRequest is a main-process API, so this module lives here and answers
 * the renderer over IPC.
 */

import { ipcMain, session } from 'electron';

export const DEEPSEEK_PARTITION = 'persist:deepseekweb';
const CHAT_ENDPOINT_PATTERN = 'https://chat.deepseek.com/api/*';

type RequestRef = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  capturedAt: number;
};

let lastRequestRef: RequestRef | null = null;

export function initDeepseekWebObserver(): void {
  const ses = session.fromPartition(DEEPSEEK_PARTITION);
  if (!ses) {
    return;
  }
  try {
    ses.webRequest.onBeforeSendHeaders(
      { urls: [CHAT_ENDPOINT_PATTERN] },
      (details, callback) => {
        try {
          const requestBody = (details as any).requestBody;
          let body: string | null = null;
          if (requestBody?.raw) {
            const raw = requestBody.raw.find((r) => r.bytes);
            if (raw?.bytes) {
              body = Buffer.from(raw.bytes).toString('utf8');
            }
          }
          lastRequestRef = {
            url: details.url,
            method: details.method,
            headers: { ...details.requestHeaders } as Record<string, string>,
            body,
            capturedAt: Date.now(),
          };
        } catch (e) {
          /* observation must never break the web app */
        }
        callback({ requestHeaders: details.requestHeaders });
      },
    );
  } catch (e) {
    console.warn('deepseek observer init failed:', e);
  }

  ipcMain.handle('get-deepseek-web-request-ref', () => lastRequestRef);
}

/** Convenience for tests/CLI: the latest observed request, if any. */
export function getDeepseekWebRequestRef(): RequestRef | null {
  return lastRequestRef;
}
