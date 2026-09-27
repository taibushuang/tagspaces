# TODO：AI 能力建设路线（后续目标）

> 创建：2026-09-27
> 场景目标态：`DESIGN-office-ai-workflow.md`（办公场景 AI 工作流，含工具差距清单）
> 背景：AI Agent 基础集成已合入（commit `77b056732`）。本文档记录与官方
> （tagspaces.org）AI 路线对比后的差距分析，以及后续建设目标。
> 参考：`DESIGN-ai-agent.md`（本期设计）、官方 6.11 博客、tscmd 博客、
> 官方 Claude Code second-brain 教程。

## 状态图例

- [ ] 未开始
- [~] 进行中 / 部分完成
- [x] 完成

## P0 — 设计验收收尾（本期欠账）

- [ ] **验收①：方舟端到端工具链验证**
  在方舟（glm-5.3-flash）上完整跑一遍设计验收用例：
  "帮我找出当前文件夹里所有 pdf 并打上 invoice 标签"，
  确认 `search_files` → `add_tags` 工具链触发且 UI 可见步骤。
- [ ] **验收②：tool-calling 能力探测接入 UI**
  `AgentService.checkAgentSupport` 已实现但闲置。把能力探测接进
  「保存并验证」按钮：探测请求带 tools，不支持函数调用的端点在验证时
  明确报错（设计验收标准 2），而不是等真正跑 agent 才失败。
- [ ] **验收③：`npm run build:renderer` 全量构建通过**
  本会话只验证过 `tsc --noEmit`，生产构建未跑。
- [ ] **设计文档更新**
  `DESIGN-ai-agent.md` 补录本期偏离与新增：AgentPanel（独立会话面板）、
  AiAgentDialog（Chat/Agent 双 Tab 入口）、多模型管理（customModels +
  ModelListEditor）、验证体系（Save & Verify / 发现探活）、CORS 与证书
  方案（webSecurity + ignore-certificate-errors，替代原"主进程代理"设想）。

## P1 — Agent 检索能力增强（对标官方 tscmd search）

官方 `tscmd search` 的查询语法表达力远超我们（详见官方 6.11 博客）。

- [ ] **search_files 查询操作符**
  给 `AgentTools.search_files` / `getSearchResults` 吸收官方语法：
  - `+tag` 必须含该标签
  - `-tag` 排除该标签
  - `|tag` 同组任一匹配（OR）
  - `--type images|documents|notes` 文件类型组过滤
  引擎同源（tagspaces-search），主要工作在查询解析层。
- [ ] **中文全文搜索实测**
  官方 6.11 重写 tokenizer 修复中日韩分词（按空格分词时代中文全文搜不到）。
  我们 fork 自 6.15.x 应已包含，但未实测：建一个含中文内容的测试 location，
  验证 `search_files` 对中文文件内容的召回质量。这是 agent 在中文文件
  上的检索质量基础。
- [ ] **文件夹级上下文隔离**
  官方思路："每个文件夹一个 RAG 语料库"。agent 收到提问时优先在
  当前文件夹 scope 内检索，避免拉入无关 location 的噪声。
  我们的 scope 机制已支持 folder，需要调整 agent 系统提示词的
  检索策略引导（默认 folder → 无果再升级 location/global）。

## P2 — Agent 个性化与可组合性（对标官方 CLAUDE.md 模式）

- [ ] **文件夹级约定文件（CLAUDE.md 模式）**
  agent 启动时读取当前 location / 文件夹根的约定文件（建议命名
  `AGENTS.md` 或沿用 `CLAUDE.md`），内容注入 system prompt：
  - 标签规范（"优先用已有标签，新增标签需明说"）
  - 目录结构约定
  - 用户的个性化指令
  机制由应用提供，内容由用户维护——个性化规范不再写死在代码里。
- [ ] **CLI 工具层评估（@tagspaces/shell）**
  官方 `tscmd`（MIT，`npm install -g @tagspaces/shell`）提供
  tag/describe/indexer/search/thumbgen/metacleaner。
  评估两个方向：
  - AgentTools 增加一个 `run_tscmd` 类工具，批量操作（数百文件打标签）
    走 CLI 而非逐条 IPC；
  - 或直接依赖其索引/搜索包，避免重复造轮子。
  注意：CLI 天然绕开渲染层架构限制（CORS/证书/内存索引），且幂等可脚本化。
- [ ] **AgentPanel 会话持久化决策**
  当前 agent 会话存 localStorage（`tsAiAgentSessions`），与设计文档的
  `.ts/ai/` 文件夹元数据路线不一致（多设备不同步）。需要决策：
  保持 localStorage（轻量）还是迁移到 `.ts/ai/agent.json`（随文件夹走、
  可被外部工具读取，与官方 folder chat 的 `tsc.json` 对齐）。

## P3 — 远期

- [ ] **MCP tool server**
  官方正在探索把 tscmd 暴露为 MCP 工具。等官方落地后评估直接复用，
  让 Claude Code 等外部 agent 与我们的应用内 agent 操作同一套文件体系。
- [ ] **向量化 / embedding**
  官方明确不上向量库（"plain files + lightweight CLI"）。保持克制：
  全文索引 + 标签操作符够用之前，不做 embedding。

## 已完成（本轮，留档）

- [x] AI Agent 基础集成（commit `77b056732`）：Agent 循环、6 工具、
      AgentPanel、AiAgentDialog、多模型管理、验证体系
- [x] 内网连通性：CORS（webSecurity）+ 自签名证书（ignore-certificate-errors）
- [x] 启动自动预选模型；回复语言跟随用户消息
- [x] 帮助菜单/欢迎页噪声清理
