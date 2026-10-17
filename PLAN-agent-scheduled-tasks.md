# 方案：Agent 定时执行任务（Scheduled Agent Tasks）

> 执行者注意：基于 commit `d6a7b389b` 之后的代码。行号可能漂移，**以符号定位为准**。
> 本方案延续项目既有原则：零新依赖、纯逻辑可单测（`src/main` 内纯函数 +
> `tests/unit/` 单测，参照 `todoStore` / `diskScanner` 先例）、上下文快照原则
> （指令落在发起时的会话与 location）、"主功能界面挤占式"UI 约定。

## 1. 需求描述

用户可以把一条 Agent 指令（prompt 模板）配置成定时任务，由应用在指定时间
**自动执行**（完整走 runAgent 工具循环），无需人工点击。典型场景：
"每天 9 点整理收件箱"、"每周一汇总上周新增文件并写周报"、
"每 2 小时检查 Downloads 并按规则归档"。

用户故事：
1. **我在对话里直接说"以后每天早上 9 点整理收件箱"，Agent 调用 `schedule_task`
   工具创建任务，并向我复述解析后的无歧义描述（"每天 09:00，位置 X"）供确认**。
2. 到点后应用自动在**专属会话**里执行这条指令，我能看到完整执行过程与结果。
3. 应用没开时错过的任务，启动后提醒我，可一键补跑。
4. 我在 Agent 面板的**定时任务列表**里，能随时启用/停用/立即执行/删除任务，
   并查看最近执行记录。

**调度表示 = cron 字符串（内部规范格式）**：cron（5 字段，本地时区）是调度
表示的唯一内部事实源——存储、执行计算（next-run）、导出导入都用它。但 cron
**不面向用户书写，也不由模型直接生成**：

- Agent 通过**结构化字段模型**创建任务：5 个 cron 维度（minute / hour /
  dayOfMonth / month / dayOfWeek）是可选字段，任意组合、缺省即 `*`——任何
  cron 能表达的调度都能用字段表达，保留 cron 的全部表达力；主进程纯函数
  `scheduleToCron` 校验后转成 cron 存储。
- 展示/确认一律走 `describeSchedule`，把 cron 渲染回人话，用户永远不接触
  cron 语法。
- cron 的边界问题由 **参数校验 + 显式渲染** 化解（不在 cron 字符串上做事后
  检测，也不靠固定模板压缩表达力）：
  - 逐字段范围校验：分钟位 ⊆ {0,15,30,45}（启动时间对齐每 15 分钟，单个可调
    常量）、hour 0-23、dayOfMonth 1-31、month 1-12、dayOfWeek 0-6；
  - 静态不可能日期表（两行查表，非搜索）：`month==2 && day>29`、`day==31 &&
    month∈{4,6,9,11}` 拒绝——"2 月 31 号"这类永不触发被拦截，但 2/29 闰年仍允许；
  - dayOfMonth 与 dayOfWeek **同给 = 显式 OR**（标准 cron 语义）：`describeSchedule`
    渲染成"每月 1 日 **或** 每周一"让用户确认，歧义在确认层消掉、不在功能层
    砍掉（见 §5.5）；
  - DST 用本地钟面语义（缺口日不跑、重叠只跑一次）。

**能力边界（诚实声明）**：Agent 是渲染层能力，**应用必须处于运行状态**才会
触发（最小化/关面板都可以，应用退出则不执行，靠补跑机制兜底）。

## 2. 现状关键事实（决定架构）

1. `AgentPanel` 挂在 `AiAgentDialog` 的 Drawer 内（`AiAgentDialog.tsx:171-186`），
   且 MUI Drawer 默认不 keepMounted：**面板关闭或切到 kb/tools/skills/deepseek
   tab 时 AgentPanel 整个 unmount**，sessions / currentSessionId / 运行中的
   run 状态全部销毁。→ 定时任务要"面板关着也能跑"，**必须把会话与运行状态
   提升到常驻 Provider**。这是本方案最大的重构点，也是后续一切 Agent 后台
   能力的地基。
2. 半自动先例：收件箱每日提醒（localStorage `tsInboxLastOrganized` + 提醒
   卡片 + 「整理收件箱」按钮播种指令）——定时任务是它的通用化，但触发从
   "用户点按钮"升级为"调度器播种"。
3. 调度先例：主进程 `todoStore`（内存主副本 + 校验 + 原子写 tmp→rename +
   轮转备份 + 损坏回滚）——定时任务存储照抄这个模式。
4. 单 run 全局约束 + `runIdRef` 竞态保护 + 会话归属快照（`d6a7b389b`）——
   定时执行必须复用这套保护，不能绕开。

## 3. 架构总览

```
主进程（常驻，单实例锁保证唯一）
  agentScheduler.ts  ── 持久化 tasks.json + 30s tick 检查 due
      │  IPC: scheduledTask:list/create/update/delete/runNow
      │  IPC 广播: scheduledTaskDue (taskId)
      ▼
渲染层（常驻）
  AgentSessionsContextProvider（新，DialogsRoot 同层挂载）
      ├─ sessions / currentSessionId / runState（从 AgentPanel 提升）
      ├─ ScheduledTaskExecutor（hook）：监听 scheduledTaskDue
      │    → 校验 location → 空闲则播种 run，忙则延迟重试
      ▼
  runAgent()（现有，不改）
```

分工原则：**主进程只管"什么时候该跑"**（持久化 + 时间计算 + 广播），
**渲染层管"怎么跑"**（会话、上下文、runAgent、结果记录）。主进程不理解
prompt 内容，不做任何 AI 调用。

## 4. 数据模型

### 4.1 任务定义（主进程 `userData/agent-scheduler/tasks.json`，todoStore 模式）

```ts
type AgentScheduledTask = {
  id: string;            // uuid
  name: string;          // 用户可读名称
  prompt: string;        // 指令模板（原样作为 user 消息播种）
  schedule: {
    cron: string;        // 唯一存储与执行事实源（5 字段，本地时区）
  };
  locationId: string;    // 创建时的 location uuid（快照原则）
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  nextRunAt: number;     // 主进程纯函数计算与维护
  lastResults: Array<{   // 环形，≤20 条
    startedAt: number;
    status: 'success' | 'failed' | 'skipped' | 'missed';
    detail?: string;     // skipped 原因 / failed 错误摘要
  }>;
};
```

**存储只存 cron**：结构化字段（minute/hour/dayOfMonth/month/dayOfWeek）是
**输入层**概念（§5.5 工具 schema），不是数据模型字段——Agent 填字段 →
`scheduleToCron` 校验并转 cron 入库；UI 只消费 `describeSchedule` 渲染的人话
与 raw cron，不做反向解析。

存储实现直接参照 `src/main/todoStore.ts`：内存主副本 + `createAgentSchedulerStore()`
纯逻辑（CRUD + 校验 + 原子写 + 备份 + 损坏回滚）+ `initAgentScheduler()` 注册
IPC。**新增文件 `src/main/agentScheduler.ts`，不碰 `main.ts`**（挂载在
`mainEvents.ts` 的 `loadMainEvents()` 里，同 todoStoreIpc 先例）。

### 4.2 IPC 契约（加进 `preload.ts` 的 `Channels` 联合类型）

- `scheduledTask:list` → `AgentScheduledTask[]`
- `scheduledTask:create` / `update` / `delete`（参数校验放主进程纯函数）
- `scheduledTask:runNow`（手动立即执行：渲染层也可本地直接触发，二选一，
  建议走主进程统一记录）
- 主进程 → 渲染层广播 `scheduledTaskDue`（`{ taskId }`），渲染层执行完调
  `scheduledTask:reportResult`（`{ taskId, status, detail?, ranAt }`）回写
  `lastRunAt` 并推进 `nextRunAt`。

## 5. 调度计算（零依赖纯函数，重点单测对象）

`src/main/agentScheduler.ts` 内导出纯函数：

- `scheduleToCron(fields): string` —— 结构化字段（minute?/hour?/dayOfMonth?/
  month?/dayOfWeek?/stepHours?）→ 5 字段 cron 字符串（本地时区），缺省维度补
  `*`；校验不通过抛错，见 §5.5 校验清单。
- `matches(cron, date): boolean` —— 单日命中判定（**核心谓词，唯一语义来源**）：
  - 分钟/小时/月份/日期各维度：该维非 `*` 时，`date` 对应值必须在集合内
    （维度间 AND）；
  - **dayOfMonth 与 dayOfWeek 的 OR 规则（Vixie cron 语义）**：`dom` 与 `dow`
    都非 `*` → 命中 `matchDom || matchDow`；仅一个非 `*` → 命中那一个；
    两者都是 `*` → 命中。
- `nextRunAfter(cron, from): number` —— 从 `from` 起用 `matches` 逐分钟/逐日
  推进找下一次触发（15 分钟粒度缩小搜索空间），处理月末/闰年/跨年。
- `isDue(task, now, graceMs = 90_000): boolean` —— `enabled && nextRunAt <= now`，
  配合 tick 间隔 30s，grace 防时钟抖动。
- `findOverdue(tasks, now, missedThresholdMs = 12h)` —— 启动时补跑扫描。
- `describeSchedule(cron): string` —— cron 渲染人话（"每天 09:00" / "每周一、
  三、六 09:00" / "每月 1 日和 15 日" / "每 2 小时"），对话确认与 UI 展示共用；
  **dom+dow 同给必须显式渲染成"…或…"**。

主进程 tick：`setInterval(30_000)`，逐个检查 due 任务 → 广播 `scheduledTaskDue`。
系统休眠期间 interval 停摆，唤醒后第一个 tick 会把 due 的任务一次性广播出来
——渲染层执行器负责串行消化（见 §6），不会并发轰炸。

**DST 策略（显式，一行）**：`nextRunAfter` 用本地时区 `Date` 语义——春季时钟
前拨的缺口时刻当天不跑（与"每天 9 点"语义一致），秋季重叠只取靠后一次。
**不做** `custom.cron` 全量语法支持（P2，见 §12）；不做自定义时区。

## 5.5 Agent 工具入口：`schedule_task`（AgentTools.ts 新增）

对话创建是**唯一创建/编辑入口**（UI 无表单，任务列表只做展示与管理）；
UI 与对话写同一份 tasks.json。

- 工具操作：`schedule_task`（创建/更新）、`scheduled_tasks`（列出，含
  nextRunAt 与最近状态）、`unschedule_task`（停用/删除）。参数为**结构化字段
  模型，模型不生成 cron 字符串**——tool calling 的 JSON schema 约束下比字符串
  解析可靠得多，同时保留 cron 的全部表达力（5 个维度任意组合）：
  ```ts
  schedule_task 参数:
  {
    name: string;
    prompt: string;
    schedule: {
      minute?: number[];       // ⊆ {0,15,30,45}（15 分钟对齐）
      hour?: number[];         // 0-23
      dayOfMonth?: number[];   // 1-31
      month?: number[];        // 1-12
      dayOfWeek?: number[];    // 0-6（0=周日）
      stepHours?: number;      // 便捷：每 N 小时（1-23），与 hour 互斥 → 0 */N * * *
      // time?: 'HH:mm' —— 便捷别名，等价 minute+hour（sugar，可选）
    }
  }
  ```
- **主进程参数校验（纯函数，非法以 `{ error }` 回传模型自纠）**：逐字段范围
  （minute ⊆ {0,15,30,45}、hour 0-23、dayOfMonth 1-31、month 1-12、dayOfWeek
  0-6、stepHours 1-23）+ 静态不可能日期表（`month==2 && day>29`、`day==31 &&
  month∈{4,6,9,11}` 拒绝）+ 任务数 ≤ 20、name/prompt 非空。
- **dayOfMonth 与 dayOfWeek 同给 = 显式 OR（不拒绝）**：标准 cron 语义，二者
  都设置时命中任一即触发。歧义不在功能层砍掉，而在**确认层消掉**——
  `describeSchedule` 必须渲染成"每月 1 日 **或** 每周一"，system prompt 要求
  Agent 向用户复述时用"或"连接（见下）。
- **无歧义确认**：工具返回值带 `describeSchedule(cron)` 的人话描述 + 绑定
  location 名，system prompt 要求 Agent 创建后向用户复述该描述再继续
  （"已设置：每月 1 日 09:00 **或** 每周一 09:00，位置 X，指令摘要…"）。歧义
  在 Agent↔用户对话中消除，用户永远不接触 cron 语法。
- 位置绑定：`schedule_task` 不让模型填 locationId——由执行层取**当前
  location**（用户正在对话的上下文）并回传确认，避免模型编造 uuid（呼应
  "系统提示词要求模型不得编造文件路径"的既有护栏）。
- prompt 引导（`agentPrompt.ts`）：说明何时建议定时化（用户说"以后每天…"
  "定期…"），并告知无人值守任务的指令应确定性强、可恢复。

## 6. 渲染层：状态提升 + 执行器

### 6.1 状态提升（重构核心）

新建 `src/renderer/components/chat/AgentSessionsContextProvider.tsx`：

- 把 AgentPanel 里的 `sessions` / `setSessions` / `currentSessionId` /
  `setCurrentSessionId` / `updateSession` / `loadSessions` / persist effect /
  以及运行状态（`runIdRef` / `isRunningRef` / `pendingQueueRef` / `resumeRef` /
  `runLocationIdRef` / `queuedCount` 逻辑 / handleSend 的**核心执行部分**）整体提升。
- Provider 常驻挂载（与 `AiAgentDialogContextProvider` 同层，见其挂载位置），
  不随 Drawer 开关/切 tab 卸载。
- `AgentPanel` 改为纯消费者（useContext 取状态与动作），行为不变。
- **注意**：`d6a7b389b` 的全部竞态保护（runId guard、skipUserBubble、
  resume location 校验、会话锁）必须原样随迁并在提升后回归测试；
  `patchAssistant` / `handleStop` / resume effect 一并上移。
- `handleSend` 拆成两层：UI 层（输入框文本、prompt 历史、input state 留在
  AgentPanel）+ 执行层（`startRun(sessionId, text, opts)` 提升到 Provider，
  定时执行器和手动发送都调它）。**这是解约定时触发的关键拆分。**

### 6.2 定时执行器（`useScheduledTaskExecutor`，挂 Provider 内）

监听 `scheduledTaskDue` 事件，串行执行：

1. **取任务**（`scheduledTask:list` 缓存或由广播带全量定义），`enabled=false` 则忽略。
2. **location 校验**：`findLocationById(task.locationId)` 不存在 →
   `reportResult(skipped, 'location missing')`。延续"指令落在对应上下文"原则：
   任务绑定创建时的 location，不跟随当前界面。
3. **会话归属**：每个任务绑定专属会话（`task.sessionId`，首次执行时创建，
   命名 `⏰ {task.name}`，写回任务定义）。执行 = 在该会话播种 `task.prompt`
   （复用 `startRun`，正常 user 气泡 + assistant 占位）。
4. **冲突策略（全局单 run 约束保留）**：若当前有 run 在跑（`isRunningRef`，
   无论手动还是会话锁），延迟 60s 重试，最多 10 次；仍忙 → `reportResult(skipped,
   'agent busy')`。**不要**把定时指令排队进正在跑的 run——跨会话注入是
   已修复的 bug 模式；但**运行中用户对"本任务"的补充输入允许**——走 step
   boundary 注入（§7.4），同一会话内注入，不违反跨会话约束。
5. **结果回报**：`runAgent` 完成/失败/中止 → `reportResult`。执行过程对用户
   完全可见（会话流 + 工具卡片），失败显示现有 error 徽标。
6. 多个 due 任务按广播顺序串行（Promise 队列），不并发。
7. **运行中状态暴露**：run 启动时 Provider 记录 `runningTaskId`（含本次
   startedAt），UI 据此在任务列表显示"运行中"徽标并提供详情入口（§7.4）；
   运行结束（成功/失败/中止/stop）清空。

### 6.3 错过补跑（missed）

应用启动（Provider mount）时调 `findOverdue`：有过期任务 → AgentPanel 顶部
出现提醒条（参照收件箱每日提醒卡片样式）："N 个定时任务在上次退出后到期" +
每任务「立即补跑」按钮 + 「忽略本次」。**不做自动批量补跑**——打开应用就
突突跑一堆无人监督的写操作任务不可接受。

## 7. UI（AgentPanel 内子视图）

任务列表与 §5.5 的对话入口写同一份数据。**UI 没有创建/编辑表单**——任务的
创建、改名、改指令、改调度一律在对话里让 Agent 调 `schedule_task` /
`unschedule_task` 完成（对话是唯一入口）；UI 只负责**展示与轻量管理**。
列表展示与 Agent 复述确认两处措辞复用 `describeSchedule`，保证一致。

### 7.1 入口

AgentPanel 工具栏新增「定时任务」按钮（ScheduleIcon，现有 `TsIconButton`
风格），点击切换 AgentPanel 到 `scheduled` 子视图（panel 内部 state，与
kb/tools tab 同一套互斥逻辑，右上角 ✕ 返回 agent 对话视图）。这是面板内
子视图，不是内容区挤占面板（体量小，不违反挤占式约定——该约定针对"完整
功能面板"）。

### 7.2 任务列表子视图

```
┌ 定时任务                                                      ┐
│ [✓] 收件箱每日整理   每天 09:00 · 收件箱 · ✓ 2 小时前     ▶ 🗑 │
│ [✓] 每周一周报       每周一 09:00 · 周报库 · ⏭ skipped        │
│ [ ] Downloads 归档   每 2 小时 · Downloads                    │
│      ▾ 展开：最近执行历史（≤20 条）…                          │
└──────────────────────────────────────────────────────────┘
```

- 每行 = 启用 Switch（关闭 = 置灰且不再调度）+ 名称 + 人话调度描述
  （`describeSchedule`）+ 绑定 location 名 + 上次执行状态徽标
  （success ✓ / failed ✗ / skipped ⏭ + 相对时间，hover 显示 detail）+
  立即执行 ▶ / 删除 🗑（删除走 ConfirmDialog）。
- 行可展开显示 `lastResults` 最近 20 条（时间 + 状态 + detail）。
- 空态：引导文案——"在对话里说'以后每天早上 9 点整理收件箱'即可创建定时
  任务"，附示例任务一键创建（复用 `aiInboxOrganizeMessage` prompt 播种到
  对话）。

### 7.3 补跑提醒条

AgentPanel 顶部（对话列表上方）一条横幅："⏰ N 个定时任务在上次退出后到期"，
每个任务一行（名称 + 人话调度 + 「立即补跑」按钮），末尾「忽略本次」；
关闭后本次会话不再显示。不做自动批量补跑（§6.3）。

### 7.4 任务详情（运行中实时视图 + 补充输入）

运行中的任务（§6.2 的 `runningTaskId`）在列表显示"运行中…"徽标，点击进入
任务详情视图：

- 上方：任务信息（名称、指令、人话调度、location、本次 startedAt）。
- 主体：**实时 Agent 输出**——订阅 Provider 中运行会话的消息流，渲染会话流
  + 工具卡片（与 AgentPanel 同一套渲染组件），边跑边刷新。
- 底部：**补充输入框**——复用 `AgentInterruptQueue`（step-boundary 注入，
  MAX_AGENT_INJECTIONS=4 上限），输入内容到下一 step 边界注入对话；
  排队中显示"⏳ N 条补充指令待送达"。可选：停止本次运行（复用 handleStop）。
- **不走会话切换**：详情视图直接订阅运行会话，不依赖当前 currentSessionId，
  也不违反 `d6a7b389b` 的运行中会话锁。
- 运行结束：详情回到普通列表行，本次结果计入 `lastResults`，可展开查看。

### 7.5 交互细节

- 立即执行走 `scheduledTask:runNow`；若当前已有 run 在跑，沿用 §6.2 冲突
  策略（60s 重试 / skipped busy），按钮给短暂 loading 态。
- 改任务（名称/指令/调度）不在 UI 做——对话里让 Agent 更新（`schedule_task`
  更新路径），列表实时刷新。

## 8. 护栏与安全

- 定时任务无人值守会自动执行**写操作工具**（move_file / add_tags /
  organize_apply 等）。现有护栏已覆盖：不删除、不覆盖、organize_undo 可恢复、
  预算上限（MAX_AGENT_STEPS / MAX_AGENT_INJECTIONS 对定时 run 同样生效）。
- 提示词引导（`agentPrompt.ts`）：创建定时任务时提醒"无人值守任务建议使用
  确定性强、可恢复的指令（如 organize/归档类），避免需要人工确认的流程"。
- **启动时间对齐每 15 分钟**（分钟位 ∈ {0,15,30,45}，`scheduleToCron` 校验
  拒绝非对齐时间）；任务数上限 20（主进程 create 校验拒绝超额）。
- 执行历史可追溯（20 条环形），skipped 必须带原因。

## 9. i18n（en + zh_CN 同步，命名沿用 `aiAgent*` 前缀）

至少：`aiAgentScheduledTitle` / `aiAgentScheduledEmpty` / `aiAgentNewScheduledTask` /
`aiAgentScheduleMinute` / `aiAgentScheduleHour` / `aiAgentScheduleDayOfMonth` /
`aiAgentScheduleMonth` / `aiAgentScheduleDayOfWeek` / `aiAgentScheduleEveryHours` /
`aiAgentScheduleOr`（dom+dow 渲染用的"或"）/ `aiAgentScheduledLastRun` /
`aiAgentScheduledRunning`（"运行中…"徽标）/ `aiAgentScheduledLiveInputPlaceholder`
（详情补充输入框 placeholder）/ `aiAgentScheduledQueuedInjection`
（"⏳ N 条补充指令待送达"）/ `aiAgentScheduledMissedBanner` /
`aiAgentScheduledRunNow` / `aiAgentScheduledSkippedBusy` /
`aiAgentScheduledSkippedLocation` / weekday 名称（可复用现有日期本地化）。

## 10. 测试

`tests/unit/agentScheduler.test.js`（新）：
- `scheduleToCron`：字段 → cron 映射（含 `*/N` step、缺省维度补 `*`）；
- `matches`：维度间 AND、**dom+dow 同给的 OR 语义**（重点）、month/闰年 2/29；
- `nextRunAfter`：15 分钟对齐、当天已过/未过、月末、跨年；
- 校验：分钟位非对齐（如 09:17）、`month==2 && day>29`、`day==31 && month∈
  {4,6,9,11}`、stepHours 0/24 拒绝；
- `describeSchedule`：dom+dow 同给必须渲染出"或"；
- `isDue` / `findOverdue` 的 grace 与阈值；
- store 纯逻辑：CRUD、校验（任务超 20 拒绝）、原子写与损坏回滚
  （参照 todoStore 测试写法）。

渲染层抽得出的纯函数（重试决策 `nextRetryDelay(retryCount)`）一并单测。

## 11. 验收清单

1. `tsc --noEmit` 干净；`npm run test-unit` 全过（含新 agentScheduler 用例）。
2. 回归：手动对话、step 注入、会话锁、Stop、续跑——**状态提升后行为与
   `d6a7b389b` 完全一致**（这是本次最大风险区，逐条手动过）。
3. 面板关闭/切到 kb tab 时到点任务仍自动执行；重新打开面板能看到执行过程
   与结果会话。
4. 定时触发时手动 run 正在跑 → 60s 后重试；10 次仍忙 → skipped + 原因。
5. 对话创建：说"每天早上 9 点整理收件箱"→ Agent 调 `schedule_task` → 字段参数
   正确（minute:[0], hour:[9]）→ 主进程转 cron 存储 → Agent 复述人话描述；
   参数非法（如 minute=[17]、month=[2] & dayOfMonth=[31]）时报错且模型自纠；
   dom+dow 同给时描述用"或"呈现。
6. 任务绑定的 location 被删除 → skipped + 原因，不误跑。
7. 应用退出期间到期的任务：下次启动出提醒条，一键补跑/忽略。
8. 删除 location/会话/任务链路无悬空引用；`tasks.json` 损坏自动回滚。
9. 定时任务运行中：列表显示"运行中"徽标 → 点进详情实时看到会话流/工具卡片
   边跑边刷；详情输入框补充指令 → 到 step 边界注入对话、排队计数正确、
   MAX_AGENT_INJECTIONS 上限生效；运行结束详情回收、结果计入 `lastResults`。

## 12. 分期

- **P1（本方案范围）**：状态提升 + 主进程调度器（cron 解析 + `matches` +
  next-run + 校验）+ 执行器 + 结构化字段模型（5 维度任意组合）+ `schedule_task`
  工具组 + UI 管理 + 补跑提醒。预计改动量：新增 3 个文件（scheduler、Provider、
  executor hook）+ AgentTools 3 个工具 + AgentPanel 大幅瘦身 +
  mainEvents/preload/agentPrompt/i18n。
- **P2（后续）**：任务模板库（把蒸馏出的工作流沉淀为可复用定时资产，契合
  AGENTS.md 长期目标）、执行完成系统通知、失败重试策略、`custom.cron` 全量
  转义口（任意 cron 字符串直通存储，OR 语义已由 §5 `matches` 统一定义）、
  任务导出/导入。
