# Agent Instructions for TagSpaces

## 长期目标：蒸馏个人工作（一切能力建设的 Why）

本工具所有 AI 能力建设的长期目标，是**逐渐蒸馏提取用户一个人工作中用到的
知识和流程，把用户持续不断地从流程和知识中释放出来**，让其聚焦在关键的
判断力上，并释放主动性到更具创造力和更重要的工作上去。

「蒸馏同事」的真正原理：与其说是复制一个人，不如说是把一个人工作中**最
标准化、最可被流程化的那部分经验**做一次"数据化提取"。**蒸走的是流程，
蒸不走的是人在复杂环境中的判断力和主动性**——后者恰恰要留给用户。

由此推出的建设原则（做新功能/评估新想法时对照）：

- 每个能力都要能回答："这把用户从哪段流程或知识中释放出来了？"
- 优先蒸馏**重复率高、规则清晰**的工作流（整理、汇总、产出、检索）；
  判断密集的环节（方案取舍、优先级、对外沟通）不做替代，做辅助。
- Agent 被蒸馏出来的经验应**沉淀为可复用资产**（约定文件、知识库条目、
  自定义技能/工具），而不是一次性对话。
- 能力路线图见 `TODO-ai-capabilities.md`，场景目标态见
  `DESIGN-office-ai-workflow.md`。

## 通用要求

- **思考过程和讨论交流一律使用中文**（包括内部分析、计划、解释和总结）。代码、注释、commit message、i18n 英文文案仍用英文。

- **主功能界面一律"挤占式"（2026-10-02 定）**：凡需要"展示一个完整功能面板"的页面（待办列表、AI 技能与工具等），**不用弹窗/对话框承载主内容**，而是在内容区组件 `src/renderer/components/RenderPerspective.tsx` 用 inline 面板**替换原文件夹内容区域**展示。统一模式：
  1. 全局 Context 持有 `isXxxOpen` + `toggleXxx()`（如 `TodoListContextProvider`、`AiCapabilitiesContextProvider`），入口（工具栏按钮/其他弹窗内按钮）调 `toggleXxx`；
  2. 面板组件（`XxxPanel.tsx`）为纯 props 组件（数据/回调由内容区展开传入），**不自己 useContext**，保持 import 图无环；
  3. `RenderPerspective` 里按 `isXxxOpen` 条件渲染面板替代 perspective 内容，再次点击入口或面板右上角关闭按钮即隐藏、恢复文件夹内容；
  4. 仅新建/编辑表单、删除确认这类轻量交互保留弹窗（如 `TodoEditDialog`、`ConfirmDialog`）。

## Version Management

### 打包前版本号检查
在每次执行打包命令前，必须执行以下检查：

1. **检查是否有代码更新**
   - 运行 `git log` 查看自上次版本号更新以来的 commit
   - 如果上次更新版本号的 commit 之后有新的代码改动，则必须更新版本号

2. **版本号更新规则**
   - 小改动（bug 修复、依赖更新、翻译更新等）：更新小版本号（patch），如 `6.13.9` → `6.13.10`
   - 新功能：更新次版本号（minor），如 `6.13.9` → `6.14.0`
   - 重大变更：更新主版本号（major），如 `6.13.9` → `7.0.0`

3. **版本号位置**
   - 主版本号在 `release/app/package.json` 中的 `"version"` 字段
   - 更新后确保文件名和构建产物中的版本号一致

4. **禁止操作**
   - 禁止在有代码改动的情况下不更新版本号直接打包
   - 禁止跳过版本号检查步骤

## 本地开发启动（dev server）——单实例铁律

- **单实例由应用自身强制**（`main.ts` 的 `app.requestSingleInstanceLock()`）：
  第二个进程会立即自行退出并把焦点还给已有实例（锁按 userData 目录隔离，
  `-p` 便携目录不同的实例仍可并存）。这意味着手动 `electron .`、dev watcher
  重启、误双击都不可能再产生并行实例——看到进程数 >1 才是异常。
  2026-10-05 起，second-instance / macOS `open-file` 携带受支持文件
  （`.md` 等）时走 `openPathInRunningWindow`：复用现有窗口、经
  `open-cmd-file` IPC 让渲染层直接打开预览（不再新开整窗），这是
  文件关联秒开预览优化的关键路径；主进程 `createWindow` 也不再 await
  i18nInit（菜单/dock 等语言包就绪后再绑定）。
- 双实例的历史危害：共用 userData 的两个实例存储引擎互相覆盖，曾把用户配置
  的 AI provider 清空过。
- 启动机制要清楚：`npm run start` → `start:renderer` 里的 **concurrently 会同时
  派生「主进程 webpack --watch + electronmon」**。electronmon 的职责是保持一个
  应用实例运行、bundle 变了自动重启；其拉起的多余实例会被单实例锁拒绝。
- **dev 构建自带 CDP 调试端口**：`main.ts` 在 `!app.isPackaged` 时固定
  `remote-debugging-port=9222`（见 "Dev only" 注释块）。外部工具（AI 会话、
  调试脚本）直接连 `http://localhost:9222/json` 即可检查/驱动运行中的应用，
  **永远不需要为了调试再起第二个实例**。
- 修正主进程代码后要让应用重启：重建 bundle
  （`npx cross-env NODE_ENV=development TS_NODE_TRANSPILE_ONLY=true webpack --config ./.erb/configs/webpack.config.main.dev.ts`）
  并重启 electron 进程（杀掉后由 electronmon 复活，或手动重启）。
- 渲染层改动走 HMR，无需重启；改 main/preload 必须重启应用才生效。

## 打包规范

- **Windows 只打绿色版**：`tagspaces-win-x64-{version}.zip`。不打 NSIS 安装版（.exe）——`resources/builder.json` 的 `win.target` 已配置为 `["zip"]`，不要改回去。当前是调试迭代阶段，安装版浪费时间
- 分卷压缩使用 `split` 命令，命名格式为 `{filename}.00`, `{filename}.01` 等
- 分卷后必须验证 MD5 一致性

## UI 设计约定

- **挤占式布局优先**：任何持续存在的工作区域/面板（侧栏、抽屉、工作区）
  必须采用「persistent 抽屉 + 主内容让位边距」的挤占式布局（参照左侧位置
  管理器抽屉和右侧 AI 工作区：`MainPage.tsx` 的 main 元素按面板开合应用
  对应方向的 padding，带动画），**不要用悬浮遮挡式覆盖层**——遮挡会盖住
  主工具栏/文件区，且让用户无法边看边操作。
- 模态 Dialog 只用于短生命周期交互：确认框、小型表单、向导。长驻对话或
  工作内容（如 AI Agent 聊天）一律走挤占式面板。
- 面板宽度支持拖拽调整并持久化（localStorage），拖拽过程中实时通知布局
  重算（参照 `AiAgentDialog` + `AiAgentDialogContextProvider` 的实现）。

## 功能模块

### 全局搜索（Global Search）

**搜索不是全盘搜索**（Windows + Everything 除外），默认只搜已连接位置（Location）的索引。

**三种搜索范围（scope）** — `src/renderer/components/SearchOptions.ts`：
- `location`：当前位置；`folder`：当前文件夹；`global`：所有已连接位置
- 无当前位置时 scope 被强制为 `global`（`SearchAutocomplete.tsx`）

**搜索执行链** — `src/renderer/hooks/LocationIndexContextProvider.tsx`：
- `searchAllLocations()`（global）/ `searchLocationIndex()`（location/folder）
- Windows + Electron + `useEverythingSearch`（设置，默认开）→ 优先走 **Everything 通道**
- 其他情况走 `fallbackSearch*`：逐个 location 读 `.ts/tsi.json` 索引（无索引/过期则现走目录建索引），用 Fuse.js 匹配（`@tagspaces/tagspaces-search`）
- **零 location 时 fallback 搜不到任何东西**，会提示 `noLocationsForSearch`

**Everything 集成（Windows only，2026-09-25 起改用 es.exe）**：
- `src/main/everythingSdk.ts` — 抛弃 koffi/Everything64.dll，改为 spawn voidtools **es.exe**（官方 Everything 命令行工具）：es.exe 与运行中的 Everything 客户端走窗口消息 IPC，结果 `-export-tsv` 到临时文件（UTF-8，中文路径无乱码）。探测顺序：自定义路径 → Everything.exe 旁 es.exe（Everything.exe 经注册表 App Paths / Uninstall InstallLocation / Run 键 / 服务 ImagePath 定位，用 PowerShell 编码 UTF-8 避免中文安装路径乱码）→ 默认安装目录 → **自带 es.exe**（`resources/everything/es.exe`）。含 debug 日志环形缓冲、自动补齐逻辑（DB 未加载/IPC 不通时自动 `-startup` 拉起 Everything.exe 并轮询等 DB）。搜索串行队列 + 30s 可用性正缓存。
- `src/renderer/services/everythingSearch.ts` — TS.SearchQuery → Everything 查询语法转换、结果合并 location 索引元数据
- `src/main/mainEvents.ts` — IPC：`searchEverything` / `getEverythingDebugInfo` / `everythingEnsureRunning` / `installEverything`（非 Windows 平台全部返回 unavailable）
- **依赖自动补齐**：Everything.exe 未运行时自动 `-startup` 拉起并等 DB 加载；未安装时可通过诊断对话框 winget 安装
- **诊断界面**：`src/renderer/components/dialogs/EverythingDebugDialog.tsx`（设置 → 常规 → Everything 搜索旁的"Everything 诊断"按钮），1 秒轮询实时状态 + 测试搜索 + 实时日志
- Everything 不可用时静默回退索引搜索，并把原因通过 `everythingSearchUnavailable` 通知用户
- voidtools 官方安装包不带 es.exe，TagSpaces 自带一份 64 位副本（freeware）。ES 退出码：0=成功，8=找不到 Everything IPC（未运行）。

**索引格式**：`<location>/.ts/tsi.json`（主索引）+ `.ts/tsft.jsonl`（全文索引），详见 `CLAUDE.md` 的 Indexing & Search 章节

### Everything 搜索调试战报（2026-08-16，6.15.0→6.15.9）——历史记录（koffi 方案已移除）

> ⚠️ 以下战报来自旧的 **koffi + Everything64.dll** 实现（2026-09-25 已整体换为 es.exe，见上文新说明）。表格里的 koffi 具体坑（`lib.func()` 挂载、`koffi.out` 类型、`str16` 读不回数据等）只适用于已删除代码，**不要再按此调试**。IPC 常量（`EVERYTHING_WM_IPC=0x0400`/`IS_DB_LOADED=401`）和 UIPI 拦截知识对理解 es.exe 行为仍有参考价值。

**当年状态（2026-08-19 更新）：渲染层展示问题已修复，待 Windows 实机验证。** 详见 `REPORT-2026-08-19-everything-renderer.md`。

核心根因与修复（均已改代码）：
1. **无打开的 location 时 `RenderPerspective` 渲染 WelcomePanel/null，搜索结果永远不显示**（核心根因）→ `showWelcomePanel = !currentLocationId && !isSearchMode`
2. `GridCell.tsx` 两处崩溃：`gridCellLocation.isReadOnly` 无空值保护；早退 return 在 hooks 之前违反 rules of hooks → 已修
3. Everything 条目 `uuid/tags/extension` 为 undefined → 触发 `sortByExtension`/`sortByFirstTag` 崩溃（已实测复现）+ 框选失效 → `convertToFileSystemEntry` 数据加固（uuid: getUuid()、tags: []、目录 extension: ''）
4. 残留 `searchFilter` 会过滤光新搜索结果 → `setSearchQuery` 进入搜索模式时清除
5. 原战报排查点 2（isSearchMode 门控）和 3（enhance 返回 undefined）已核实**无问题**

已验证正常（用户 Windows 机器 6.15.9 实测日志）：`Query: "tagspace" (max 10)` → `Query returned 10/77 results` → `First result: path="C:/Users/..." name="TagSpaces" isFile=false size=-1`（文件夹 size=-1 正常）。查询、计数、路径/名称提取全部正确。

**今天修掉的 bug 清单（每个都是真实根因，勿回退）**：

| 症状 | 根因 | 修复 |
|---|---|---|
| dll not found | voidtools 安装包不含 SDK dll | `resources/everything/` 自带 dll + builder.json extraResources |
| Failed to load: Unexpected int64_t | `koffi.out('int64')` 非法，out() 只收指针/字符串 | `koffi.out(koffi.pointer('int64'))` |
| 找不到非标准路径的 Everything | exe 探测只有注册表 App Paths + C:\ 默认路径 | 加自定义路径（basename 校验）+ Uninstall/Run 注册表键 + WOW6432Node |
| auto-start 静默失败 | spawn 的 740 提权错误是异步 error 事件，try/catch 接不住 | 监听 error/spawn 事件 + `cmd /c start` fallback（可弹 UAC） |
| **DB 永远 not loaded（最大元凶）** | **koffi 的 `lib.func()` 不挂载到 lib 对象！原代码 `(lib as any).Everything_Xxx()` 全是 undefined() 调用，TypeError 被空 catch 吞成 false** | 所有函数引用存 `api` 对象（`everythingSdk.ts` loadLibrary） |
| 结果有计数无路径（10/77 但列不出） | `koffi.out('str16')` + 预填字符串读不回数据（该写法仅适用原型式 `_Out_ char *` 声明） | `out(pointer('uint16'))` + `Uint16Array` + Node `utf16le` 解码，超长自动扩容 |
| toast/日志不可复制 | `minireset.css` 的 `:not(input):not(textarea){user-select:none}` 命中每个元素，容器级覆盖无效 | 精确命中文字元素或 `'& *'` 子树覆盖（特异性 0,1,x > 0,0,2） |

**koffi 使用规范（血泪教训）**：
- `lib.func()` 返回值必须保存，**不会**挂到 lib 上（已在 mac 用 libSystem 实测验证）
- `koffi.out()` 只接受指针或字符串类型；标量输出必须 `koffi.pointer('int64')` 等
- Win32 `BOOL` 是 4 字节 int，声明用 `'int'` 不要用 `'bool'`（koffi bool 是 1 字节）
- 字符串输出缓冲：`koffi.out(koffi.pointer('uint16'))` + `Uint16Array` + `Buffer.from(buf.buffer,0,n*2).toString('utf16le')`
- 空 `catch {}` 是万恶之源，FFI 层所有 catch 必须记日志

**调试工具（都已内置在包里）**：设置 → 常规 → Everything 诊断：状态灯、自定义路径、测试搜索（直接列路径）、IPC 三段探针（window/sendMessage/dbLoaded，用 user32 裸调绕开 SDK dll）、实时日志（可复制）。IPC 常量来自官方 SDK `ipc/everything_ipc.h`：窗口类 `EVERYTHING_TASKBAR_NOTIFICATION`、`EVERYTHING_WM_IPC=WM_USER=0x0400`、`IS_DB_LOADED=401`。

**Everything 侧知识（官方 SDK 源码核实）**：`IsDBLoaded` 的 false 有三种不可区分的原因（没运行/索引中/UIPI 拦截）；DB 加载中查询**静默返回空**；运行时 DB 全在内存，`.db` 文件只在退出时写盘；Everything 以管理员运行而客户端不是时 IPC 被 UIPI 静默拦截（解法：取消管理员标记 + 启用 Everything 服务）。

**迭代流程教训**：改完代码先在本地能验证的层面验证（如 koffi 行为用 mac 系统库实测、CSS 修复用 Playwright 驱动真实 Chromium 断言），再打包；打包只出 zip 绿色版，约 4 分钟。

### 文件版本清理（File Version Cleanup）

在全局搜索模式下，工具栏提供"版本清理"按钮，用于识别和清理同系列文件的老旧版本。

**核心文件：**
- `src/renderer/utils/fileVersionGrouper.ts` — 版本检测和分组纯函数，识别 `-v1`、`_v2`、`(v3)` 等版本后缀
- `src/renderer/components/dialogs/FileVersionCleanupDialog.tsx` — 版本清理对话框 UI
- `src/renderer/components/dialogs/hooks/FileVersionCleanupDialogContextProvider.tsx` — Dialog Context
- `tests/unit/fileVersionGrouper.test.js` — 单元测试

**使用流程：**
1. 全局搜索文件（如 .docx / .pptx）
2. 选中要清理的文件
3. 点击工具栏 🧹 版本清理按钮（无选中时隐藏）
4. 确认每组的保留/删除标记后，**逐组点击"确认清理此文件的旧版本"**执行（无全局一键执行）

**版本号识别规则（2026-08-19 收紧，防误报）：**
- 正则：`[-_\s(](v)?(\d+(?:\.\d+)*)[-_\s)]?$`（匹配 `-v1`、`_v2`、` v3`、`(v1)`、`-V1.2` 及裸数字 `-2`）
- 文件类型白名单：仅 MS Office（doc/docx/xls/xlsx/ppt/pptx）+ WPS（wps/et/dps）+ ODF（odt/ods/odp）
- 基础名加权长度 ≥ 12（CJK 字符算 2，即 ≥6 汉字或 ≥12 ASCII）
- 无 `v` 前缀时排除：前导零（`0001` 序号）、4 位年份（19xx/20xx，防"年度报告-2024"误删）
- 处置护栏：逐组确认才执行；组内至少保留 1 个；移动保留文件为 checkbox 且默认关闭

> 完整审查与修复记录见 [`TODO-file-version-cleanup-review.md`](TODO-file-version-cleanup-review.md)（含遗留 P2 项）。

### AI Agent（工具调用助手）

**设计文档**：[`DESIGN-ai-agent.md`](DESIGN-ai-agent.md)。基于现有 AI 基础设施（`ChatProvider` / `AiClient` / `OpenAIClient`，全部在渲染层）扩展的轻量 tool-calling agent，**零新依赖**。

**使用**：两个入口 —— ① 主工具栏右侧的 **AI Agent 按钮**（🤖 图标，右侧 Drawer，内含唯一对话面板 `AgentPanel`：会话列表、工具调用卡片、模型选择、导出 md/html、prompt 历史）；② 打开文件夹后 EntryContainer 的 AI Tab（`ChatView`，仅供文件侧栏使用）。所有对话都走工具循环，工具步骤以可折叠卡片（🔧 name(args) → 结果）展示。Provider 需为 OpenAI 兼容引擎（Kimi/DeepSeek/火山方舟/内网网关均已加入 `aiPresets.ts` 预设），API Key 在设置 → AI 的每个引擎卡片内填写。

**单对话入口（2026-10-04 合并）**：AI 弹窗原 `chat`/`agent` 两个 tab 已合并 —— `AiAgentDialog` 默认且仅渲染 `AgentPanel`；系统提示词统一走 `agentPrompt.ts` 的共享 `buildAgentSystemPrompt`（ChatProvider 内的重复版本已删除）；`ChatProvider.agentMode`/`setAgentMode`（localStorage `tsAiAgentMode`）为死代码已删除，`ChatView` 直接调 `newAgentMessage`。

**AI 技能与工具页面（2026-10-02 起"挤占式"）**：`AiCapabilitiesPanel.tsx`（浏览/搜索工具与技能、开关内置工具、自定义 HTTP 工具与 prompt 技能）不再是从 AI 弹窗里弹出的嵌套 Dialog，而是遵循通用"挤占式"原则——`AiCapabilitiesContextProvider`（isAiCapabilitiesOpen + toggleAiCapabilities）由 `RenderPerspective` 在内容区渲染面板替代文件夹内容。入口：AI Agent 弹窗右上角扩展按钮（Extension 图标，点击后关闭 AI 弹窗并打开内容区面板）、面板右上角 ✕ 关闭。旧 `AiCapabilitiesDialog.tsx` 已删除。

**核心文件**：
- `src/renderer/components/chat/AgentService.ts` — `runAgent()` 工具循环（maxSteps=8、流式 delta、tool_calls 增量拼装、abort、错误转 tool 结果）
- `src/renderer/components/chat/AgentTools.ts` — `createAgentTools(deps)` 工厂：search_files / list_folder / get_entry_tags / add_tags / remove_tags / read_file_text（结果有截断护栏）
- `src/renderer/components/chat/OpenAIClient.ts` — `chatOpenAICompletion()` 返回 `{ content, toolCalls }`（流式/非流式均支持 tool_calls）
- `src/renderer/hooks/LocationIndexContextProvider.tsx` — `agentSearch()`：无 UI 副作用的搜索（不写 redux、不弹通知），直接返回结果

**护栏（勿回退）**：不提供删除工具；move_file 目标已存在时不覆盖；打标签可逆；搜索 ≤50 条、文件读取 ≤20000 字符且限 2MB 文本类型；工具异常以 `{error}` 回传模型而非中断；系统提示词要求模型不得编造文件路径。

**模型供给决策（2026-09-28）**：内网网关（OpenAI 兼容）为**唯一通道**，本地 Ollama 冻结——`OllamaClient.ts` 保留不删但不再投入，离线 AI 场景放弃。分层汇总等高调用量功能全部走网关计费，增量缓存为硬性要求。

**分层汇总（2026-10-01 落地，详见 `DESIGN-office-ai-workflow.md` §7）**：
map-reduce 三级金字塔（文件→子文件夹→父文件夹，向上只汇总描述不碰原文）。
增量缓存硬性要求（网关计费）：`agentDescription.ts` 的 `isSummaryStale()`
按「AI 摘要块日期 vs entry.lmdt」判定过期，`list_folder`/`get_description`
输出 `summaryStale`，跳过条件 = `hasAiSummary && !summaryStale`；
`待总结`/`已总结` 标签驱动进度（用现有 add_tags/remove_tags）；
超大 folder（list_folder 截断）→ 完整汇总写独立笔记（write_deliverable），
description 只放精华。单测 `tests/unit/agentDescription.test.js`。

**后续新增（均已落地，详见 `TODO-ai-capabilities.md` 与 `DESIGN-ai-agent.md` §7）**：`set_description`（人工内容保护）、`move_file`（分拣归档）、`write_deliverable`（.md/.txt 文档产出，含文本回复/文件两种目标模式，不覆盖人写文件）；`search_files` 支持 tscmd 风格操作符（`+tag`/`-tag`/`|tag`/`--type`）；约定文件注入 `locationConventions.ts`（location 根 `CLAUDE.md`/`AGENTS.md` → system prompt）；`list_folder` recursive + 携带描述、`get_description`（分层汇总前置）。设置页「保存并验证」含 tool-calling 能力探测（`checkAgentSupport`，不支持时 warning 提示）。

**联网搜索三工具（2026-10-06 移植自 novelist-app）**：`web_search`（搜网页返标题/URL/摘要，快）、`fetch_web`（抓单页正文，默认 ≤6000 字）、`deepseek_search`（DeepSeek 网页自带联网的深度搜索，综合多来源出结论+引用，慢 10-45s）。
- `web_search`/`fetch_web` 走**本机 open-websearch 服务**（MCP，`http://127.0.0.1:3000/mcp`）：主进程 `src/main/openWebSearch.ts` 是 MCP 客户端（novelist `webSearch.cjs` 的 TS 翻译：SSE + mcp-session-id 会话、引擎白名单 `KNOWN_ENGINES`（默认 `[bing,baidu,juejin]`）、连接错误自动拉起 daemon（`OPEN_WEBSEARCH_SCRIPT` env 可覆盖，默认 `~/Claude/openWebSearch/scripts/start-daemon.sh`）、fetch 先 request 后浏览器兜底 + 反爬页断言）。IPC：`webSearch`/`fetchWeb`（mainEvents 注册，preload Channels 已加），渲染层 `AgentTools.ts` 工具调 IPC。单测 `tests/unit/openWebSearch.test.js`。
- `deepseek_search` 走 DeepSeek 网页会话（**需 AI 弹窗 DeepSeek 标签打开且已登录**）：渲染层 AgentTools 内实现，复用 `deepseek-web-drive` IPC（create-session/challenge/completion with `search_enabled:true`）+ `deepseekPow.ts`（`buildDeepseekPowResponse` + `parseDeepseekStream`）；模块级串行队列 + 会话状态（parent_message_id 链式，必须串行）+ 45s 超时；webview 未打开时返回友好错误。
- 护栏：fetch 内容截断 ≤6000 字；引擎白名单过滤；工具错误回传模型不中断；system prompt 引导联网工具并禁止编造 URL。

**文件夹整理四工具（2026-10-06 移植自开源 [moli-xia/desktop-cleaner](https://github.com/moli-xia/desktop-cleaner)（MIT）的 cleaner_core 逻辑）**：`organize_preview`（只读分类预览：按扩展名把目录直接子项分到目标子文件夹，报告跳过项及原因）、`organize_apply`（执行移动：自动建分类文件夹、绝不覆盖、写历史记录）、`organize_undo`（按记录恢复：指纹校验文件未变才恢复、原路径被占用时改 "name (1).ext" 保留两份）、`organize_history`（列记录）。
- 规则引擎：`src/renderer/utils/fileOrganizer.ts`（纯函数、无 electron 依赖、可单测）。默认分类 Documents/Images/Videos/Audio/Archives/Apps/Other + `__FOLDER__` 文件夹分类；扩展名小写化/复合（`.tar.gz`）/最长后缀优先；`excludedExtensions`（默认 `.lnk`/`.url`）、`maxFileSizeMb`（默认 100MB）、`includeFolders`；跳过系统/隐藏项（`.` 开头、desktop.ini、thumbs.db）、符号链接、已有分类文件夹、默认保留普通文件夹；`validateMovePlan` 拒绝路径逃逸/非直接子项/目标层级错误。`config` 参数可完全自定义（空扩展名分类为兜底、必须有 `__FOLDER__` 分类，校验对齐原项目）。
- 历史记录：`src/renderer/utils/organizeHistory.ts`（localStorage `tsOrganizeHistory`，最多 20 条），每条含 root/config/日期/逐项 {original, moved, category, fingerprint, state}。
- 移动实现：`AgentToolDeps.moveToPath(sourcePath, targetPath)`（ChatProvider 用 `moveFilesPromise` 精确目标移动：自动创建目标父目录、目标已存在即拒绝），比 `moveFile`（只能按原文件名移入文件夹）多出"改名保留两份"能力，供 undo 使用。
- 流程护栏（system prompt 引导）：先 `organize_preview` 展示分类去向并**征得用户同意**再 `organize_apply`；可只整理部分；误整理用 `organize_undo`。与 disk-organize 的下一轮"收件箱自动归类"衔接（`list_folder` Downloads → 依规则 `organize_apply`）。单测 `tests/unit/fileOrganizer.test.js`。

**已知限制**：自签名证书的内网网关会被渲染层 Chromium 网络栈拒绝（需装企业 CA 或后续加主进程代理）；`/v1/models` 列表不可用的端点（如方舟套餐）需在设置里手动添加模型。CORS 已解决：主进程窗口 `webSecurity: false`（main.ts），因为方舟等网关的 CORS 预检不放行 `Authorization` 且 Electron webRequest 拦不到预检，聊天/Agent/验证直连才能通（2026-09-27，已在真实应用内实测 200）。

**内置技能 `disk-organize`（2026-10-03 落地）**：面向新用户的全局初始化——先一次性访谈（≤3 轮问完职业画像/频繁任务/领域隔离/现有目录习惯/同步需求）→ `init_scan` 定向扫描磁盘 → `write_deliverable` 出《归类方案》+ `write_knowledge_entry` 存收件箱归类映射规则 → 用户批准后 `create_location` 实施。收件箱默认建议复用系统 Downloads，**必须在方案阶段交给用户确认**。幂等：localStorage `tsDiskInitState`（`finish_disk_init` 工具写标记），未执行过时 AgentPanel 持续展示引导卡片与 CTA。隐私：只读、不上传、跳过敏感目录（.ssh/钥匙串/浏览器数据/聊天记录等）。
- `src/main/diskScanner.ts` — 跨平台定向扫描纯逻辑（无 electron 依赖，可单测）：macOS 走 fs 递归（限深度、跳过系统/敏感目录、容忍 EPERM/EACCES）；**Windows 分支留空占位**（返回 error，Everything 集成待补）。护栏：目录 ≤50、扩展名 Top 20、超时截断
- `src/renderer/components/chat/AgentTools.ts` — `init_scan`（调 `initScan` IPC）/ `create_location`（复用 `useCurrentLocationContext.addLocation`，路径已存在拒绝）/ `finish_disk_init`
- `src/main/mainEvents.ts` — `ipcMain.handle('initScan', ...)`；`preload.ts` 的 `Channels` 加 `'initScan'`
- `agentPrompt.ts` — `DISK_ORGANIZE_SKILL` 指令块（一次性访谈清单 + 流水线 + 收件箱需确认 + 隐私声明 + 幂等声明）
- `tests/unit/diskScanner.test.js` — 聚合/黑名单跳过/截断护栏/profile→扩展名映射
- **收件箱每日自动归类闭环（2026-10-06 已实现）**：`mark_inbox_organized` 工具（确定性完成钩子，`src/renderer/utils/inboxOrganize.ts` 存每收件箱"上次整理时间"标记，localStorage `tsInboxLastOrganized`）+ AgentPanel 每日提醒卡片（disk-init 完成后，列出每个收件箱里 `lmdt` 晚于上次标记的新文件数与「整理收件箱」按钮，按钮用 `handleSend` 播种每日 pass 指令）+ 提示词把 inbox 引导收紧为「每日 inbox pass」流程（read_disk_init → list_folder → 依规则 move_file（copy 模式 keepSource）→ 无规则命中用 organize_preview/apply 类型归档兜底 → 打标签 → write_knowledge_entry 写整理记录 → mark_inbox_organized）。单测 `tests/unit/inboxOrganize.test.js` + organizeTools 集成用例。

### 待办（Todo）

个人轻量待办清单，展示"还有哪些代办要做"。**入口（2026-10-02 起为"挤占式"）**：主工具栏 Checklist 按钮（带未完成数 Badge，打开时图标高亮）→ 点击后**中间原显示文件夹内容的区域切换为待办面板**（`RenderPerspective` 里 `isTodoOpen` 时渲染 `TodoListPanel` 替代内容），**再次点击按钮隐藏、恢复文件夹内容**。面板内：状态 tabs / 搜索 / 排序 / 勾选完成 / 标记进行中 / 编辑 / 删除 / 导出 Markdown；新建/编辑表单（`TodoEditDialog`）和删除确认仍用弹窗。

**存储（2026-10-01 落地）**：无数据库引擎、无新依赖——与 `.ts/tsi.json` 同款哲学，主进程 `TodoDatabase`（内存主副本 + 校验 + 原子写 tmp→rename + 10 份轮转备份 + 损坏自动回滚到 `.bak.*`）。数据文件 `app.getPath('userData')/todo/todos.json`（不污染 git 仓库）。

**核心文件**：
- `src/main/todoStore.ts` — `TodoDatabase` 纯逻辑（无 electron 依赖，可单测）：校验 / list 筛选排序 / 生命周期（done 写 completedAt、恢复清空）/ `renderTodosMarkdown`（`[ ]`/`[~]`/`[x]` 语法，与仓库 TODO-*.md 一致）
- `src/main/todoStoreIpc.ts` — `initTodoStore()`：组装 userData 路径 + 注册 `todo:list/create/update/remove/exportMarkdown/getPath` 六个 `ipcMain.handle`
- `src/renderer/components/todo/` — `TodoListPanel`（挤占式 inline 面板，数据经 props 从 ContextProvider 传入，保持 import 图无环；由 `RenderPerspective.tsx` 在 `isTodoOpen` 时渲染）/ `TodoEditDialog`（标题/说明/状态/优先级/标签/项目/截止日期+时间/循环）/ `TodoItem` / `todoService.ts`（类型化 invoke 封装）/ `todoUtils.ts`（筛选排序纯函数）
- `src/renderer/components/RenderPerspective.tsx` — 内容区组件，`isTodoOpen` 时返回 `TodoListPanel` 替代 perspective 内容
- `tests/unit/todoStore.test.js` — 20 例（校验/排序/原子写/备份/损坏恢复/md 渲染）

**挂载链**：`main.ts:34` 已 import `mainEvents`，`loadMainEvents()` 开头调 `initTodoStore()`——**不碰 main.ts**。IPC 通道名加在 `preload.ts` 的 `Channels` 联合类型。

**AI Agent 工具（2026-10-02 落地）**：`src/renderer/components/chat/AgentTools.ts` 新增 4 个待办工具（走 `todoApi` IPC，web 端无 electronIO 时返回不可用提示）：`todo_list`（列表 + stats，≤50 条护栏）、`todo_create`（title 必填，可选 priority/tags/project/dueDate/description）、`todo_complete`（按 id 标记 done）、`todo_update_status`（open/doing/done）。异常一律 `{ error }` 回传模型。

**数据模型预留**：`parentId` / `estimateMinutes` 字段已入 schema（v1 不暴露 UI），将来上子任务/估时免迁移。二期方向：TODO-*.md 导入（勾选回写）、`reminderAt` 到期系统通知。

### Pro 功能隐藏（2026-10-02 落地）

**背景**：本仓库不含 `@tagspacespro/tagspacespro` 模块（`src/renderer/pro/index.ts` 里 `Pro` 恒为 undefined，Pro 功能全部不可用）。为避免向用户暴露一堆置灰的 Pro 控件 / 升级广告，把所有 Pro 相关 UI 从操作入口层面清除，同时**保留 `hideProFeatures` 机制本身作为内置开关**（默认开启）。

**内置开关**：
- `src/renderer/reducers/settings-default.ts` — `hideProFeatures: true`
- `src/renderer/reducers/settings.ts` — `isHideProFeatures` selector **恒返回 true**（不再读持久化的 `state.settings.hideProFeatures`，防止 redux-persist 恢复旧值 `false` 覆盖默认）。仅 `AppConfig.ExtHideProFeatures`（ext config）可显式覆盖为 false。
- 设置界面里原来的「隐藏 Pro 功能」开关项已删除，但 reducer 的 `setHideProFeatures` action 保留（无 UI 触发，无害）。

**清除的界面入口**：
- 设置对话框：`SettingsGeneral.tsx` 移除 5 项 Pro 设置项（自动保存描述 / 文件版本 / 从位置读取标签 / 工作区 / 隐藏 Pro 功能开关）；`SettingsDialog.tsx` 移除整个「文件模板」tab（`SettingsTab.Templates` 已从 enum 删除，`SettingsTemplates.tsx` 变为无引用的死代码，保留未删）
- `AboutDialog.tsx`：移除「升级到 Pro」按钮、PRO/LITE 徽标、产品名 Pro 后缀
- `HelpFeedbackPanel.tsx`：移除「achieve more · TagSpaces Pro」菜单项、恢复购买/取消订阅项
- `SearchMenu.tsx`：移除「导出/导入保存的搜索」（Pro 项）
- `CustomLogo.tsx`：移除顶栏 `LITE` 标签
- `MobileNavigation.tsx`：移除移动端底部 `ProTeaser` 广告横幅

**未走门控的 Pro 控件补齐隐藏**（沿用 `!hideProFeatures &&` 或 `Pro &&` 条件）：
- `EntryProperties.tsx`：背景色/调色板/缩略图/背景图按钮
- `CreateEditLocationDialog.tsx`：工作区、失焦重载、只读模式、监听变更、禁用索引
- `CreateTagGroupDialog.tsx` / `EditTagGroupDialog.tsx`：标签组位置、工作区字段
- `ExportImportPanel.tsx`：「保存的搜索」备份区（`renderSection` 开头 `hideProFeatures && sectionIsPro('searches')` 直接 return null）
- `LinksTab.tsx`：链接图按钮（`LinksGraph` 不存在时隐藏）
- `CreateFile.tsx`：模板管理按钮（模板 tab 已删，按钮随之移除；`NewFileDialog` 不再传 `onClose` 给 `CreateFile`）
- `TagLibraryMenu.tsx`：「从位置刷新标签组」
- `EntryContainerButtons.tsx`：自动保存开关
- `StoredSearches.tsx`：书签区块（`showBookmarksSection = Pro && …`）
- `AiGenDescButton.tsx` / `AiGenTagsButton.tsx`：Lite 下整体 `return null`（AI 生成按钮）
- `MainToolbar.tsx`：主工具栏 AI 生成按钮（点击会弹 Pro 升级提示）

**保留未删（无入口即不可达）**：`BuyProDialog.tsx` / `ProTeaserDialog.tsx` / `ProTeaser.tsx` / `ProTeaserSlides.tsx` / `services/iap.ts` 及它们的 Context Provider 仍挂载在 `DialogsRoot.tsx`，但所有打开入口已清除，永远不会显示——保留以避免 import 图断裂，便于未来恢复。

**注意事项**：受影响的 e2e 测试（`changeThumbnailTID`、`saveTagInLocationTID`、`templatesDialogTID` 等）均带 `_pro` 平台标签，只在 Pro 构建下运行，本部署不跑，故未改动。

### 打包注意事项（2026-09-25 起：无原生依赖）

- koffi 及其 `install-koffi-*` 步骤已全部移除（package.json 脚本、`scripts/install-koffi-platform.js`、CI 校验）。
- Everything 集成靠自带 **`resources/everything/es.exe`**（64 位 freeware；通过 `resources/builder.json` extraResources 打进包内，运行时在 `process.resourcesPath/everything/es.exe`）。非 x64 机器没有自带 es.exe 时，回退用 Everything 安装目录旁的 es.exe。
- 若新增其他带原生模块的依赖（如 wasm-vips 之类），需确保目标平台的原生二进制被打入包内。
