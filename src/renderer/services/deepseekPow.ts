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
 * DeepSeek web PoW solver (DeepSeekHashV1).
 *
 * chat.deepseek.com requires a proof-of-work solution on every chat
 * completion (`x-ds-pow-response` header). The client's own solver ships as
 * two webpack worker chunks; we run those unchanged in a Blob Web Worker so
 * the produced answers always match what the web client would compute.
 * Verified against real captured challenges (answer 75308 matched).
 */

import {
  DS_POW_DEP_CHUNK,
  DS_POW_SOLVER_CHUNK,
} from '-/services/deepseekPowChunks';

function makeWorkerSource(): string {
  return [
    'self = typeof self !== "undefined" ? self : globalThis;',
    'self.navigator = self.navigator || {};',
    'self.onmessage = null;',
    // importScripts shim: the chunk runtime pulls the dependency chunk from a
    // URL — resolve it from our embedded map instead of the network.
    'self.importScripts = function (url) {',
    '  var m = url.match(/\\/(\\d+)\\.[0-9a-f]+\\.js/);',
    '  var id = m ? m[1] : "";',
    '  if (self.__chunkMap && self.__chunkMap[id]) { eval(self.__chunkMap[id]); }',
    '};',
    'self.__chunkMap = { 8138: ' + JSON.stringify(DS_POW_DEP_CHUNK) + ' };',
    // The solver chunk (76608) registers itself via the rspack loader.
    // It runs asynchronously; we wait for its onmessage to be defined below.
    '(0, eval)(' + JSON.stringify(DS_POW_SOLVER_CHUNK) + ');',
    // Wait until the solver chunk finished wiring `onmessage`, then bridge.
    'var boot = setInterval(function () {',
    '  if (typeof self.onmessage === "function") {',
    '    clearInterval(boot);',
    '    var realOnMessage = self.onmessage;',
    '    self.onmessage = function (ev) {',
    '      try { realOnMessage(ev); } catch (e) { postMessage({ type: "pow-error", error: String(e) }); }',
    '    };',
    '    postMessage({ type: "solver-ready" });',
    '  }',
    '}, 50);',
  ].join('\n');
}

let worker: Worker | null = null;
let readyPromise: Promise<void> | null = null;
let solving: Promise<number> | null = null;

function getWorker(): Promise<Worker> {
  if (worker) return Promise.resolve(worker);
  const blob = new Blob([makeWorkerSource()], {
    type: 'application/javascript',
  });
  const url = URL.createObjectURL(blob);
  worker = new Worker(url);
  return Promise.resolve(worker);
}

/**
 * Solve a DeepSeekHashV1 challenge. Returns the integer answer.
 */
export function solveDeepseekPow(challenge: {
  algorithm: string;
  challenge: string;
  salt: string;
  difficulty: number;
  signature: string;
}): Promise<number> {
  if (solving) return solving;
  solving = (async () => {
    const w = await getWorker();
    return new Promise<number>((resolve, reject) => {
      const onMsg = (ev: MessageEvent) => {
        const d = ev.data;
        if (d && d.type === 'pow-answer') {
          cleanup();
          resolve(d.answer.answer);
        } else if (d && d.type === 'pow-error') {
          cleanup();
          reject(new Error(d.error || 'pow solve failed'));
        }
      };
      const cleanup = () => {
        w.removeEventListener('message', onMsg);
      };
      w.addEventListener('message', onMsg);
      w.postMessage({ type: 'pow-challenge', challenge });
    });
  })().finally(() => {
    solving = null;
  });
  return solving;
}

/** Build the x-ds-pow-response header value for a challenge. */
export async function buildDeepseekPowResponse(challenge: {
  algorithm: string;
  challenge: string;
  salt: string;
  difficulty: number;
  signature: string;
  target_path: string;
}): Promise<string> {
  const answer = await solveDeepseekPow(challenge);
  return btoa(
    JSON.stringify({
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer,
      signature: challenge.signature,
      target_path: challenge.target_path,
    }),
  );
}
