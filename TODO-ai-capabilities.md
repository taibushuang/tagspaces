# TODO：AI 能力建设路线（后续目标）

> 创建：2026-09-27；重排：2026-09-28
> 场景目标态：`DESIGN-office-ai-workflow.md`（办公场景 AI 工作流）
> 背景：AI Agent 基础集成已合入（commit `77b056732`）。本文档记录与官方
> （tagspaces.org）AI 路线对比后的差距分析，以及后续建设目标。
> 参考：`DESIGN-ai-agent.md`（Agent 基础设计）、官方 6.11 博客、tscmd 博客、
> 官方 Claude Code second-brain 教程。

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
- [ ] **验收②：tool-calling 能力探测接入 UI**
      `AgentService.checkAgentSupport` 已实现但闲置。把能力探测接进
      「保存并验证」按钮：探测请求带 tools，不支持函数调用的端点在验证时
      明确报错（设计验收标准 2），而不是等真正跑 agent 才失败。
      涉及 `src/renderer/components/dialogs/components/SettingsAI.tsx`。
- [ ] **验收③：`npm run build:renderer` 全量构建通过**
      此前只验证过 `tsc --noEmit`，生产构建未跑。

## Phase 2 — 任务表产出（原 P1 #2）

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
- [~] **分层汇总主体**：系统提示词引导（总结→写 description；文件夹汇总
      →先子后父；超大 folder→独立笔记+精华进 description）+ 增量缓存
      （AI 摘要标记 + 索引 size/mtime 判定 + `待总结`/`已总结` 标签驱动）。
      验收：3 层嵌套、50+ Office 文档测试库，首跑+增量跑各一次，调用次数
      符合设计 §7.5 成本表。

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
- [x] write_text_file 工具（目标驱动的报告/文档产出，进行中待提交）
