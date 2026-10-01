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
 * AI capabilities registry: user-defined tools and skills plus enable/disable
 * state for the built-in ones. All state lives in localStorage so it survives
 * restarts without touching the redux store.
 *
 * - Custom tool  = an HTTP-callable function the agent may invoke (name,
 *   description, JSON-schema parameters, endpoint). Executed in the renderer
 *   with a 30s timeout; the response text goes back to the model.
 * - Custom skill = a named instruction block injected into the agent system
 *   prompt (same idea as the location convention file, but user-managed and
 *   individually toggleable).
 */

export type CustomToolEndpoint = {
  url: string;
  method?: 'POST' | 'GET';
  headers?: Record<string, string>;
};

export type CustomToolDef = {
  id: string;
  /** Function name as seen by the model (sanitized, unique). */
  name: string;
  /** Display name chosen by the user. */
  displayName: string;
  description: string;
  /** JSON Schema for the parameters object. */
  parameters: Record<string, any>;
  endpoint: CustomToolEndpoint;
  enabled: boolean;
};

export type CustomSkillDef = {
  id: string;
  name: string;
  instruction: string;
  enabled: boolean;
};

const CUSTOM_TOOLS_KEY = 'tsAiCustomTools';
const CUSTOM_SKILLS_KEY = 'tsAiCustomSkills';
const DISABLED_TOOLS_KEY = 'tsAiDisabledTools';
const TOOL_TIMEOUT_MS = 30000;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch (e) {
    return fallback;
  }
}

function writeJson(key: string, value: any): void {
  localStorage.setItem(key, JSON.stringify(value));
}

// ---------- custom tools ----------

export function getCustomTools(): CustomToolDef[] {
  return readJson<CustomToolDef[]>(CUSTOM_TOOLS_KEY, []);
}

export function saveCustomTool(def: CustomToolDef): void {
  const tools = getCustomTools().filter((t) => t.id !== def.id);
  tools.push(def);
  writeJson(CUSTOM_TOOLS_KEY, tools);
}

export function deleteCustomTool(id: string): void {
  writeJson(
    CUSTOM_TOOLS_KEY,
    getCustomTools().filter((t) => t.id !== id),
  );
}

/** OpenAI function names only allow [a-zA-Z0-9_-]. */
export function sanitizeToolFunctionName(displayName: string): string {
  const cleaned = displayName
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const safe = cleaned.length > 0 ? cleaned : 'tool';
  return /^[a-zA-Z_]/.test(safe) ? `custom_${safe}` : `custom_${safe}`;
}

// ---------- custom skills ----------

export function getCustomSkills(): CustomSkillDef[] {
  return readJson<CustomSkillDef[]>(CUSTOM_SKILLS_KEY, []);
}

export function getEnabledCustomSkills(): CustomSkillDef[] {
  return getCustomSkills().filter((s) => s.enabled);
}

export function saveCustomSkill(def: CustomSkillDef): void {
  const skills = getCustomSkills().filter((s) => s.id !== def.id);
  skills.push(def);
  writeJson(CUSTOM_SKILLS_KEY, skills);
}

export function deleteCustomSkill(id: string): void {
  writeJson(
    CUSTOM_SKILLS_KEY,
    getCustomSkills().filter((s) => s.id !== id),
  );
}

// ---------- built-in tool enable/disable ----------

export function getDisabledTools(): string[] {
  return readJson<string[]>(DISABLED_TOOLS_KEY, []);
}

export function setToolEnabled(name: string, enabled: boolean): void {
  const disabled = new Set(getDisabledTools());
  if (enabled) {
    disabled.delete(name);
  } else {
    disabled.add(name);
  }
  writeJson(DISABLED_TOOLS_KEY, [...disabled]);
}

export function filterEnabledTools<T extends { name: string }>(
  tools: Array<T>,
): Array<T> {
  const disabled = new Set(getDisabledTools());
  return tools.filter((t) => !disabled.has(t.name));
}

// ---------- custom tool execution ----------

/**
 * Execute a user-defined HTTP tool: POST/GET the endpoint with the model's
 * arguments as the request body and return the response text for the model.
 */
export async function executeCustomTool(
  def: CustomToolDef,
  rawArgs: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS);
  try {
    let args: any = {};
    if (rawArgs && rawArgs.trim()) {
      args = JSON.parse(rawArgs);
    }
    const method = def.endpoint.method || 'POST';
    const url = def.endpoint.url;
    if (!/^https?:\/\//i.test(url)) {
      return JSON.stringify({ error: 'endpoint must be an http(s) URL' });
    }
    const resp = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(def.endpoint.headers || {}),
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(args) }),
      signal: controller.signal,
    });
    const text = await resp.text();
    if (!resp.ok) {
      return JSON.stringify({
        error: `HTTP ${resp.status}`,
        body: text.slice(0, 2000),
      });
    }
    return text.slice(0, 8000) || '{"ok":true}';
  } catch (e: any) {
    const reason =
      e?.name === 'AbortError'
        ? `request timed out after ${TOOL_TIMEOUT_MS / 1000}s`
        : e?.message || String(e);
    return JSON.stringify({ error: reason });
  } finally {
    clearTimeout(timer);
  }
}
