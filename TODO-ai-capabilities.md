# TODO：AI 能力建设路线（后续目标）

> 创建：2026-09-27；重排：2026-09-28；追加：2026-10-06
> 场景目标态：`DESIGN-office-ai-workflow.md`（办公场景 AI 工作流）
> 背景：AI Agent 基础集成已合入（commit `77b056732`）。本文档记录与官方
> （tagspaces.org）AI 路线对比后的差距分析，以及后续建设目标。
> 参考：`DESIGN-ai-agent.md`（Agent 基础设计）、官方 6.11 博客、tscmd 博客、
> 官方 Claude Code second-brain 教程。

## 当前状态与接下来（2026-10-06 续接点）

**本次会话已落地**（详见文末"已完成"）：联网搜索三工具（web_search /
fetch_web / deepseek_search）、desktop-cleaner 文件夹整理四工具
（organize_preview / apply / undo / history）、收件箱每日自动归类闭环
（mark_inbox_organized + AgentPanel 每日提醒卡片）。全部通过
`tsc --noEmit` + 全量单测 551 例 + `build:renderer`。

**剩余待办（按建议顺序续）**：
1. **薄 MCP server**（Phase 6-③）——总路线收口，把 AgentTools 包成
   MCP stdio server，外部 agent 复用同一套文件体系；
2. **xlsx 任务表产出**（Phase 2 `create_spreadsheet`）——补齐"办公三动作"
   最后一环（分拣✅ 任务表 汇总✅）；
3. **Phase 1 验收①：方舟端到端工具链验证**（search_files→add_tags 实机）；
4. **Phase 3 分层汇总实机验收**（3 层嵌套 + 50+ 文档首跑/增量跑、核对调用次数）；
5. **Phase 6 会话持久化迁移**（tsAiAgentSessions → `.ts/ai/agent.json`）、
   **tscmd CLI 评估**；
6. **Phase 7 工作流学习与自动化技能**（P0 应用内最小闭环 → P1 外部网页
   playwright sidecar → P2 自愈）。

## 已定决策（2026-09-28 讨论结论）

- **定位**：企业内部个人办公能力赋能，单用户，不做团队协同；基于 TagSpaces
  二次开发。官网场景中主攻「AI 第二大脑」+ 办公文档流；不投团队自托管/S3、
  剪藏、照片、电子书、素材管理。
- **模型供给**：内网网关（OpenAI 兼容）为**唯一通道**，放弃本地 Ollama。
  `OllamaClient.ts` 保留不删（避免上游合并冲突）但冻结投入；离线 AI 场景
  明确放弃。tool-calling 能力探测因此成为硬门槛（见 Phase 1-②）。
- **AI 双线**：内置 AI 能力与 Agent 基础设施并行建设。
- **MCP**：采用薄层方案——把现有 AgentTools 包成 MCP stdio server，不做
  CLI+MCP 双形态；官方厚的做出来后再评估切换。
- **明确不做**：向量化/embedding（官方亦不上，全文索引 + 标签操作符够用
  之前保持克制）；一切协同能力。
- 总路线：**办公三动作（分拣✅→任务表→汇总）做穿 → 检索表达力✅ →
  MCP 收口基础设施**。

## 状态图例

- [ ] 未开始
- [~] 进行中 / 部分完成
- [x] 完成

## Phase 1 — P0 验收欠账

- [ ] **验收①：方舟端到端工具链验证**
      在方舟（glm-5.3-flash）上完整跑一遍设计验收用例：
      "帮我找出当前文件夹里所有 pdf 并打上 invoice 标签"，
      确认 `search_files` → `add_tags` 工具链触发且 UI 可见步骤。
- [x] **验收②：tool-calling 能力探测接入 UI**
      `checkAgentSupport` 已接入「保存并验证」：OpenAI 兼容端点验证通过后
      追加 tool-calling 探测，不支持时 warning 明确提示（不阻断保存，
      i18n key `aiAgentUnsupported`）。
- [x] **验收③：`npm run build:renderer` 全量构建通过**
      2026-10-01 生产构建通过（tsc --noEmit + 单测 456 全过）。

## Phase 2 — 任务表产出（原 P1 #2）

> 2026-09-28 起 xlsx 生成**推迟**：先落地了目标驱动的 .md 文档产出
> （`write_deliverable`，`9526dfaa0`..`095a2b5e7`，含文本回复/文件两种
> 目标模式），已覆盖"报告/方案/周报"类产出。xlsx 任务表待真实场景需要时
> 再做（选型不变：零依赖手写 xlsx，CSV 兜底）。

- [ ] **xlsx 生成**（`create_spreadsheet` 工具）
      agent 从需求文档提取待办生成 Excel 任务表落盘到 `任务/`（列：
      序号/事项/负责人/截止日期/状态，列结构可由约定文件覆盖）。
      选型：优先零依赖手写 xlsx（zip+XML，复用 fflate）；CSV 兜底。
      护栏：生成失败不阻塞分拣；目标已存在不覆盖。
      验收：真实需求 docx → xlsx 能被 Excel/WPS 正常打开。

## Phase 3 — 文件夹分层汇总（原 P1 #10）

正式设计见 `DESIGN-office-ai-workflow.md` §7（map-reduce 三级金字塔 +
增量缓存；增量缓存为硬性要求——全部调用走网关计费）。

- [x] 前置：recursive `list_folder`、`get_description`（`e61dcd463`）
- [x] 前置：`list_folder` 结果携带描述（`1454bf51e`）
- [x] **分层汇总主体**：系统提示词引导（总结→写 description；文件夹汇总
      →先子后父；超大 folder→独立笔记+精华进 description）+ 增量缓存
      （AI 摘要标记 + `isSummaryStale` 按 lmdt/摘要日期判定过期 +
      `待总结`/`已总结` 标签驱动；`list_folder`/`get_description` 输出
      `summaryStale` 字段）。单测：`tests/unit/agentDescription.test.js`。
      验收：3 层嵌套、50+ Office 文档测试库，首跑+增量跑各一次，调用次数
      符合设计 §7.5 成本表（**待实机**）。

## Phase 4 — 检索表达力（原 P2）✅ 全部完成

- [x] **search_files 查询操作符**（`58c1cb887`）
      `+tag` 必须含 / `-tag` 排除 / `|tag` 同组 OR / `--type` 文件类型组
- [x] **中文全文搜索实测**（`2026981ef`，含 CJK 召回测试）
- [x] **文件夹级上下文隔离**（`e61dcd463`，folder-scan 默认策略：
      默认 folder scope，无果再升级）

## Phase 5 — 个性化（原 P3 前半）✅ 完成

- [x] **约定文件注入**（`9bf2bb979`，`locationConventions.ts`）
      agent 启动时读 location 根的约定文件（`CLAUDE.md` 或 `AGENTS.md`，
      上限 4000 字符），内容注入 system prompt：标签规范、目录结构约定、
      个性化指令。机制由应用提供，内容由用户维护。

## Phase 6 — 基础设施收口（原 P3 后半 + MCP 提前）

- [ ] **AgentPanel 会话持久化迁移**
      从 localStorage（`tsAiAgentSessions`）迁到 `.ts/ai/agent.json`
      （随文件夹走、可被外部工具读取，与官方 folder chat 的 `tsc.json`
      对齐）。需一次性迁移逻辑。
- [ ] **CLI 工具层评估（@tagspaces/shell）**
      官方 `tscmd`（MIT，`npm install -g @tagspaces/shell`）提供
      tag/describe/indexer/search/thumbgen/metacleaner。
      评估两个方向：
  - AgentTools 增加一个 `run_tscmd` 类工具，批量操作（数百文件打标签）
    走 CLI 而非逐条 IPC；
  - 或直接依赖其索引/搜索包，避免重复造轮子。
    注意：CLI 天然绕开渲染层架构限制（CORS/证书/内存索引），且幂等可脚本化。
- [ ] **薄 MCP server**
      把 AgentTools 的工具能力以 MCP stdio server 暴露（独立入口脚本，
      复用工具实现、零新框架依赖），让 Claude Code 等外部 agent 与应用内
      agent 操作同一套文件体系。
      验收：Claude Code 配置该 MCP 后，能用自然语言完成
      「给某文件夹 pdf 打标签」。

## Phase 7 — 工作流学习与自动化技能（学习 → 沉淀 → 回放）

> 2026-10-06 讨论定稿。目标：让内置 Agent 能"看会"用户带它做的操作流程，
> 沉淀为可回放的自动化技能——对齐本文件开头的长期目标（蒸馏重复流程），
> 并把 Agent 能力从"应用内文件操作"扩展到"外部网页/在线系统"。

### 已定决策

- **学习方式 = 演示式录制**，不做全量被动监听（隐私噪音大、无意义事件多）。
  用户带 Agent 把流程做一遍（每步复述确认），Agent 记录结构化轨迹后
  参数化（识别路径/标签/URL 等变量，向用户确认）。
- **执行 = 确定性回放**：技能保存为步骤 DSL，回放时逐步直接执行、不逐步
  问 LLM（快、省网关费用、结果可复现）；LLM 只在学习/保存时和回放失败
  自愈时介入。
- **操作分两层，语义层优先**：TagSpaces 内操作记语义级步骤（直接复用
  `AgentTools` 现有工具：`add_tags`/`move_file`/`search_files`…，UI 改版
  不受影响）；外部网页记 UI 级步骤（navigate/click/fill/snapshot/extract，
  基于无障碍树 role+name 定位，不用脆弱 CSS 选择器）。
- **外部网页驱动 = playwright-core sidecar**（纯 JS、无原生模块，符合
  "打包无原生依赖"红线）；`channel: 'msedge'` 直连 Windows 自带 Edge，
  不下载 Chromium；日常走 `--remote-debugging-port=9222` + `connectOverCDP`
  接管已登录会话（免登录是外部网页自动化的命门）。主进程挂载照
  `deepseek-web-drive` / `todoStoreIpc.ts` 惯例（mainEvents + preload Channels）。
- **护栏**：回放前 dry-run 展示步骤清单；`confirm: true` 的步骤逐个确认；
  全程写执行日志（供自愈与改进）；可逆操作优先、目标已存在不覆盖，
  沿用 `AgentTools.ts` 现有护栏哲学。

### 技能文件格式（存 `userData/skills/`，可选同步到 location `.ts/skills/` 跨机携带）

```json
{
  "id": "weekly-invoice-sort",
  "name": "每周发票归档",
  "params": [{ "name": "inboxDir", "default": "C:/Users/x/Downloads" }],
  "steps": [
    { "tool": "list_folder", "args": { "path": "{{inboxDir}}", "recursive": true } },
    { "tool": "browser_navigate", "args": { "url": "https://intraview.company/tax" } },
    { "tool": "browser_fill", "args": { "role": "textbox", "name": "发票号", "value": "{{invoiceNo}}" } },
    { "tool": "add_tags", "args": { "tag": "已报销" }, "confirm": true }
  ]
}
```

### 交付物

- [ ] **P0 最小闭环（纯应用内，不依赖 Playwright，mac 可开发验证）**
      `AgentTools.ts` 新增 `skill_record_start/stop`（捕获工具调用轨迹草稿）、
      `skill_save`（LLM 归纳为参数化 DSL，用户确认后落盘）、
      `skill_run`（dry-run + 逐步回放 + 执行日志）、`skill_list`；
      技能 DSL 校验与回放执行器写成纯逻辑模块（可单测，照 `todoStore.ts` 惯例）；
      `agentPrompt.ts` 增加 `LEARN-WORKFLOW` 元技能块（照
      `DISK_ORGANIZE_SKILL` 写法：访谈 → 演示 → 参数化 → 确认保存）。
      验收：带 Agent 演示一个应用内流程一遍 → 存为技能 → 一句话回放成功。
- [ ] **P1 打通外部网页（Windows 目标场景）**
      `src/main/webDrive.ts` sidecar（playwright-core + msedge channel +
      CDP 接管模式）+ `browser_*` 工具组（走 IPC）；
      i18n、AI 技能与工具页面（`AiCapabilitiesPanel`）列出技能。
      验收：一个真实内网网页流程（查数据 → 存回 TagSpaces 打标签）端到端跑通。
- [ ] **P2 自愈与优化**
      回放失败时把无障碍快照 + 错误喂给 LLM 重新定位元素并修订技能（修订
      需用户确认）；执行日志定期让 Agent 提出流程改进建议。

### 明确不做（本 Phase 内）

- 原生桌面客户端 UI 自动化（Playwright 管不了；PowerShell UIAutomation
  方向另行评估，不混入本期）

## 不做清单（防跑偏）

- Ollama 任何增强、离线 AI 场景（`OllamaClient.ts` 仅保留上游代码）
- 向量化 / embedding
- 团队协同、S3 / Pro Web 方向
- 网页剪藏、照片库、电子书、数字素材管理场景的投入

## 已完成（留档）

- [x] AI Agent 基础集成（`77b056732`）：Agent 循环、6 工具、AgentPanel、
      AiAgentDialog、多模型管理、验证体系
- [x] 内网连通性：CORS（webSecurity）+ 自签名证书（ignore-certificate-errors）
- [x] 启动自动预选模型；回复语言跟随用户消息
- [x] 帮助菜单/欢迎页噪声清理
- [x] Office 文档内容提取（`dcdfbd2ec`，officeTextExtractor + read_file_text）
- [x] set_description 工具（`e2b625d03`，人工内容保护见设计 §7.4）
- [x] move_file 工具（`efed0a6d1`，分拣归档）
- [x] write_text_file 工具（目标驱动的报告/文档产出；后更名为
      `write_deliverable`，并新增目标模式：文本回复 vs 文件产出，
      `9526dfaa0`..`095a2b5e7`）
- [x] 联网搜索三工具（2026-10-06，移植自 novelist-app）：`web_search` /
      `fetch_web` 走主进程 `src/main/openWebSearch.ts`（本机 open-websearch
      MCP 客户端，引擎白名单、daemon 自动拉起、fetch 先 request 后浏览器兜底
      + 反爬断言）；`deepseek_search` 渲染层复用 `deepseek-web-drive` IPC +
      `deepseekPow.ts`（需 DeepSeek 网页版登录）。IPC `webSearch`/`fetchWeb`
      （mainEvents + preload Channels）。单测 `tests/unit/openWebSearch.test.js`。
- [x] 文件夹整理四工具（2026-10-06，移植自开源 moli-xia/desktop-cleaner
      MIT）：`organize_preview` / `organize_apply` / `organize_undo` /
      `organize_history`。规则引擎 `src/renderer/utils/fileOrganizer.ts`
      （纯函数：扩展名分类/复合扩展名/最长后缀优先、跳过隐藏与系统项、
      绝不覆盖、`validateMovePlan` 防逃逸）；历史记录
      `src/renderer/utils/organizeHistory.ts`（localStorage）；移动走
      `AgentToolDeps.moveToPath`（ChatProvider/AgentPanel 用 moveFilesPromise
      精确目标移动，自动建目标目录、目标已存在即拒绝）。单测
      `tests/unit/fileOrganizer.test.js` + organizeTools 集成用例。
- [x] 收件箱每日自动归类闭环（2026-10-06，disk-organize 二期）：`mark_inbox_organized`
      工具 + `src/renderer/utils/inboxOrganize.ts`（每收件箱"上次整理时间"
      标记，localStorage `tsInboxLastOrganized`）+ AgentPanel 每日提醒卡片
      （有 `lmdt` 晚于标记的新文件时显示路径+数量与「整理收件箱」按钮，
      `handleSend` 播种每日 pass 指令）+ agentPrompt 收紧为「每日 inbox pass」
      流程（read_disk_init → list_folder → 依规则 move_file（copy 模式
      keepSource）→ 无规则命中用 organize_preview/apply 兜底 → 打标签 →
      write_knowledge_entry 写整理记录 → mark_inbox_organized）。单测
      `tests/unit/inboxOrganize.test.js` + organizeTools 集成用例。
