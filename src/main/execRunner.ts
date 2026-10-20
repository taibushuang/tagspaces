/**
 * Shell command runner for the agent's run_command tool — lives in the main
 * process (spawn access) but has no electron import, so it is unit-testable
 * in plain Node.
 *
 * Power model (personal-machine tool, deliberately capable):
 * - the full command line is passed to the platform shell (pipes, &&, …);
 * - caller picks cwd, env additions and timeout (hard-capped);
 * - stdout/stderr are captured with a per-stream cap so a runaway `yes`
 *   cannot blow up memory or the model context;
 * - on timeout the whole process TREE is killed (taskkill /T /F on Windows,
 *   process-group SIGKILL elsewhere).
 * Every run is appended to an audit log by the IPC layer.
 */

import { spawn } from 'child_process';
import fs from 'fs-extra';
import path from 'path';

export const EXEC_TIMEOUT_DEFAULT_MS = 60_000;
/** Hard cap — a tool call must never hang the agent loop for minutes. */
export const EXEC_TIMEOUT_MAX_MS = 600_000;
/** Per-stream capture cap; beyond this the stream keeps draining but is discarded. */
export const EXEC_OUTPUT_CAP = 200 * 1024;

export type ExecRunParams = {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
};

/**
 * env keys that must never be overridden — shadowing PATH (or HOME) lets a
 * remembered prefix resolve to a planted shim instead of the real binary.
 */
const FORBIDDEN_ENV_KEYS = ['path', 'home', 'userprofile'];

function validateEnv(env?: Record<string, string>): void {
  if (!env) return;
  for (const key of Object.keys(env)) {
    if (FORBIDDEN_ENV_KEYS.includes(key.toLowerCase())) {
      throw new Error(
        `env key "${key}" is not allowed — overriding it could redirect the command to a planted executable`,
      );
    }
  }
}

export type ExecRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
  cwd: string;
};

function killTree(child: import('child_process').ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
      });
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    return;
  }
  try {
    // detached children lead their own process group
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/** Run a shell command line, capturing output with caps and a hard timeout. */
export function runCommand(params: ExecRunParams): Promise<ExecRunResult> {
  const command = String(params.command || '').trim();
  if (!command) {
    return Promise.reject(new Error('command is empty'));
  }
  try {
    validateEnv(params.env);
  } catch (e) {
    return Promise.reject(e);
  }
  const cwd =
    params.cwd && String(params.cwd).trim()
      ? String(params.cwd).trim()
      : undefined;
  const timeoutMs = Math.max(
    1_000,
    Math.min(
      EXEC_TIMEOUT_MAX_MS,
      Math.round(Number(params.timeoutMs) || EXEC_TIMEOUT_DEFAULT_MS),
    ),
  );
  const env = params.env ? { ...process.env, ...params.env } : process.env;

  const started = Date.now();
  return new Promise<ExecRunResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    let child;
    try {
      child = spawn(command, {
        shell: true,
        cwd,
        env,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (e: any) {
      resolve({
        exitCode: -1,
        stdout: '',
        stderr: e?.message || String(e),
        truncated: false,
        timedOut: false,
        durationMs: Date.now() - started,
        cwd: cwd || process.cwd(),
      });
      return;
    }

    const collect = (chunk: Buffer, isStdout: boolean) => {
      const text = chunk.toString('utf8');
      const current = isStdout ? stdout : stderr;
      if (current.length >= EXEC_OUTPUT_CAP) {
        truncated = true;
        return; // keep draining, discard the rest
      }
      if (current.length + text.length > EXEC_OUTPUT_CAP) {
        truncated = true;
        if (isStdout) stdout += text.slice(0, EXEC_OUTPUT_CAP - current.length);
        else stderr += text.slice(0, EXEC_OUTPUT_CAP - current.length);
        return;
      }
      if (isStdout) stdout += text;
      else stderr += text;
    };
    child.stdout?.on('data', (c: Buffer) => collect(c, true));
    child.stderr?.on('data', (c: Buffer) => collect(c, false));

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout,
        stderr,
        truncated,
        timedOut,
        durationMs: Date.now() - started,
        cwd: cwd || process.cwd(),
      });
    };
    child.on('error', (e: any) => {
      // spawn failures (ENOENT on shell/cwd) surface here
      stderr += `\n${e?.message || String(e)}`;
      finish(-1);
    });
    child.on('close', (code) => finish(code));
  });
}

/** Append one audit entry to <dir>/history.jsonl (best-effort). */
export function appendExecAudit(
  dir: string,
  entry: Record<string, unknown>,
): void {
  try {
    fs.ensureDirSync(dir);
    fs.appendFileSync(
      path.join(dir, 'history.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      'utf8',
    );
  } catch {
    /* audit is best-effort */
  }
}
