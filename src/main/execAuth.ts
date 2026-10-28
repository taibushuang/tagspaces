/**
 * Authorization gate for the agent's run_command tool — lives in the MAIN
 * process (the renderer is not a trust boundary: webSecurity is false and
 * local HTML is previewable, so grants are persisted and re-checked here,
 * never in the renderer).
 *
 * Two-tier model (user constraint: avoid frequent prompts):
 * - Tier 1 (silent, everyday case): the command is a SIMPLE line (no shell
 *   metacharacters) and its PREFIX (first token) was remembered → auto-run.
 * - Tier 2 (compound lines, remembered by FULL LINE): lines containing
 *   shell metacharacters (& | ; < > ` $( … ) can smuggle arbitrary
 *   secondary commands past a prefix grant, so they always confirm once and
 *   are remembered by the exact line — the same line re-runs silently, any
 *   change re-prompts.
 * - Elevated prefixes (sudo/su/doas) ALWAYS confirm and are never remembered.
 * - Execution requires a single-use token issued by execAuthorize/execGrant;
 *   execRun refuses calls without a valid token. Renderer verdicts are never
 *   trusted — the main process re-checks every rule itself.
 */

import { randomUUID } from 'crypto';
import fs from 'fs-extra';
import path from 'path';

const GRANTS_FILE = 'grants.json';
const TOKEN_TTL_MS = 5 * 60_000;
const ELEVATION_PREFIXES = ['sudo', 'su', 'doas'];

/** Conservative detection — quoted metacharacters also count (safety first). */
export function hasShellMetachars(command: string): boolean {
  return /[&|;<>`\n]|\$\(/.test(String(command || ''));
}

/** Extract the command prefix (first shell token) used for authorization. */
export function commandPrefix(command: string): string {
  const line = String(command || '').trim();
  if (!line) return '';
  const quote = line[0];
  if (quote === '"' || quote === "'") {
    const end = line.indexOf(quote, 1);
    if (end > 0) return line.slice(1, end);
  }
  const token = line.split(/\s+/)[0] || '';
  return token.replace(/^["']|["']$/g, '');
}

export type ExecAuthStatus = 'granted' | 'needs-confirmation' | 'denied';

export type ExecAuthResult = {
  status: ExecAuthStatus;
  prefix: string;
  /** Exact string to remember on approval (prefix for simple lines, the full line for compound ones). Empty when remembering is not allowed. */
  rememberKey: string;
  canRemember: boolean;
  reason?: string;
  /** Single-use execution token — present only when status is 'granted'. */
  token?: string;
};

type GrantsFile = {
  prefixes: Record<string, { at: number }>;
  lines: Record<string, { at: number }>;
};

export class ExecAuthorizer {
  private grants: GrantsFile = { prefixes: {}, lines: {} };

  private tokens = new Map<string, number>();

  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
    this.load();
  }

  private get file(): string {
    return path.join(this.dir, GRANTS_FILE);
  }

  private load(): void {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.grants = {
          prefixes: parsed?.prefixes || {},
          lines: parsed?.lines || {},
        };
      }
    } catch {
      this.grants = { prefixes: {}, lines: {} };
    }
  }

  private save(): void {
    try {
      fs.ensureDirSync(this.dir);
      fs.writeFileSync(this.file, JSON.stringify(this.grants, null, 2), 'utf8');
    } catch {
      /* grants stay in-memory only */
    }
  }

  /** The full two-tier decision — the single source of truth for exec auth. */
  authorize(command: string): ExecAuthResult {
    const line = String(command || '').trim();
    if (!line) {
      return {
        status: 'denied',
        prefix: '',
        rememberKey: '',
        canRemember: false,
        reason: 'command is empty',
      };
    }
    const prefix = commandPrefix(line);
    const meta = hasShellMetachars(line);
    const isElevated = ELEVATION_PREFIXES.includes(prefix.toLowerCase());
    if (isElevated) {
      return {
        status: 'needs-confirmation',
        prefix,
        rememberKey: '',
        canRemember: false,
        reason:
          'elevated-privilege commands always require confirmation and are never remembered',
      };
    }
    if (!meta && this.grants.prefixes[prefix.toLowerCase()]) {
      return {
        status: 'granted',
        prefix,
        rememberKey: '',
        canRemember: false,
        token: this.issueToken(),
      };
    }
    if (meta && this.grants.lines[line]) {
      return {
        status: 'granted',
        prefix,
        rememberKey: '',
        canRemember: false,
        token: this.issueToken(),
      };
    }
    return {
      status: 'needs-confirmation',
      prefix,
      rememberKey: meta ? line : prefix.toLowerCase(),
      canRemember: true,
      reason: meta
        ? 'compound command (shell metacharacters) — approved per exact line'
        : 'new command prefix',
    };
  }

  /**
   * Record a remembered grant (prefix for simple lines, the full line for
   * compound ones) and issue a single-use execution token.
   */
  grant(rememberKey: string, remember: boolean): string {
    const key = String(rememberKey || '').trim();
    if (
      remember &&
      key &&
      !ELEVATION_PREFIXES.includes(commandPrefix(key).toLowerCase())
    ) {
      if (hasShellMetachars(key)) {
        this.grants.lines[key] = { at: Date.now() };
      } else {
        this.grants.prefixes[key.toLowerCase()] = { at: Date.now() };
      }
      this.save();
    }
    return this.issueToken();
  }

  issueToken(): string {
    const token = randomUUID();
    this.tokens.set(token, Date.now() + TOKEN_TTL_MS);
    return token;
  }

  /** Single-use: a token authorizes exactly one execRun call. */
  consumeToken(token: string): boolean {
    const expires = this.tokens.get(token);
    if (!expires || expires < Date.now()) return false;
    this.tokens.delete(token);
    // opportunistic cleanup of stale tokens
    const now = Date.now();
    for (const [t, exp] of this.tokens) {
      if (exp < now) this.tokens.delete(t);
    }
    return true;
  }

  /** Snapshot of currently remembered grants (prefixes + exact lines). */
  grantsSummary(): { prefixes: string[]; lines: string[]; file: string } {
    return {
      prefixes: Object.keys(this.grants.prefixes).sort(),
      lines: Object.keys(this.grants.lines).sort(),
      file: this.file,
    };
  }

  /**
   * Revoke ALL remembered grants — the reset mechanism requested after a
   * wrongly remembered/denied prefix: afterwards every command falls back to
   * the confirmation dialog. Equivalent to deleting grants.json.
   */
  revokeAll(): { prefixes: string[]; lines: string[]; file: string } {
    this.grants = { prefixes: {}, lines: {} };
    this.save();
    return this.grantsSummary();
  }
}
