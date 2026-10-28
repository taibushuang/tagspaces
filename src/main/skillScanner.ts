/**
 * External skill scanner for the "import skills from other agent clients"
 * feature (Qwenpaw / Claude Code / arkcli-connect share the same SKILL.md
 * convention: a folder per skill with a markdown file inside).
 *
 * Pure logic (no electron import — the IPC layer passes the user home dir),
 * unit-testable:
 * - probe default candidate directories plus user-registered extras;
 * - transform each SKILL.md into a TagSpaces custom-skill instruction:
 *   strip YAML frontmatter (name/description become the skill identity),
 *   map client tool references (Bash/Read/Write/…) onto TagSpaces tool
 *   names, cap the length so the agent system prompt stays bounded.
 */

import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import type {
  PreparedSkillImport,
  ScannedSkill,
  ScannedToolServer,
} from './ipcContracts';

// Canonical type definitions live in ipcContracts.ts (shared with the
// renderer side of the IPC boundary); re-exported here for compatibility.
export type {
  PreparedSkillImport,
  ScannedSkill,
  ScannedToolServer,
} from './ipcContracts';

export const SKILL_FILE = 'SKILL.md';
/** Instruction cap — prompt skills are injected into the system prompt. */
export const SKILL_INSTRUCTION_CAP = 12_000;
export const SCAN_DIRS_FILE = 'scan-dirs.json';

/** Common per-user skill directories across agent clients. */
export function defaultScanDirs(home = os.homedir()): string[] {
  return [
    path.join(home, '.agents', 'skills'),
    path.join(home, '.claude', 'skills'),
    path.join(home, '.qwenpaw', 'skills'),
    path.join(home, '.config', 'qwenpaw', 'skills'),
    path.join(home, '.openclaw', 'skills'),
    path.join(home, '.codex', 'skills'),
  ];
}

/** Strip YAML frontmatter, harvesting name/description. */
function stripFrontmatter(raw: string): {
  body: string;
  name?: string;
  description?: string;
} {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { body: raw };
  let name: string | undefined;
  let description: string | undefined;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(name|description)\s*:\s*(.+)$/);
    if (kv) {
      const value = kv[2].trim().replace(/^["']|["']$/g, '');
      if (kv[1] === 'name') name = value;
      else description = value;
    }
  }
  return { body: raw.slice(m[0].length), name, description };
}

/** Map common agent-client tool references onto TagSpaces tool names. */
export function mapToolReferences(markdown: string): string {
  return markdown
    .replace(/\bBash tool\b/gi, 'run_command tool')
    .replace(/\bBash\(/g, 'run_command(')
    .replace(/\bRead tool\b/gi, 'read_file_text tool')
    .replace(/\bWrite tool\b/gi, 'write_deliverable tool')
    .replace(
      /\bEdit tool\b/gi,
      'write_deliverable tool (TagSpaces has no in-place edit)',
    )
    .replace(/\bWebSearch\b/gi, 'web_search')
    .replace(/\bWebFetch\b/gi, 'fetch_web')
    .replace(/\bGlob tool\b/gi, 'search_files / list_folder tools')
    .replace(/\bGrep tool\b/gi, 'search_files tool');
}

export function transformSkillMarkdown(
  raw: string,
  fallbackName: string,
  sourceDir: string,
): {
  name: string;
  description: string;
  instruction: string;
  truncated: boolean;
} {
  const { body, name, description } = stripFrontmatter(raw);
  const mapped = mapToolReferences(body.trim());
  const note =
    `> Imported from an external agent client (${sourceDir}). Tool references were ` +
    `mapped to TagSpaces equivalents: shell → run_command, file read → read_file_text, ` +
    `write → write_deliverable, web → web_search/fetch_web.\n\n`;
  const full = note + mapped;
  const truncated = full.length > SKILL_INSTRUCTION_CAP;
  const instruction = truncated
    ? `${full.slice(0, SKILL_INSTRUCTION_CAP)}\n\n…(truncated — read the source ${path.join(sourceDir, SKILL_FILE)} for the rest)`
    : full;
  return {
    name: (name || fallbackName || 'imported-skill').slice(0, 80),
    description: (description || mapped.split(/\r?\n/)[0] || '').slice(0, 200),
    instruction,
    truncated,
  };
}

/** Scan one directory (depth 1) for skill folders containing SKILL.md. */
export function scanSkillsDir(dir: string): ScannedSkill[] {
  const results: ScannedSkill[] = [];
  const base = String(dir || '').trim();
  if (!base || !fs.existsSync(base)) return results;
  let entries: string[] = [];
  try {
    entries = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return results;
  }
  for (const name of entries) {
    const skillDir = path.join(base, name);
    const skillFile = path.join(skillDir, SKILL_FILE);
    try {
      if (!fs.existsSync(skillFile)) continue;
      const raw = fs.readFileSync(skillFile, 'utf8');
      const transformed = transformSkillMarkdown(raw, name, skillDir);
      results.push({
        dir: skillDir,
        name: transformed.name,
        description: transformed.description,
        instruction: transformed.instruction,
        truncated: transformed.truncated,
        sizeBytes: Buffer.byteLength(raw, 'utf8'),
      });
    } catch {
      // unreadable skill — skip
    }
  }
  return results;
}

// --- import: copy the WHOLE skill folder (SKILL.md + scripts/templates/…)
// so relative-path references keep working, and append the dest note. ---

function slugify(name: string): string {
  return (
    String(name || 'skill')
      .toLowerCase()
      .replace(/[^\w-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'skill'
  );
}

/** Deterministic short hash of the source directory (same algorithm as
 * agentCapabilities.sourceDirHash — keep in sync) so same-name skills from
 * different sources get separate copy directories. */
function sourceDirHash(sourceDir: string): string {
  const norm = String(sourceDir || '')
    .trim()
    .replace(/\\/g, '/')
    .toLowerCase();
  if (!norm) return '';
  let h = 5381;
  for (let i = 0; i < norm.length; i += 1) {
    h = ((h * 33) ^ norm.charCodeAt(i)) >>> 0;
  }
  return h.toString(36).slice(0, 7);
}

/**
 * Copy the entire skill folder into `<importedRoot>/<slug(name)>` (overwrite
 * = re-import) and return the full custom-skill draft. The instruction gets
 * a trailing note pointing at the copied folder so relative-path references
 * (scripts/, templates/, docs/) resolve against it.
 */
export function prepareSkillImport(
  srcDir: string,
  importedRoot: string,
): PreparedSkillImport {
  const src = String(srcDir || '').trim();
  const skillFile = path.join(src, SKILL_FILE);
  if (!fs.existsSync(skillFile)) {
    throw new Error(`no ${SKILL_FILE} in ${src}`);
  }
  const raw = fs.readFileSync(skillFile, 'utf8');
  const transformed = transformSkillMarkdown(raw, path.basename(src), src);
  const destDir = path.join(
    importedRoot,
    `${slugify(transformed.name)}${src ? `-${sourceDirHash(src)}` : ''}`,
  );
  // Copy everything EXCEPT the SKILL.md itself (already transformed into the
  // instruction) — scripts/templates/references ride along.
  fs.ensureDirSync(destDir);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === SKILL_FILE) continue;
    fs.copySync(path.join(src, entry.name), path.join(destDir, entry.name), {
      overwrite: true,
    });
  }
  const note =
    `\n\n---\nSupporting files (scripts/templates/references referenced by ` +
    `relative paths) were copied to: \`${destDir}\`. Resolve any relative ` +
    `paths in this skill against that directory (read via read_file_text or ` +
    `execute via run_command).`;
  const instruction = `${transformed.instruction}${note}`.slice(
    0,
    SKILL_INSTRUCTION_CAP + 2000,
  );
  return {
    name: transformed.name,
    description: transformed.description,
    instruction,
    truncated: transformed.truncated,
    destDir,
  };
}

/**
 * Remove the copied folder of an imported skill (cleanup when the skill is
 * deleted). Guarded: only paths inside importedRoot are removed.
 */
export function deleteImportedCopy(
  name: string,
  sourceDir: string,
  importedRoot: string,
): boolean {
  const destDir = path.join(
    importedRoot,
    `${slugify(name)}-${sourceDirHash(sourceDir)}`,
  );
  const resolved = path.resolve(destDir);
  if (!resolved.startsWith(path.resolve(importedRoot))) return false;
  if (fs.existsSync(resolved)) {
    fs.removeSync(resolved);
    return true;
  }
  return false;
}

// --- user-registered extra scan directories (persisted) ---

export function loadExtraDirs(dir: string): string[] {
  try {
    const file = path.join(dir, SCAN_DIRS_FILE);
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed?.extraDirs) ? parsed.extraDirs.map(String) : [];
  } catch {
    return [];
  }
}

export function saveExtraDirs(dir: string, extraDirs: string[]): void {
  try {
    fs.ensureDirSync(dir);
    fs.writeFileSync(
      path.join(dir, SCAN_DIRS_FILE),
      JSON.stringify({ extraDirs }, null, 2),
      'utf8',
    );
  } catch {
    /* persistence is best-effort */
  }
}

export function scanAll(
  storageDir: string,
  options: { addDirs?: string[]; addDir?: string; removeDir?: string } = {},
): {
  defaultDirs: string[];
  extraDirs: string[];
  skills: ScannedSkill[];
  toolServers: ScannedToolServer[];
} {
  let extraDirs = loadExtraDirs(storageDir);
  // Accept both the canonical array form (addDirs) and the singular string
  // form (addDir) — the IPC boundary is where such mismatches have slipped
  // through before.
  const adds = [
    ...(Array.isArray(options.addDirs) ? options.addDirs : []),
    ...(typeof options.addDir === 'string' && options.addDir.trim()
      ? [options.addDir]
      : []),
  ];
  if (adds.length > 0) {
    for (const d of adds.map((x) => String(x || '').trim()).filter(Boolean)) {
      if (!extraDirs.includes(d)) extraDirs.push(d);
    }
    saveExtraDirs(storageDir, extraDirs);
  }
  if (options.removeDir) {
    extraDirs = extraDirs.filter((d) => d !== options.removeDir);
    saveExtraDirs(storageDir, extraDirs);
  }
  const defaultDirs = defaultScanDirs();
  const skills: ScannedSkill[] = [];
  for (const dir of [...defaultDirs, ...extraDirs]) {
    skills.push(...scanSkillsDir(dir));
  }
  // Tool/MCP-server configs: known client config locations + user-registered
  // directories (they may point at a client's config home too).
  const configCandidates = [
    ...extraDirs,
    path.join(os.homedir(), '.qwenpaw'),
    path.join(os.homedir(), '.config', 'qwenpaw'),
    path.join(os.homedir(), '.openclaw'),
    path.join(os.homedir(), '.claude'),
    path.join(os.homedir(), '.claude.json'),
  ];
  // QwenPaw keeps per-workspace tool/MCP configs one level deeper
  // (~/.qwenpaw/workspaces/<name>/config.json or similar) — scan those
  // directories with an extra depth.
  const workspaceCandidates = [
    path.join(os.homedir(), '.qwenpaw', 'workspaces'),
    path.join(os.homedir(), '.config', 'qwenpaw', 'workspaces'),
  ];
  const toolServers = dedupToolServers([
    ...scanToolConfigs(configCandidates, 1),
    ...scanToolConfigs(workspaceCandidates, 2),
  ]);
  return { defaultDirs, extraDirs, skills, toolServers };
}

/** De-duplicate scanned tool servers across candidate groups by file+name. */
function dedupToolServers(servers: ScannedToolServer[]): ScannedToolServer[] {
  const seen = new Set<string>();
  const out: ScannedToolServer[] = [];
  for (const s of servers) {
    const key = `${s.sourceFile}::${s.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

// --- tool / MCP-server config discovery (list-only: mounting needs an MCP
// client, which TagSpaces does not have yet) ---

const TOOL_CONFIG_KEYS = ['mcpServers', 'mcp_servers', 'servers', 'tools'];

/**
 * Redact inline secrets before a config entry is shown to the model / stored
 * in session logs: values of --token/--api-key/--secret/--password style
 * flags and bare sk-/ghp-/xoxb- style tokens become <redacted>.
 */
export function redactSecrets(text: string): string {
  return String(text || '')
    .replace(
      /((?:--?|—)?(?:token|api[-_]?key|secret|password|passwd|pwd|auth|authorization|credential)[\s=_:-]+)([^\s"'&|;]+)/gi,
      '$1<redacted>',
    )
    .replace(
      /\b(sk|ghp|gho|xoxb|xoxp|AKIA)[-_][A-Za-z0-9_-]{8,}\b/g,
      '<redacted>',
    );
}

/** Extract MCP-ish server entries from one parsed JSON object. */
export function extractToolServers(
  parsed: unknown,
  sourceFile: string,
): ScannedToolServer[] {
  const out: ScannedToolServer[] = [];
  if (!parsed || typeof parsed !== 'object') return out;
  const root = parsed as Record<string, unknown>;
  let buckets: Array<Record<string, unknown>> = [];
  for (const key of TOOL_CONFIG_KEYS) {
    const v = root[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      buckets.push(v as Record<string, unknown>);
    }
  }
  // one level of nesting (e.g. { qwenpaw: { mcpServers: … } })
  if (buckets.length === 0) {
    for (const v of Object.values(root)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const key of TOOL_CONFIG_KEYS) {
          const inner = (v as Record<string, unknown>)[key];
          if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
            buckets.push(inner as Record<string, unknown>);
          }
        }
      }
    }
  }
  for (const bucket of buckets) {
    for (const [name, def] of Object.entries(bucket)) {
      if (!def || typeof def !== 'object') continue;
      const d = def as Record<string, unknown>;
      const url = typeof d.url === 'string' ? d.url : undefined;
      const command =
        typeof d.command === 'string'
          ? [
              d.command,
              ...(Array.isArray(d.args) ? d.args.map(String) : []),
            ].join(' ')
          : undefined;
      let transport: ScannedToolServer['transport'] = 'unknown';
      if (url) {
        transport = url.includes('sse') ? 'sse' : 'http';
      } else if (command) {
        transport = 'stdio';
      }
      const rawDetail = redactSecrets(url || command || '');
      const detail =
        rawDetail.length > 300
          ? `${rawDetail.slice(0, 300)}…(truncated)`
          : rawDetail;
      out.push({
        name: name.slice(0, 80),
        transport,
        sourceFile,
        detail,
      });
    }
  }
  return out;
}

/** Directories never descended into during tool-config scans. */
const SKIP_CONFIG_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '__pycache__',
  '.venv',
]);

/**
 * Probe candidate locations for tool/MCP-server configs: a candidate may be
 * a JSON file (parsed directly) or a directory whose *.json files are parsed.
 * `maxDepth` controls how many directory levels below the candidate are
 * walked (1 = direct files only, 2 = also one level of subdirectories, e.g.
 * QwenPaw per-workspace configs under ~/.qwenpaw/workspaces/<name>/).
 * Results are de-duplicated by sourceFile+name.
 */
export function scanToolConfigs(
  candidates: string[],
  maxDepth = 1,
): ScannedToolServer[] {
  const out: ScannedToolServer[] = [];
  const seen = new Set<string>();
  const parseFile = (file: string) => {
    try {
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const server of extractToolServers(parsed, file)) {
        const key = `${server.sourceFile}::${server.name}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(server);
        }
      }
    } catch {
      /* unreadable/invalid JSON — skip */
    }
  };
  const walkDir = (dir: string, depth: number) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // per-directory cap keeps the scan bounded on huge config homes
    const jsonFiles = entries
      .filter(
        (e) =>
          e.isFile() &&
          e.name.toLowerCase().endsWith('.json') &&
          !e.name.startsWith('.'),
      )
      .slice(0, 20);
    for (const f of jsonFiles) parseFile(path.join(dir, f.name));
    if (depth < maxDepth) {
      for (const e of entries) {
        if (
          e.isDirectory() &&
          !e.name.startsWith('.') &&
          !SKIP_CONFIG_DIRS.has(e.name)
        ) {
          walkDir(path.join(dir, e.name), depth + 1);
        }
      }
    }
  };
  for (const candidate of candidates || []) {
    const c = String(candidate || '').trim();
    if (!c || !fs.existsSync(c)) continue;
    try {
      if (fs.statSync(c).isFile()) {
        parseFile(c);
      } else {
        walkDir(c, 1);
      }
    } catch {
      /* skip unreadable candidate */
    }
  }
  return out;
}
