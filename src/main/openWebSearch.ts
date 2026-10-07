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
 * MCP client for the local open-websearch daemon (ported from novelist-app's
 * electron/webSearch.cjs). The daemon exposes a stdio-less HTTP MCP endpoint
 * (POST /mcp, SSE responses) whose `search` / `fetchWebContent` tools power the
 * agent's `web_search` / `fetch_web` tools.
 *
 * Protocol: initialize (grab mcp-session-id from the response header) →
 * notifications/initialized → tools/call. The daemon is started on demand by
 * the start-daemon script (idempotent) when the endpoint is unreachable.
 *
 * This lives in the main process so it can spawn the daemon and talk to the
 * local service without renderer CORS / mixed-content constraints.
 */
import http from 'http';
import { spawn } from 'child_process';

const MCP_URL = process.env.OPEN_WEBSEARCH_URL || 'http://127.0.0.1:3000/mcp';
const START_SCRIPT =
  process.env.OPEN_WEBSEARCH_SCRIPT ||
  '/Users/sss/Claude/openWebSearch/scripts/start-daemon.sh';
const START_CWD = '/Users/sss/Claude/openWebSearch';
const INIT_TIMEOUT = 10000;
const SEARCH_TIMEOUT = 40000;
/** request mode (plain HTTP) timeout — most pages take 1-5s */
const FETCH_TIMEOUT = 15000;
/** browser fallback (playwright) timeout — slow, must not wait forever */
const FETCH_AUTO_TIMEOUT = 25000;
/** anti-bot / empty-shell page fingerprints: hitting these means request mode missed the body */
const WEAK_CONTENT =
  /安全验证|访问验证|请完成.{0,8}验证|验证通过|captcha|just a moment|enable javascript|开启javascript|需要.{0,6}javascript/i;
const WEAK_MIN_CHARS = 400;

// Aligned with the server's ALLOWED_SEARCH_ENGINES. Engines outside this table
// (e.g. zhihu — the service does not implement it) are rejected by the schema
// and 400 the whole request, so they must be filtered out here.
const KNOWN_ENGINES = [
  'bing',
  'baidu',
  'linuxdo',
  'juejin',
  'startpage',
  'sogou',
  'hackernews',
  'exa',
  'brave',
];
const DEFAULT_ENGINES = ['bing', 'baidu', 'juejin'];
const DEFAULT_LIMIT = 8;
const FETCH_CHAR_LIMIT = 6000;
const FETCH_CHAR_MIN = 1000;
const FETCH_CHAR_MAX = 200000;

let sessionId: string | null = null;
let starting: Promise<void> | null = null;

type HttpHeaders = http.IncomingHttpHeaders;

function postRpc(
  payload: Record<string, unknown>,
  sid: string | null,
  timeout: number,
): Promise<{ status: number; headers: HttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    let url: URL;
    try {
      url = new URL(MCP_URL);
    } catch (e) {
      reject(new Error(`OPEN_WEBSEARCH_URL 不是合法地址: ${MCP_URL}`));
      return;
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Content-Length': String(data.length),
    };
    if (sid) headers['mcp-session-id'] = sid;
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            text: Buffer.concat(chunks as unknown as Uint8Array[]).toString(
              'utf8',
            ),
          }),
        );
      },
    );
    req.setTimeout(timeout, () =>
      req.destroy(new Error(`MCP 请求超时 ${timeout}ms`)),
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/** SSE body → parsed JSON messages (degrades to a single message when not SSE) */
export function parseSse(text: string): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      out.push(JSON.parse(payload));
    } catch {
      // half-line data ignored
    }
  }
  if (!out.length && String(text || '').trim()) {
    try {
      out.push(JSON.parse(text));
    } catch {
      // non-JSON not parsed
    }
  }
  return out;
}

function headerSid(headers: HttpHeaders): string | null {
  const raw =
    headers && (headers['mcp-session-id'] || headers['Mcp-Session-Id']);
  return Array.isArray(raw) ? raw[0] : (raw as string) || null;
}

async function initSession(): Promise<string> {
  const res = await postRpc(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'tagspaces', version: '1.0' },
      },
    },
    null,
    INIT_TIMEOUT,
  );
  const sid = headerSid(res.headers);
  if (!sid)
    throw new Error(`MCP 建会话失败（HTTP ${res.status}，无 mcp-session-id）`);
  await postRpc(
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    sid,
    INIT_TIMEOUT,
  );
  sessionId = sid;
  return sid;
}

/** Pull the daemon up if it is not running (start-daemon.sh is idempotent). */
async function ensureDaemon(): Promise<void> {
  if (starting) return starting;
  starting = (async () => {
    try {
      spawn('bash', [START_SCRIPT], {
        detached: true,
        stdio: 'ignore',
        cwd: START_CWD,
      }).unref();
    } catch (e) {
      throw new Error(
        `启动 open-websearch 失败: ${(e as Error)?.message || e}`,
      );
    }
    // wait up to 20s
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        sessionId = null;
        await initSession();
        return;
      } catch {
        // not up yet, keep waiting
      }
    }
    throw new Error('open-websearch 启动超时（20s）');
  })().finally(() => {
    starting = null;
  });
  return starting;
}

function isConnError(e: unknown): boolean {
  const code = ((e as any)?.code as string) || '';
  const msg = ((e as any)?.message as string) || '';
  return /ECONNREFUSED|ECONNRESET|EPIPE|ENOTFOUND|EAI_AGAIN|socket hang up/.test(
    `${code} ${msg}`,
  );
}

async function callToolOnce(
  name: string,
  args: Record<string, unknown>,
  timeout: number,
): Promise<string> {
  let sid = sessionId || (await initSession());
  let res;
  try {
    res = await postRpc(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name, arguments: args },
      },
      sid,
      timeout,
    );
  } catch (e) {
    sessionId = null;
    throw e;
  }
  // session expired: swap to a fresh one and retry once
  if (res.status === 404 || (res.status >= 400 && /session/i.test(res.text))) {
    sessionId = null;
    sid = await initSession();
    res = await postRpc(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name, arguments: args },
      },
      sid,
      timeout,
    );
  }
  if (res.status >= 500) throw new Error(`MCP 服务端错误 HTTP ${res.status}`);
  const messages = parseSse(res.text);
  const msg = messages.find((m) => m && (m.result || m.error));
  if (!msg) throw new Error(`MCP 无有效响应（HTTP ${res.status}）`);
  if (msg.error)
    throw new Error(
      `MCP 错误: ${msg.error.message || JSON.stringify(msg.error)}`,
    );
  const r = msg.result || {};
  const text = (r.content || [])
    .filter((c: any) => c && c.type === 'text')
    .map((c: any) => c.text)
    .join('\n');
  if (r.isError) throw new Error(text);
  return text;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  timeout: number,
): Promise<string> {
  try {
    return await callToolOnce(name, args, timeout);
  } catch (e) {
    if (isConnError(e)) {
      await ensureDaemon();
      return callToolOnce(name, args, timeout);
    }
    throw e;
  }
}

export function pickEngines(requested: unknown): string[] {
  const list =
    Array.isArray(requested) && requested.length ? requested : DEFAULT_ENGINES;
  const ok = list
    .map((e) =>
      String(e || '')
        .trim()
        .toLowerCase(),
    )
    .filter((e) => KNOWN_ENGINES.includes(e));
  return ok.length ? ok : DEFAULT_ENGINES;
}

export function clamp(
  n: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.round(v)));
}

export function safeJson(text: string): Record<string, any> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function truncate(text: string, limit: number): string {
  const s = String(text || '');
  return s.length > limit
    ? `${s.slice(0, limit)}\n…[截断，原文 ${s.length} 字]`
    : s;
}

/** web_search: search the web, return structured results */
export async function searchWeb(
  args: Record<string, any>,
): Promise<Record<string, any>> {
  const query = args && typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) throw new Error('缺少 query');
  const limit = clamp(args.limit, 1, 50, DEFAULT_LIMIT);
  const engines = pickEngines(args.engines);
  const text = await callTool(
    'search',
    { query, limit, engines, searchMode: 'auto' },
    SEARCH_TIMEOUT,
  );
  const parsed = safeJson(text);
  const list = parsed && Array.isArray(parsed.results) ? parsed.results : [];
  if (!list.length) {
    return {
      query,
      engines,
      count: 0,
      results: [],
      note: parsed ? '' : truncate(text, 1500),
    };
  }
  return {
    query,
    engines: (parsed && parsed.engines) || engines,
    count: list.length,
    results: list.slice(0, limit).map((r) => ({
      title: (r && r.title) || '',
      url: (r && r.url) || '',
      snippet: (r && (r.description || r.snippet)) || '',
      source: (r && (r.source || r.engine)) || '',
    })),
  };
}

function looksWeak(parsed: Record<string, any> | null): boolean {
  const content = String((parsed && parsed.content) || '');
  if (content.trim().length < WEAK_MIN_CHARS) return true;
  return WEAK_CONTENT.test(content.slice(0, 600));
}

function finishFetch(
  url: string,
  parsed: Record<string, any> | null,
  fallbackText: string,
  maxChars: number,
): Record<string, any> {
  if (parsed && typeof parsed.content === 'string' && parsed.content.trim()) {
    return {
      url,
      finalUrl: parsed.finalUrl || url,
      title: parsed.title || '',
      content: truncate(parsed.content, maxChars),
    };
  }
  return {
    url,
    title: (parsed && parsed.title) || '',
    content: truncate(fallbackText, maxChars),
  };
}

/**
 * fetch_web: fetch a page's body text.
 * request mode first (plain HTTP, 1-5s); only fall back to the browser
 * (slow) when it came back empty or hit an anti-bot page.
 */
async function fetchWebCore(
  args: Record<string, any>,
): Promise<Record<string, any>> {
  const url = args && typeof args.url === 'string' ? args.url.trim() : '';
  if (!/^https?:\/\//i.test(url))
    throw new Error('url 必须是 http(s) 完整地址');
  const maxChars = clamp(
    args.max_chars,
    FETCH_CHAR_MIN,
    FETCH_CHAR_MAX,
    FETCH_CHAR_LIMIT,
  );

  let first: Record<string, any> | null = null;
  let firstText = '';
  let firstErr: Error | null = null;
  try {
    firstText = await callTool(
      'fetchWebContent',
      { url, maxChars, renderMode: 'request' },
      FETCH_TIMEOUT,
    );
    first = safeJson(firstText);
  } catch (e) {
    firstErr = e as Error;
  }
  // request mode got the body on the first pass: do not touch the browser
  if (first && !looksWeak(first))
    return finishFetch(url, first, firstText, maxChars);

  let secondErr: Error | null = null;
  try {
    const secondText = await callTool(
      'fetchWebContent',
      { url, maxChars, renderMode: 'browser' },
      FETCH_AUTO_TIMEOUT,
    );
    const second = safeJson(secondText);
    if (!second) {
      if (first) return finishFetch(url, first, firstText, maxChars);
      throw new Error(truncate(secondText, 300));
    }
    const a = String((first && first.content) || '').length;
    const b = String(second.content || '').length;
    if (b > a || !looksWeak(second))
      return finishFetch(url, second, secondText, maxChars);
    return finishFetch(
      url,
      first || second,
      first ? firstText : secondText,
      maxChars,
    );
  } catch (e) {
    secondErr = e as Error;
  }

  // browser fallback also failed: hand over the request-mode result if we have
  // one, otherwise report both errors combined
  if (first) {
    const out = finishFetch(url, first, firstText, maxChars);
    out.note = `正文可能不完整（浏览器渲染兜底失败：${(secondErr && secondErr.message) || secondErr}）`;
    return out;
  }
  const parts: string[] = [];
  if (firstErr)
    parts.push(`HTTP: ${(firstErr && firstErr.message) || firstErr}`);
  if (secondErr)
    parts.push(`浏览器: ${(secondErr && secondErr.message) || secondErr}`);
  throw new Error(`抓取失败 —— ${parts.join('；') || '未知错误'}`);
}

/** An anti-bot intercept page is useless — error out so the model picks another URL. */
function assertUsable(out: Record<string, any>): Record<string, any> {
  const c = String((out && out.content) || '').trim();
  if (c.length < WEAK_MIN_CHARS && WEAK_CONTENT.test(c)) {
    throw new Error(
      `抓取失败：这是反爬拦截页（${c.length} 字），换个 URL 或换一个来源。`,
    );
  }
  return out;
}

export async function fetchWeb(
  args: Record<string, any>,
): Promise<Record<string, any>> {
  const out = await fetchWebCore(args);
  return assertUsable(out);
}

/** Exported for unit tests. */
export const _internals = {
  parseSse,
  pickEngines,
  clamp,
  safeJson,
  truncate,
  KNOWN_ENGINES,
  DEFAULT_ENGINES,
};
