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
 * AI knowledge base: curated articles about the agent's tools and skills,
 * plus user-authored entries. Built-in articles are defined in code (so they
 * ship with the app and can render a live tool table); user entries live in
 * localStorage. Content is markdown, rendered with `marked` in the UI.
 */

import { CommonLocation } from '-/utils/CommonLocation';
import {
  getCustomSkills,
  getCustomTools,
} from '-/components/chat/agentCapabilities';
import { createAgentTools } from '-/components/chat/AgentTools';

export type KBEntry = {
  id: string;
  title: string;
  content: string;
  updatedAt: number;
  builtIn?: boolean;
};

const USER_ENTRIES_KEY = 'tsKnowledgeBaseEntries';

function readUserEntries(): KBEntry[] {
  try {
    const raw = localStorage.getItem(USER_ENTRIES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as KBEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function writeUserEntries(entries: KBEntry[]): void {
  localStorage.setItem(USER_ENTRIES_KEY, JSON.stringify(entries));
}

/** Live tool table for the built-in tools article. */
function renderToolCatalog(): string {
  try {
    const builtin = createAgentTools({} as any).map((t) => ({
      name: t.name,
      description: t.description.split('.')[0],
    }));
    const rows = builtin
      .map((t) => `| \`${t.name}\` | ${t.description} |`)
      .join('\n');
    const custom = getCustomTools().filter((t) => t.enabled);
    const customRows = custom
      .map((t) => `| \`${t.name}\` | ${t.description}（自定义 HTTP 工具） |`)
      .join('\n');
    return [
      '| 工具 | 作用 |',
      '| --- | --- |',
      rows,
      ...(customRows
        ? [
            '\n**自定义工具：**\n',
            '| 工具 | 作用 |',
            '| --- | --- |',
            customRows,
          ]
        : []),
    ].join('\n');
  } catch (e) {
    return '（工具目录暂不可用）';
  }
}

function renderSkillCatalog(): string {
  try {
    const custom = getCustomSkills();
    if (custom.length === 0) return '_还没有自定义技能。_\n';
    return custom
      .map(
        (s) =>
          `- **${s.name}**${s.enabled ? '' : '（已停用）'}：${s.instruction.split('\n')[0]}`,
      )
      .join('\n');
  } catch (e) {
    return '';
  }
}

/** Built-in articles. Content is Chinese (primary audience of this build). */
function getBuiltinEntries(): KBEntry[] {
  const now = Date.now();
  return [
    {
      id: 'builtin-tools-vs-skills',
      title: '「工具」和「技能」的区别',
      builtIn: true,
      updatedAt: now,
      content: `一句话：**工具是 Agent 的"手"，技能是 Agent 的"做事方法"**。

## 工具（Tool）＝ 能执行的动作

- 本质：一个可调用的函数/API，模型通过 **function calling 标准协议**（OpenAI 的 \`tools\` / \`tool_calls\`）触发，应用执行后把结果喂回模型
- **有执行体、有真实副作用**：搜文件就真的搜了，move_file 就真的把文件挪了
- **有结构化参数**：用 JSON Schema 定义（如 move_file 的 \`sourcePath\` / \`targetFolder\`），模型负责填参数
- 两类载体：
  - **内置工具**：应用内代码直接执行（不是网络 API）
  - **自定义工具**：任意 HTTP 端点——模型生成参数 → 应用 POST 给你的服务 → 响应回传。调用协议是标准的，端点本身只要能收 JSON 返回文本即可
- 工具列表就是模型的"能力边界"：关掉某个工具，模型就真的没有这个动作

## 技能（Skill）＝ 注入的行为方法

- 本质：一段纯文本指令，注入系统提示词，**没有执行体、没有参数、没有返回值**
- 不"做"任何事，只改变模型做事的**方式和倾向**：流程、输出格式、规则
- 例：「周报生成」——检索本周会议纪要，按三段式输出 markdown。没有可执行代码，但模型遇到写周报的请求会照这个 SOP 来
- 零运行时成本，纯提示词的一部分

## 对比

| | 工具 | 技能 |
| --- | --- | --- |
| 类比 | 手（函数/API） | 脑中的 SOP / 工作手册 |
| 有执行体 | ✅ 代码或 HTTP 调用 | ❌ 纯文本 |
| 占用 Agent 步数 | ✅ 每次调用算一步 | ❌ 不占 |
| 例 | move_file、内部审批接口 | 「周报三段式」「整理前列清单」 |

配合示例：用户说「出一份本周周报」→ **技能**告诉模型"三段式、先检索会议纪要" → 模型按此**调用工具**（search_files 检索、write_deliverable 落盘）。干活的是工具，知道怎么干的是技能。`,
    },
    {
      id: 'builtin-tool-catalog',
      title: '工具一览（实时）',
      builtIn: true,
      updatedAt: now,
      content: `当前 Agent 可用的全部工具（每次打开自动刷新，含你启用的自定义工具）：

${renderToolCatalog()}

> 在「技能与工具」中心（AI 工作区标题栏 🧩）可以停用内置工具、添加自定义工具。`,
    },
    {
      id: 'builtin-custom-tool-howto',
      title: '如何添加自定义工具',
      builtIn: true,
      updatedAt: now,
      content: `自定义工具 = 一个 **HTTP 端点**，Agent 需要时会把模型生成的参数 POST 给它，响应文本回传给模型。

## 步骤

1. 打开 AI 工作区 → 标题栏 🧩 → 「工具」Tab → **添加工具**
2. 填写：
   - **显示名称**：模型看到的函数名会自动清洗成合法格式
   - **描述**：写给模型看——它据此判断什么时候该调用这个工具
   - **参数 JSON Schema**：标准 JSON Schema，定义模型要填哪些参数
   - **端点 URL**：http/https 均可，请求体为 \`{"参数名": 值}\`
   - **请求头**（可选）：如 \`{"Authorization": "Bearer xxx"}\`
3. 点**测试**（用空参数调用一次）验证连通，然后保存

## 注意事项

- 请求会以应用内 fetch 发出（无 CORS 限制），超时 30 秒
- HTTP 非 2xx 会把状态码和响应前 2000 字符作为错误回传给模型
- 只填内网/可信端点；保存前先测试`,
    },
    {
      id: 'builtin-custom-skill-howto',
      title: '如何添加自定义技能',
      builtIn: true,
      updatedAt: now,
      content: `自定义技能 = 一段**有名字的指令**，启用后注入 Agent 系统提示词。当用户请求匹配技能内容时，Agent 按指令行事。

## 步骤

1. AI 工作区 → 🧩 → 「技能」Tab → **添加技能**
2. 填写名称和指令（指令就是提示词片段，支持多行），保存并保持开关打开

## 写好指令的要点

- 写清**触发场景**（"当用户要求…时"）和**执行步骤**（1/2/3）
- 写明**输出格式**（分几段、每段是什么）
- 引用工具时用工具名（如 \`search_files\`、\`write_deliverable\`），Agent 会照做

## 当前自定义技能

${renderSkillCatalog()}`,
    },
    {
      id: 'builtin-conventions',
      title: '约定文件（CLAUDE.md / AGENTS.md）',
      builtIn: true,
      updatedAt: now,
      content: `每个位置（location）的根目录可以放一个 \`CLAUDE.md\` 或 \`AGENTS.md\` 约定文件，Agent 启动时自动读取并注入系统提示词（上限 4000 字符）。

适合放的内容：

- 目录结构约定（哪个文件夹放什么）
- 标签体系规范（类型标签、状态标签）
- 个性化指令（"整理时优先按项目分"）

和自定义技能的区别：约定文件**跟着位置走**（同一位置的 Agent 都遵守），技能是**全局的用户资产**。`,
    },
    {
      id: 'builtin-global-mode',
      title: '全局模式与跨文件夹边界',
      builtIn: true,
      updatedAt: now,
      content: `不开任何文件夹也能用 AI Agent（欢迎页入口或右侧 ✨ 浮标）：

- Agent 用 \`list_locations\` 发现本机所有已连接的文件夹
- 所有路径类工具（list_folder / move_file / add_tags / set_description…）按**路径前缀**解析所属位置，无需该文件夹处于打开状态
- **边界**：移动文件只能在同一个位置内部进行；跨位置搬移（如 Downloads → Documents）意味着"复制+删除"，暂不支持
- Agent 有检查点机制：8 轮工具调用后会汇报进展并自动续期（最多 4 次），批量任务不会被硬掐`,
    },
    {
      id: 'builtin-organize-flow',
      title: '整理文件夹的推荐说法',
      builtIn: true,
      updatedAt: now,
      content: `对 Agent 说的话越具体，结果越稳：

**基础版**

> 整理Downloads

**推荐版**

> 整理 Downloads：把文档、安装包、项目代码分别移到对应的分类文件夹里，每份文件打上类型标签；未完成的下载留在原处

**带产出版**

> 整理完 Downloads 后，把整理结果写成一份清单文档放到 知识库/ 目录

相关机制：Agent 会先 \`list_folder\`/\`search_files\` 摸清现状 → 给出分类方案 → 逐个 \`move_file\` → \`add_tags\` → 最后汇报。批量任务触发检查点时会先向你汇报进展。`,
    },
  ];
}

/** All knowledge base entries: built-in first, then user-authored. */
export function getKnowledgeEntries(): KBEntry[] {
  return [...getBuiltinEntries(), ...readUserEntries()];
}

export function saveKnowledgeEntry(entry: {
  id?: string;
  title: string;
  content: string;
}): KBEntry {
  const entries = readUserEntries();
  const id = entry.id || `kb-${Date.now()}`;
  const saved: KBEntry = {
    id,
    title: entry.title.trim(),
    content: entry.content,
    updatedAt: Date.now(),
  };
  const existing = entries.findIndex((e) => e.id === id);
  if (existing >= 0) {
    entries[existing] = saved;
  } else {
    entries.push(saved);
  }
  writeUserEntries(entries);
  return saved;
}

export function deleteKnowledgeEntry(id: string): void {
  writeUserEntries(readUserEntries().filter((e) => e.id !== id));
}

export function isBuiltInEntry(id: string): boolean {
  return id.startsWith('builtin-');
}

// ---------- per-location knowledge base (.ts/ai/kb/*.md) ----------

/** Directory of a location's folder knowledge base. */
export function kbDirForLocationPath(locationPath: string): string {
  return `${locationPath.replace(/[\\/]+$/, '')}/.ts/ai/kb`;
}

function kbSlug(title: string): string {
  const slug = title
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 40);
  return slug || 'entry';
}

/**
 * List the knowledge base entries of one location. Each .md file in
 * `.ts/ai/kb/` is an entry; the title is its first `# ` heading.
 */
export async function listLocationKb(
  location: CommonLocation,
): Promise<KBEntry[]> {
  const locationPath = location.path;
  if (!locationPath) return [];
  const dir = kbDirForLocationPath(locationPath);
  let files: Array<any> = [];
  try {
    files = (await location.listDirectoryPromise(dir)) || [];
  } catch (e) {
    return []; // directory does not exist yet — empty knowledge base
  }
  const mdFiles = files.filter(
    (f) => f.isFile && f.name.toLowerCase().endsWith('.md'),
  );
  const entries: KBEntry[] = [];
  for (const file of mdFiles) {
    try {
      const content = await location.loadTextFilePromise(file.path);
      const titleMatch = content.match(/^#\s+(.+)$/m);
      entries.push({
        id: file.name,
        title: titleMatch
          ? titleMatch[1].trim()
          : file.name.replace(/\.md$/i, ''),
        content,
        updatedAt: file.lmdt || 0,
        builtIn: false,
      });
    } catch (e) {
      /* skip unreadable file */
    }
  }
  return entries.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Read one location KB entry (id = file name) with a char guard. */
export async function readLocationKbFile(
  location: CommonLocation,
  id: string,
): Promise<string> {
  const dir = kbDirForLocationPath(location.path);
  const content = await location.loadTextFilePromise(`${dir}/${id}`);
  return content.slice(0, 8000);
}

/** Write (or update) a location KB entry as markdown. */
export async function writeLocationKb(
  location: CommonLocation,
  title: string,
  content: string,
  existingId?: string,
): Promise<{ id: string; path: string; updated: boolean }> {
  const dir = kbDirForLocationPath(location.path);
  const body = content.startsWith(`# ${title}`)
    ? content
    : `# ${title}\n\n${content}`;
  if (existingId) {
    const path = `${dir}/${existingId}`;
    await location.saveTextFilePromise({ path }, body, true);
    return { id: existingId, path, updated: true };
  }
  let id = `${kbSlug(title)}.md`;
  let path = `${dir}/${id}`;
  // Never overwrite silently: bump the file name until free.
  let attempt = 1;
  while (await location.checkFileExist(path)) {
    if ((await location.loadTextFilePromise(path).catch(() => '')) === body) {
      break; // identical content — same entry, just update in place
    }
    id = `${kbSlug(title)}-${attempt}.md`;
    path = `${dir}/${id}`;
    attempt += 1;
    if (attempt > 50) break;
  }
  await location.saveTextFilePromise({ path }, body, false);
  return { id, path, updated: false };
}

/** Delete a location KB entry (id = file name). */
export async function deleteLocationKbFile(
  location: CommonLocation,
  id: string,
): Promise<void> {
  const dir = kbDirForLocationPath(location.path);
  await location.deleteFilePromise(`${dir}/${id}`, false);
}

/**
 * Build the agent-tool deps for the per-location knowledge base. Locations
 * are resolved by path prefix first (the agent may work on a folder other
 * than the open one), falling back to the current location.
 */
export function makeKbToolDeps(
  findLocationByPath: (path: string) => CommonLocation | undefined,
  findCurrentLocation: () => CommonLocation | undefined,
): {
  kbList: (
    locationPath?: string,
  ) => Promise<
    Array<{ id: string; title: string; excerpt: string; updatedAt: number }>
  >;
  kbRead: (id: string, locationPath?: string) => Promise<string>;
  kbWrite: (
    title: string,
    content: string,
    locationPath?: string,
  ) => Promise<{ id: string; path: string }>;
} {
  const resolve = (locationPath?: string) =>
    (locationPath && findLocationByPath(locationPath)) || findCurrentLocation();
  return {
    kbList: async (locationPath) => {
      const loc = resolve(locationPath);
      if (!loc) {
        throw new Error(
          'no connected location — open one or pass locationPath',
        );
      }
      const entries = await listLocationKb(loc);
      return entries.map((e) => ({
        id: e.id,
        title: e.title,
        excerpt: e.content
          .replace(/^#\s+.+\n?/, '')
          .replace(/\s+/g, ' ')
          .slice(0, 200),
        updatedAt: e.updatedAt,
      }));
    },
    kbRead: async (id, locationPath) => {
      const loc = resolve(locationPath);
      if (!loc) {
        throw new Error('no connected location');
      }
      return readLocationKbFile(loc, id);
    },
    kbWrite: async (title, content, locationPath) => {
      const loc = resolve(locationPath);
      if (!loc) {
        throw new Error(
          'no connected location — open one or pass locationPath',
        );
      }
      return writeLocationKb(loc, title, content);
    },
  };
}
