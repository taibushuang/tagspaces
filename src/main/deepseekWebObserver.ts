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

import { ipcMain, session, webContents } from 'electron';

export const DEEPSEEK_PARTITION = 'persist:deepseekweb';
const CHAT_ENDPOINT_PATTERN = 'https://chat.deepseek.com/api/*';

type RequestRef = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  capturedAt: number;
};

type PowSample = {
  algorithm: string;
  challenge: string;
  salt: string;
  answer: number | null;
  signature: string;
  targetPath: string;
  capturedAt: number;
};

let lastRequestRef: RequestRef | null = null;
const powHistory: PowSample[] = [];

function decodePowHeader(headerValue: string): PowSample | null {
  try {
    const decoded = JSON.parse(
      Buffer.from(headerValue, 'base64').toString('utf8'),
    );
    return {
      algorithm: decoded.algorithm || '',
      challenge: decoded.challenge || '',
      salt: decoded.salt || '',
      answer: typeof decoded.answer === 'number' ? decoded.answer : null,
      signature: decoded.signature || '',
      targetPath: decoded.target_path || '',
      capturedAt: Date.now(),
    };
  } catch (e) {
    return null;
  }
}

export function initDeepseekWebObserver(): void {
  const ses = session.fromPartition(DEEPSEEK_PARTITION);
  if (!ses) {
    return;
  }
  try {
    // Body capture: only available at the before-request stage.
    ses.webRequest.onBeforeRequest(
      { urls: [CHAT_ENDPOINT_PATTERN] },
      (details, callback) => {
        try {
          const requestBody = (details as any).requestBody;
          let body: string | null = null;
          if (requestBody?.raw) {
            const raw = requestBody.raw.find((r: any) => r.bytes);
            if (raw?.bytes) {
              body = Buffer.from(raw.bytes).toString('utf8');
            }
          } else if (requestBody?.formData) {
            body = JSON.stringify(requestBody.formData);
          }
          if (body) {
            lastRequestRef = {
              ...(lastRequestRef || {
                url: details.url,
                method: details.method,
                headers: {},
                capturedAt: Date.now(),
              }),
              url: details.url,
              method: details.method,
              body,
            };
          }
        } catch (e) {
          /* observation must never break the web app */
        }
        callback({});
      },
    );
    // Headers capture (includes the anti-bot / auth headers needed to replay).
    ses.webRequest.onBeforeSendHeaders(
      { urls: [CHAT_ENDPOINT_PATTERN] },
      (details, callback) => {
        try {
          const pow = (details.requestHeaders as Record<string, string>)[
            'x-ds-pow-response'
          ];
          if (pow) {
            const sample = decodePowHeader(pow);
            if (sample) {
              powHistory.push(sample);
              if (powHistory.length > 8) powHistory.shift();
            }
          }
          lastRequestRef = {
            url: details.url,
            method: details.method,
            headers: { ...details.requestHeaders } as Record<string, string>,
            body: lastRequestRef?.body ?? null,
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
  ipcMain.handle('get-deepseek-pow-history', () => powHistory);

  /**
   * Drive API calls INSIDE the embedded webview. DeepSeek's WAF rejects
   * cross-origin requests (Origin header cannot be overridden from the
   * app page), so the origin-sensitive fetches run from the webview's own
   * origin with its own auth token. The CPU-heavy PoW solve stays in the
   * renderer (buildDeepseekPowResponse).
   */
  ipcMain.handle(
    'deepseek-web-drive',
    async (_e, action: string, args: any) => {
      const wc = webContents
        .getAllWebContents()
        .find((c) => c.getURL().startsWith('https://chat.deepseek.com/'));
      if (!wc) {
        return {
          error: 'deepseek webview not open — open the DeepSeek tab first',
        };
      }
      try {
        if (action === 'create-session') {
          const res = await wc.executeJavaScript(
            `(async()=>{
              let token=null;
              try{const u=JSON.parse(localStorage.getItem('userToken')||'{}');token=u&&u.value?u.value:null;}catch(e){}
              const h={'Content-Type':'application/json'};
              if(token)h.authorization='Bearer '+token;
              const r=await fetch('/api/v0/chat_session/create',{method:'POST',headers:h,body:'{}'});
              const j=await r.json();
              return JSON.stringify({status:r.status,id:j&&j.data&&j.data.biz_data&&j.data.biz_data.id||null});
            })()`,
          );
          return JSON.parse(res);
        }
        if (action === 'challenge') {
          const res = await wc.executeJavaScript(
            `(async()=>{
              const keys=Object.keys(localStorage);
              let token=null;
              try{const u=JSON.parse(localStorage.getItem('userToken')||'{}');token=u&&u.value?u.value:null;}catch(e){}
              const h={'Content-Type':'application/json'};
              if(token)h.authorization='Bearer '+token;
              const r=await fetch('/api/v0/chat/create_pow_challenge',{method:'POST',headers:h,body:JSON.stringify({target_path:'/api/v0/chat/completion'})});
              const j=await r.json();
              return JSON.stringify({status:r.status,challenge:j&&j.data&&j.data.biz_data&&j.data.biz_data.challenge||null});
            })()`,
          );
          return JSON.parse(res);
        }
        if (action === 'completion') {
          const body = args?.body;
          const powHeader = args?.powHeader;
          const res = await wc.executeJavaScript(
            `(async()=>{
              let token=null;
              try{const u=JSON.parse(localStorage.getItem('userToken')||'{}');token=u&&u.value?u.value:null;}catch(e){}
              const h={'Content-Type':'application/json','Accept':'text/event-stream','x-ds-pow-response':${JSON.stringify(powHeader)}};
              if(token)h.authorization='Bearer '+token;
              const r=await fetch('/api/v0/chat/completion',{method:'POST',headers:h,body:${JSON.stringify(JSON.stringify(body))}});
              if(!r.ok)return JSON.stringify({error:'HTTP '+r.status,text:(await r.text()).slice(0,200)});
              const reader=r.body.getReader();
              const dec=new TextDecoder();
              let text='';let buf='';
              for(;;){
                const {done,value}=await reader.read();
                if(done)break;
                buf+=dec.decode(value,{stream:true});
                const lines=buf.split('\\n');
                buf=lines.pop()||'';
                for(const ln of lines){
                  if(ln.trim().startsWith('data:')){
                    text+=ln+'\\n';
                    // forward each SSE chunk to the host via console-message
                    console.log('[ds-stream]'+ln.trim());
                  }
                }
              }
              return JSON.stringify({ok:true,text});
            })()`,
          );
          return JSON.parse(res);
        }
        return { error: 'unknown action: ' + action };
      } catch (e: any) {
        return { error: e?.message || String(e) };
      }
    },
  );

  ipcMain.handle('get-deepseek-session', async () => {
    // Find the embedded webview (a WebContents whose URL is on chat.deepseek.com)
    // and return its cookies + current chat session id (from the URL path).
    const wc = webContents
      .getAllWebContents()
      .find((c) => c.getURL().startsWith('https://chat.deepseek.com/'));
    if (!wc) {
      return { cookies: [], sessionId: null };
    }
    let cookies: Array<{ name: string; value: string }> = [];
    try {
      const got = await wc.session.cookies.get({
        url: 'https://chat.deepseek.com',
      });
      cookies = got.map((c) => ({ name: c.name, value: c.value }));
    } catch (e) {
      /* ignore */
    }
    const url = wc.getURL();
    const m = url.match(/\/a\/chat\/s\/([0-9a-f-]+)/);
    return { cookies, sessionId: m ? m[1] : null };
  });
}

/** Convenience for tests/CLI: the latest observed request, if any. */
export function getDeepseekWebRequestRef(): RequestRef | null {
  return lastRequestRef;
}
