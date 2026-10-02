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
 * DeepSeek web PoW + response helpers (renderer side).
 *
 * The DeepSeekHashV1 solve runs in the MAIN process (Node), where the
 * solver was verified against real captured challenges; this module just
 * calls it over IPC and formats the x-ds-pow-response header. It also owns
 * the SSE stream parser for the chat completion responses.
 */

/**
 * Build the x-ds-pow-response header value for a challenge.
 * The heavy hash is computed in the main process (deepseek-pow-solve).
 */
export async function buildDeepseekPowResponse(challenge: {
  algorithm: string;
  challenge: string;
  salt: string;
  difficulty: number;
  signature: string;
  target_path: string;
}): Promise<string> {
  const res: any = await window.electronIO.ipcRenderer.invoke(
    'deepseek-pow-solve',
    challenge,
  );
  if (!res || res.error) {
    throw new Error(res?.error || 'pow solve failed');
  }
  return btoa(
    JSON.stringify({
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer: res.answer,
      signature: challenge.signature,
      target_path: challenge.target_path,
    }),
  );
}

/**
 * Parse a DeepSeek web chat/completion SSE response into its parts.
 * The stream is `data:` JSON lines: plain text chunks arrive as {"v":"…"}
 * (also inside {"p":…,"o":"APPEND","v":"…"} patch ops); the ready event
 * carries response_message_id = the next parent_message_id; references come
 * on fragment objects.
 */
export function parseDeepseekStream(raw: string): {
  content: string;
  thinking: string;
  citations: string[];
  nextParent: number | null;
} {
  let content = '';
  let thinking = '';
  const citations: string[] = [];
  let nextParent: number | null = null;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.replace(/^data:\s*/, '');
    if (data === '[DONE]') continue;
    try {
      const json = JSON.parse(data);
      if (typeof json.v === 'string' && json.v) {
        content += json.v;
      }
      if (Number.isInteger(json.response_message_id)) {
        nextParent = json.response_message_id;
      }
      if (typeof json.reasoning_content === 'string') {
        thinking += json.reasoning_content;
      }
      const frag = json.v?.response;
      if (Array.isArray(frag?.references) && frag.references.length) {
        citations.push(...frag.references);
      }
      if (Array.isArray(json.references) && json.references.length) {
        citations.push(...json.references);
      }
    } catch (e) {
      /* keep-alive / non-JSON line */
    }
  }
  return { content, thinking, citations, nextParent };
}
