# Agent Instructions for TagSpaces

## 通用要求

- **思考过程和讨论交流一律使用中文**（包括内部分析、计划、解释和总结）。代码、注释、commit message、i18n 英文文案仍用英文。

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

**使用**：两个入口 —— ① 主工具栏右侧的 **AI Agent 按钮**（🤖 图标，弹窗内含完整聊天）；② 打开文件夹后 EntryContainer 的 AI Tab。两处都有 **Agent** 开关（localStorage `tsAiAgentMode`）。开启后消息走工具循环，工具步骤以 `🔧 name(args) → 结果` 流入聊天 markdown。Provider 需为 OpenAI 兼容引擎（Kimi/DeepSeek/火山方舟/内网网关均已加入 `aiPresets.ts` 预设），API Key 在设置 → AI 的每个引擎卡片内填写。

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

**已知限制**：自签名证书的内网网关会被渲染层 Chromium 网络栈拒绝（需装企业 CA 或后续加主进程代理）；`/v1/models` 列表不可用的端点（如方舟套餐）需在设置里手动添加模型。CORS 已解决：主进程窗口 `webSecurity: false`（main.ts），因为方舟等网关的 CORS 预检不放行 `Authorization` 且 Electron webRequest 拦不到预检，聊天/Agent/验证直连才能通（2026-09-27，已在真实应用内实测 200）。

### 待办（Todo）

个人轻量待办清单，展示"还有哪些代办要做"。**入口**：主工具栏 Checklist 按钮（带未完成数 Badge）→ 弹窗（状态 tabs / 搜索 / 排序 / 勾选完成 / 标记进行中 / 编辑 / 删除 / 导出 Markdown）。

**存储（2026-10-01 落地）**：无数据库引擎、无新依赖——与 `.ts/tsi.json` 同款哲学，主进程 `TodoDatabase`（内存主副本 + 校验 + 原子写 tmp→rename + 10 份轮转备份 + 损坏自动回滚到 `.bak.*`）。数据文件 `app.getPath('userData')/todo/todos.json`（不污染 git 仓库）。

**核心文件**：
- `src/main/todoStore.ts` — `TodoDatabase` 纯逻辑（无 electron 依赖，可单测）：校验 / list 筛选排序 / 生命周期（done 写 completedAt、恢复清空）/ `renderTodosMarkdown`（`[ ]`/`[~]`/`[x]` 语法，与仓库 TODO-*.md 一致）
- `src/main/todoStoreIpc.ts` — `initTodoStore()`：组装 userData 路径 + 注册 `todo:list/create/update/remove/exportMarkdown/getPath` 六个 `ipcMain.handle`
- `src/renderer/components/todo/` — `TodoListDialog`（数据经 props 从 ContextProvider 传入，照 FileVersionCleanup 模式保持 import 图无环）/ `TodoEditDialog`（标题/说明/状态/优先级/标签/项目/截止日期+时间/循环）/ `TodoItem` / `todoService.ts`（类型化 invoke 封装）/ `todoUtils.ts`（筛选排序纯函数）
- `tests/unit/todoStore.test.js` — 20 例（校验/排序/原子写/备份/损坏恢复/md 渲染）

**挂载链**：`main.ts:34` 已 import `mainEvents`，`loadMainEvents()` 开头调 `initTodoStore()`——**不碰 main.ts**。IPC 通道名加在 `preload.ts` 的 `Channels` 联合类型。

**数据模型预留**：`parentId` / `estimateMinutes` 字段已入 schema（v1 不暴露 UI），将来上子任务/估时免迁移。二期方向：TODO-*.md 导入（勾选回写）、`reminderAt` 到期系统通知。

### 打包注意事项（2026-09-25 起：无原生依赖）

- koffi 及其 `install-koffi-*` 步骤已全部移除（package.json 脚本、`scripts/install-koffi-platform.js`、CI 校验）。
- Everything 集成靠自带 **`resources/everything/es.exe`**（64 位 freeware；通过 `resources/builder.json` extraResources 打进包内，运行时在 `process.resourcesPath/everything/es.exe`）。非 x64 机器没有自带 es.exe 时，回退用 Everything 安装目录旁的 es.exe。
- 若新增其他带原生模块的依赖（如 wasm-vips 之类），需确保目标平台的原生二进制被打入包内。
