# DESIGN：TagSpaces AI Agent 集成设计

> 状态：已评审（口头），进入实现
> 日期：2026-09-25
> 关联代码：`src/renderer/components/chat/`、`src/renderer/hooks/ChatProvider.tsx`

## 1. 背景与目标

为 TagSpaces 集成 AI Agent：一个能**调用工具**（搜索、打标签、读文件等）的对话式
文件管理助手，区别于现有的纯文本聊天（ChatView）与 AI 生成（标签/描述生成）。

硬性要求：

- 模型后端为国内可用的 OpenAI 兼容服务（Kimi / DeepSeek / 火山方舟），未来接**办公内网大模型网关**。
- **API 地址、API Key、模型名称全部用户可配置**，不绑死任何一家供应商。
- 遵循 TagSpaces 本地优先原则：对话内容只发往用户配置的端点，无遥测。

## 2. 选型结论（推导过程）

### 2.1 约束

| 约束 | 来源 | 影响 |
|---|---|---|
| 全栈 TypeScript（Electron + React） | 项目现实 | 排除所有 Python 系框架（CrewAI/AutoGen/LangChain-Python） |
| 模型端点必须 OpenAI 兼容、可自配 | 用户需求（国内模型 + 内网网关） | 不需要多 provider SDK，一条 OpenAI 兼容通道即可 |
| 依赖洁癖、无原生模块 | koffi 血泪史（见 AGENTS.md） | 不引入重量级框架（LangChain.js） |
| 已有 AI 基础设施 | 现状：`AiClient` 已支持 `openai-compatible` 引擎 | **不引入任何 agent 框架依赖**，自建轻量 tool-use 循环 |

### 2.2 关键发现：现有基础设施已覆盖 80%

探索发现项目已有完整的 AI 通道（此前为 Ollama/本地模型设计）：

- **Provider 配置**：`AIProvider`（`ChatTypes.ts`）= `{ id, engine, name, url, authKey, defaultTextModel }`，
  设置界面 `SettingsAI.tsx` 已支持增删改、连接测试（`checkProviderAlive`）。
- **OpenAI 兼容客户端**：`OpenAIClient.ts` 已实现 `GET /v1/models` + `POST /v1/chat/completions`，
  支持 baseURL 归一化（带不带 `/v1` 都行）、Bearer 鉴权、SSE 流式。
- **聊天 UI**：`ChatView.tsx`（EntryContainer 的 AI Tab），历史持久化到文件夹元数据 `.ts/ai/`。
- **预设体系**：`aiPresets.ts`，加预设 = 加一行数据。

因此**放弃引入 Vercel AI SDK**：它要解决的 provider 抽象/流式/UI 绑定问题，
现有代码都已解决；引入反而多一套依赖和两套聊天栈。缺口只有一个——
**tool-calling 循环**（现客户端只解析 `delta.content`，不识别 `tool_calls`），
这部分自建约 300 行，比引入框架更可控。

### 2.3 方案：自建轻量 Agent 循环（渲染层）

Agent 循环放**渲染层**而非主进程，理由：

1. 现有全部 AI 代码（AiClient/ChatProvider/设置）都在渲染层，保持一致；
2. Agent 需要的能力（搜索索引、打标签、选中状态、当前文件夹）都是渲染层
   context/service，放主进程反而要大规模打通 IPC；
3. 渲染层 fetch 直连 OpenAI 兼容端点已被现有聊天验证可行。

```
ChatView (AI Tab)
   │ agent 模式开关
   ▼
ChatProvider.newAgentMessage(msg)          ← 新增
   ▼
AgentService.runAgent(...)                 ← 新增，纯函数式循环
   │  OpenAI 兼容端点（复用 AIProvider.url/authKey/defaultTextModel）
   │  messages + tools(JSON Schema)
   ▼
AgentTools（注册表）                        ← 新增
   ├─ search_files      → LocationIndexContextProvider.agentSearch()   ← 新增
   ├─ get_entry_tags    → 索引/路径查询
   ├─ add_tags          → TaggingActionsContext.addTagsToFsEntry()
   ├─ remove_tags       → TaggingActionsContext.removeTagsFromEntry()
   ├─ read_file_text    → location.loadTextFilePromise()（限大小）
   └─ list_folder       → 当前文件夹索引条目
```

## 3. 详细设计

### 3.1 Agent 循环（`AgentService.ts`，新增）

- 输入：provider(url/authKey/model)、messages、tools、onEvent 回调、abortSignal。
- 循环：请求 → 若返回 `tool_calls` → 逐个执行工具 → 以 `role:'tool'` 追加结果 → 继续；
  若返回纯文本 → 结束。上限 `maxSteps = 8` 防失控。
- 流式：`stream: true`，文本 delta 实时回调（与现聊天一致的打字机效果）；
  `tool_calls` 按 OpenAI 流式协议以 `delta.tool_calls[].index` 增量拼装。
- 错误处理：HTTP 非 200 / 网络错误 / 单工具异常都转为 `role:'tool'` 的错误文本，
  让模型能向用户解释，而不是整轮崩掉。
- 无 tool-calling 能力的端点：连接测试时探测（发一个带 tools 的请求），
  不支持时明确报错提示，不静默退化。

### 3.2 工具（`AgentTools.ts`，新增）

全部为只读或低风险操作，**第一版不含 rename/move/delete**（见 §4 护栏）：

| 工具 | 参数 | 实现宿主 |
|---|---|---|
| `search_files` | `textQuery?`, `scope: location/global`, `maxResults≤50` | `LocationIndexContextProvider` 新增 `agentSearch()`：复用内部 `loadIndexFromDisk` / `createDirectoryIndexWrapper` / `getSearchResults`，**无 UI 副作用**（不写 redux、不弹通知），直接返回 `FileSystemEntry[]` |
| `list_folder` | `path?`（默认当前文件夹） | 当前 location 索引按目录过滤 |
| `get_entry_tags` | `path` | 同上索引查询 |
| `add_tags` | `path`, `tags[]` | `TaggingActionsContext.addTagsToFsEntry()` |
| `remove_tags` | `path`, `tags[]` | `TaggingActionsContext.removeTagsFromEntry()` |
| `read_file_text` | `path`, `maxChars≤20000` | `location.loadTextFilePromise()`，仅文本类扩展名（复用 `AppConfig` 的文本类型表），超限截断 |

工具结果一律 JSON.stringify 后塞回 `role:'tool'` 消息，并截断超长结果（防上下文爆炸）。

### 3.3 系统提示词与上下文注入

发送前自动注入 system 消息：

- 当前 location 名称/路径、当前文件夹路径；
- 当前选中条目（`useSelectedEntriesContext`）的路径与标签；
- 应用能力说明（引导模型用工具而非凭空回答"你的文件"类问题）；
- 用户界面语言（`interfaceLanguage`），让模型用中文回答。

### 3.4 UI（`ChatView.tsx` 改造）

- 模型选择行加 **Agent 模式开关**（`TsSwitch`/toggle，状态存 localStorage `tsAiAgentMode`）。
- 开启后：输入经 `newAgentMessage`；工具调用以状态行形式流式插入聊天 markdown：
  `🔧 search_files({"textQuery":"invoice"}) → 12 results`；
- 历史持久化沿用现有 `ChatItem` 机制（工具步骤并入 response 文本，改动最小）。

### 3.5 预设（`aiPresets.ts`）

新增四行（均为 `openai-compatible` 引擎）：

| key | label | defaultUrl |
|---|---|---|
| `kimi` | Kimi (Moonshot) | `https://api.moonshot.cn/v1` |
| `deepseek` | DeepSeek | `https://api.deepseek.com/v1` |
| `volcark` | 火山方舟 Ark | `https://ark.cn-beijing.volces.com/api/v3` |
| `intranet` | 内网/自定义网关 | （空，手动填） |

引擎类型不变 → 客户端零改动。

### 3.6 内网部署注意点（记录，本期不实现 TLS 项）

- **自签名证书**：渲染层 fetch 受 Chromium 网络栈管制，自签名证书会失败。
  过渡方案：内网网关上装企业 CA / 正式证书；如需支持自签名，后续在主进程加代理 IPC。
- **流式被代理缓冲**：SSE 可能被内网代理缓冲，失败时可退非流式（Agent 循环对两种模式均兼容）。
- **tool-calling 能力验证**：连接测试增加"能力探测"，内网网关后挂的模型若不支持函数调用则明确提示。

## 4. 安全与护栏

1. **无破坏性工具**：本期不提供 rename/move/delete 工具；打标签可逆（可 remove）。
2. **结果截断**：搜索 ≤50 条、文件读取 ≤20000 字符，防提示词注入与上下文爆炸。
3. **取消**：abortSignal 贯穿循环与 fetch，沿用现有取消按钮。
4. **无遥测**：对话与工具结果只发往用户配置的 baseURL。

## 5. 实现清单

- [x] `OpenAIClient.ts`：`toOpenAIRequest` 支持 `tools`；响应解析支持 `tool_calls`（流式增量拼装 + 非流式），新增 `chatOpenAICompletion()` 返回 `{ content, toolCalls }`
- [x] `AgentService.ts`（新增）：agent 循环（`runAgent`，maxSteps=8，事件回调，abort 贯穿）+ `checkAgentSupport` 能力探测
- [x] `AgentTools.ts`（新增）：`createAgentTools(deps)` 工厂，6 个工具（search_files / list_folder / get_entry_tags / add_tags / remove_tags / read_file_text）
- [x] `LocationIndexContextProvider.tsx`：新增 `agentSearch()`（无 UI 副作用）
- [x] `ChatProvider.tsx`：新增 `newAgentMessage` / `agentMode`（localStorage 持久化）/ `setAgentMode`；系统提示词注入 location/当前文件夹/选中项/界面语言
- [x] `ChatView.tsx`：Agent 开关（TsSwitch）；发送分流 agent/普通聊天；工具步骤以 `🔧 name(args) → 结果` 形式流入聊天 markdown
- [x] `aiPresets.ts`：Kimi / DeepSeek / 火山方舟 / 内网自定义 四个预设
- [x] `locales/en/core.json` + `locales/zh_CN/core.json`：`aiAgentMode`、`aiAgentRunFailed`
- [x] 构建验证：`tsc --noEmit` 触及文件零错误；`npm run build:renderer` 通过

## 6. 验收标准

1. 配置 Kimi/DeepSeek/方舟任一 provider 后，Agent 模式下提问
   "帮我找出当前文件夹里所有 pdf 并打上 invoice 标签"能触发
   `search_files` → `add_tags` 工具链并在 UI 可见步骤。
2. 无 tool-calling 能力的端点在连接测试时得到明确错误。
3. `npm run build:renderer` + tsc 无新错误。
