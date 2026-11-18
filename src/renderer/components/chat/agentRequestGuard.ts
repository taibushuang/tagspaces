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

/**
 * Guard for one model request.
 *
 * `fetch` has no timeout of its own: a gateway that accepts the TCP
 * connection and then stalls (rate limiting, hung upstream, dead proxy)
 * leaves the agent loop awaiting forever, with the panel stuck on
 * "Agent is working…". The guard forwards the caller's abort signal and
 * aborts when no response data arrives for `idleMs`, so the loop always
 * terminates with a diagnosable failure.
 *
 * A generous window is deliberate: reasoning models may stream nothing until
 * they finish thinking; the timeout is a stuck-connection detector, not a
 * latency budget.
 */
export const MODEL_REQUEST_IDLE_TIMEOUT_MS = 120_000;

export type ModelCallFailureKind =
  | 'http'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'invalid';

export type ModelCallFailure = {
  kind: ModelCallFailureKind;
  message: string;
  /** HTTP status code for `kind: 'http'`. */
  status?: number;
  /** Raw response body / error stack / extra context for the debug log. */
  detail?: string;
};

export type RequestIdleGuard = {
  signal: AbortSignal;
  /** Call after each received chunk to restart the idle window. */
  reset: () => void;
  dispose: () => void;
  timedOut: () => boolean;
  callerAborted: () => boolean;
};

export function createRequestIdleGuard(
  callerSignal?: AbortSignal,
  idleMs: number = MODEL_REQUEST_IDLE_TIMEOUT_MS,
): RequestIdleGuard {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort();
    } else {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
  }

  const reset = () => {
    if (disposed) {
      return;
    }
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, idleMs);
  };

  const dispose = () => {
    disposed = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (callerSignal) {
      callerSignal.removeEventListener('abort', onCallerAbort);
    }
  };

  reset();

  return {
    signal: controller.signal,
    reset,
    dispose,
    timedOut: () => timedOut,
    callerAborted: () => !!callerSignal?.aborted,
  };
}

/**
 * Classify a thrown request error. Order matters: a user abort and the guard
 * timeout both surface as `AbortError`, so the flags decide which one it was.
 */
export function describeRequestFailure(
  error: unknown,
  guard?: RequestIdleGuard,
  idleMs: number = MODEL_REQUEST_IDLE_TIMEOUT_MS,
): ModelCallFailure {
  if (guard?.callerAborted()) {
    return { kind: 'aborted', message: 'aborted by user' };
  }
  if (guard?.timedOut()) {
    return {
      kind: 'timeout',
      message: `no data from the model for ${Math.round(idleMs / 1000)}s`,
    };
  }
  const name = (error as { name?: string })?.name;
  if (name === 'AbortError' || name === 'TimeoutError') {
    return { kind: 'aborted', message: 'aborted' };
  }
  return {
    kind: 'network',
    message: (error as { message?: string })?.message || String(error),
  };
}

/** Read a failed response body (plus Retry-After) for the debug log. */
export async function readResponseErrorBody(
  response: Response,
  limit = 2000,
): Promise<string> {
  const text = await response.text().catch(() => '');
  const retryAfter = response.headers?.get?.('retry-after');
  const parts: string[] = [];
  if (retryAfter) {
    parts.push(`retry-after: ${retryAfter}`);
  }
  if (text) {
    parts.push(text);
  }
  return parts.join('\n').slice(0, limit);
}

export function httpFailureFromResponse(
  response: Response,
  body: string,
): ModelCallFailure {
  return {
    kind: 'http',
    status: response.status,
    message: `HTTP ${response.status}${
      response.statusText ? ` ${response.statusText}` : ''
    }`,
    detail: body || undefined,
  };
}

/** Short user-facing wording for the chat bubble (full detail goes to the log). */
export function failureToUserMessage(
  failure?: ModelCallFailure,
  idleMs: number = MODEL_REQUEST_IDLE_TIMEOUT_MS,
): string {
  if (!failure) {
    return 'model request failed (HTTP error or network problem)';
  }
  const detail = failure.detail
    ? `: ${failure.detail.replace(/\s+/g, ' ').slice(0, 300)}`
    : '';
  switch (failure.kind) {
    case 'timeout':
      return `request timed out — ${Math.round(
        idleMs / 1000,
      )}s without any model data (possible rate limiting, stalled gateway or overloaded model)`;
    case 'http':
      return `${failure.message}${detail}`;
    case 'aborted':
      return 'aborted by user';
    case 'network':
      return `network error: ${failure.message} (endpoint unreachable, TLS/CORS/proxy problem?)`;
    default:
      return failure.message;
  }
}
