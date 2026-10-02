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
 * DeepSeek web PoW solver, running in the main (Node) process.
 *
 * chat.deepseek.com requires a proof-of-work solution (DeepSeekHashV1) on
 * every completion. The client's own solver ships as two webpack worker
 * chunks; we run them unchanged in Node (verified: reproduced the real
 * captured answer 75308) and hand the result to the renderer over IPC.
 * Node's evaluation environment matches where the solver was proven to work.
 */

import { ipcMain } from 'electron';
import { DS_POW_DEP_CHUNK, DS_POW_SOLVER_CHUNK } from './deepseekPowChunks';

let solverOnmessage: ((ev: any) => void) | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ensureBooted(): Promise<void> {
  if (solverOnmessage) return;
  const saved = {
    postMessage: (globalThis as any).postMessage,
    importScripts: (globalThis as any).importScripts,
    onmessage: (globalThis as any).onmessage,
    self: (globalThis as any).self,
  };
  let answer: any = null;
  (globalThis as any).self = globalThis;
  (globalThis as any).postMessage = (d: any) => {
    answer = d;
  };
  (globalThis as any).importScripts = (url: string) => {
    const m = url.match(/\/(\d+)\.[0-9a-f]+\.js/);
    const id = m ? m[1] : '';
    const map = (globalThis as any).__dsChunkMap;
    if (map && map[id]) {
      // eslint-disable-next-line no-eval
      (0, eval)(map[id]);
    }
  };
  (globalThis as any).__dsChunkMap = { 8138: DS_POW_DEP_CHUNK };
  (globalThis as any).onmessage = null;
  // eslint-disable-next-line no-eval
  (0, eval)(DS_POW_SOLVER_CHUNK);
  for (let i = 0; i < 120; i += 1) {
    if (typeof (globalThis as any).onmessage === 'function') {
      solverOnmessage = (globalThis as any).onmessage;
      break;
    }
    await sleep(50);
  }
  (globalThis as any).postMessage = saved.postMessage;
  (globalThis as any).importScripts = saved.importScripts;
  (globalThis as any).onmessage = saved.onmessage;
  if (saved.self === undefined) {
    delete (globalThis as any).self;
  } else {
    (globalThis as any).self = saved.self;
  }
  if (!solverOnmessage) {
    throw new Error('solver chunk never initialized');
  }
}

export function initDeepseekPowSolver(): void {
  ipcMain.handle('deepseek-pow-solve', async (_e, challenge: any) => {
    try {
      // The solver chunk builds its hash prefix from `salt + "_" + expireAt
      // + "_"` — the web client aliases expire_at -> expireAt before handing
      // the challenge to the worker. Replicate that here.
      if (challenge && !challenge.expireAt && challenge.expire_at) {
        challenge.expireAt = challenge.expire_at;
      }
      await ensureBooted();
      const realOnMessage = solverOnmessage!;
      let result: { type: string; answer?: any; error?: any } | null = null;
      const saved = (globalThis as any).postMessage;
      (globalThis as any).postMessage = (d: any) => {
        result = d;
      };
      try {
        realOnMessage({ data: { type: 'pow-challenge', challenge } });
      } finally {
        (globalThis as any).postMessage = saved;
      }
      if (!result) {
        return { error: 'no solver result' };
      }
      if (result.type === 'pow-answer') {
        return { answer: result.answer.answer };
      }
      return {
        error:
          ((result.error && (result.error.message || result.error.name)) ||
            result.error ||
            'pow solve failed') +
          ' [receivedSig=' +
          String(challenge?.signature || '').slice(0, 6) +
          ',keys=' +
          Object.keys(challenge || {}).join('|') +
          ']',
      };
    } catch (e: any) {
      return { error: e?.message || String(e) };
    }
  });
}
