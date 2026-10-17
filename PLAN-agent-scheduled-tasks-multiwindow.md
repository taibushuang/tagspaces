# 方案：定时任务执行窗口收敛（多窗口不重复执行）

> 前置：基于 `PLAN-agent-scheduled-tasks.md` 的实现（已落地：主进程
> `agentScheduler.ts` + 渲染层 `AgentSessionsContextProvider`）。
> 本方案只解决「多窗口重复执行」一个问题。行号以当前 develop 为准，**以符号定位**。
> 延续既有原则：主进程只管"什么时候/哪个窗口跑"，渲染层管"怎么跑"；零新依赖。

## 1. 问题陈述

TagSpaces 区分**主窗口**（`main.ts` 的 `createWindow`，全局 `mainWindow` 引用）和
**子窗口**（`createNewWindowInstance`，为打开 MD 文档等单独新开的窗口，加载
`index.html`——会运行完整渲染层，包括挂在 `DialogsRoot` 的
`AgentSessionsContextProvider`）。

当前 `agentSchedulerIpc.ts` 的 `broadcastDue` 用
`BrowserWindow.getAllWindows().map(w => w.webContents.send('scheduledTaskDue', …))`
向**所有窗口**广播。每个窗口的渲染层 Provider 都订阅该事件并执行同一任务 → **多
窗口场景下同一任务被执行多次**（文件操作、写周报等副作用重复发生，不可接受）。

## 2. 现状关键事实

1. `main.ts:45` `let mainWindow: BrowserWindow | null = null;`——主窗口引用只在
   `createWindow` 里赋值；`createWindow` 未在窗口对象上打任何"我是主窗口"标记。
2. `main.ts:377` `createNewWindowInstance(url?)`——子窗口与主窗口用同一套
   `browserWindowOptions`，仅在 `?cmdopen=` 上携带文件参数；**窗口对象上没有主/子
   角色字段**（现有 `fileChanged`/`descriptionChanged` 用 `@ts-ignore` 挂自定义属性
   的先例）。
3. 子窗口同样挂载 `DialogsRoot` → `AgentSessionsContextProvider`，同样
   localStorage `tsAiAgentSessions`、同样订阅 `scheduledTaskDue`、同样在 mount 时
   算 `findOverdue` 补跑横幅——所以问题不止"重复执行"，还有"每个子窗口都弹补跑横幅"、
   "多个 Provider 各自持有一份 in-memory sessions 并互相覆盖 localStorage"。
4. `mainWindow` 的 `closed` 事件（main.ts:610）只清 boundsSaveTimer，**没有把全局
   `mainWindow` 置空**，也不影响调度器（调度器只认 `getAllWindows()`）。

## 3. 设计目标

- 同一时刻**至多一个窗口**执行定时任务、弹补跑横幅、运行 Agent 会话。
- 执行窗口 = **主窗口**（应用的常驻主界面）；MD 文档子窗口**永不执行**定时任务。
- **主窗口"关闭"= 最小化到系统任务栏**（不销毁、渲染层常驻，§4.5）→ 执行窗口
  常驻，定时任务**不因关窗口而暂停**；只有显式退出（Cmd+Q / 托盘退出）才真正结束
  执行，此时属"应用退出"，靠下次启动 `findOverdue` 补跑提醒兜底。
- 对 `PLAN-agent-scheduled-tasks.md` 已落地的行为零回归（单窗口下行为完全不变）。

## 4. 方案：主进程指定单一执行窗口

### 4.1 窗口角色标记（main / child）

窗口创建时在 BrowserWindow 对象上挂角色字段（沿用 `fileChanged` 的 `@ts-ignore`
先例，或扩展一个类型声明）：

- `src/main/main.ts` `createWindow`：`mainWindow.isMainAgentWindow = true`（主窗口）。
- `src/main/main.ts` `createNewWindowInstance`：`newWindowInstance.isMainAgentWindow = false`（子窗口）。

> 角色按**创建路径**判定，不按 URL/`?cmdopen=` 判定——启动时主窗口也可能带
> `?cmdopen=`（startupFilePath），子窗口也可能不带 query（line 411 else 分支），
> 按 URL 判会错。

### 4.2 广播收敛：`broadcastDue` 只投递执行窗口

`agentSchedulerIpc.ts` 的 `broadcastDue` 改为：

```ts
function pickExecutorWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find(
    (w) => !w.isDestroyed() && (w as any).isMainAgentWindow,
  );
}

function broadcastDue(taskId: string): void {
  const win = pickExecutorWindow();
  if (win) win.webContents.send('scheduledTaskDue', { taskId });
}
```

- 命中主窗口 → 只发它一个；子窗口收不到事件，自然不执行、不重复。
- 主窗口"关闭"即最小化（§4.5），不会销毁，所以 `pickExecutorWindow()` 正常存活；
  仅显式退出时窗口才真正关闭——此时应用即将退出，不广播亦无意义，错过任务由下次
  启动 `findOverdue` 兜底。
- `scheduledTask:runNow` 走同一 `broadcastDue`，同样只投递执行窗口（子窗口 UI 已按
  §4.3 不展示定时任务入口，正常不会在子窗口触发）。

### 4.3 渲染层按角色激活（Provider 在子窗口"休眠"）

`AgentSessionsContextProvider` 在 mount 时查询自己的角色（§4.4），**只有主窗口**才：

- 订阅 `scheduledTaskDue` 并跑执行器；
- mount 时算 `findOverdue`、展示补跑横幅；
- **持久化 sessions** 到 localStorage（避免多个 Provider 互相覆盖）；
- 在 AgentPanel 展示定时任务子视图 / 运行中详情。

子窗口的 Provider 只提供**惰性 context**（sessions 可读、不写、不订阅、不执行），
保证 MD 文档窗口不弹横幅、不跑任务、不产生双写。实现上在 Provider 内部加一个
`role` state：`'main' | 'child' | 'unknown'`，`'child'` 时所有副作用 effect 与
订阅短路（`if (role !== 'main') return;`），context value 仍返回（AgentPanel 在
子窗口本就不显示，或显示只读空列表）。

### 4.4 角色查询 IPC

- `preload.ts` Channels 加 `scheduledTask:getRole`（invoke）。
- `agentSchedulerIpc.ts` 注册：`ipcMain.handle('scheduledTask:getRole', (e) =>
  roleOfWindow(e.sender))`——`event.sender` 是发起窗口的 WebContents，用
  `BrowserWindow.fromWebContents(e.sender)` 找窗口，返回 `isMainAgentWindow ? 'main' :
  'child'`；查不到（罕见）返回 `'unknown'`，Provider 按保守策略 = 不激活（宁可暂停
  也不重复执行）。
- 渲染层 Provider mount 时 `await invoke('scheduledTask:getRole')` 得角色，再决定
  激活。

### 4.5 主窗口"关闭"即最小化到系统任务栏（执行窗口常驻）

这是本次决策的核心：**用户关闭主窗口 ≠ 销毁窗口，而是最小化到任务栏**，渲染层
常驻，定时任务继续执行。只有显式退出才真正关闭。

- `main.ts` 加退出标记：`let isQuitting = false; app.on('before-quit', () => { isQuitting = true; });`
  （Cmd+Q / `app.quit()` / 托盘"退出"都会先触发 `before-quit`）。
- `createWindow` 里给主窗口绑定关闭拦截（与既有 `bindUnsavedChangesGuard` 并列）：
  ```ts
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.minimize(); // 最小化到系统任务栏，窗口与渲染层保持存活
    }
  });
  ```
- **与未保存提醒的交互**：`bindUnsavedChangesGuard` 在 close 里先弹"放弃修改？"
  对话框（choice 1 = closeApp 放行）。放行后走到上面的拦截 → 仍是**最小化**而非真正
  关闭。即"确认关闭"在非退出场景下变成"确认最小化"，修改仍在内存——更安全，不需
  改对话框逻辑；若后续要措辞一致可把 `closeApp` 文案改为"最小化"，属可选打磨。
- **托盘恢复**：`bindTrayMenu`（main.ts:702 已存在）托盘菜单需有"显示主窗口"
  （`mainWindow.show()` / `restore()` + `focus()`）与"退出"两项；最小化到任务栏的窗口
  用户也可直接从任务栏点击恢复。
- **子窗口**（`createNewWindowInstance`）关闭行为**不变**——它们不是执行窗口，
  正常关闭销毁。
- **最小化窗口照常执行**：调度 tick 在主进程（30s），不依赖渲染层定时器；渲染层
  执行器由 `scheduledTaskDue` 事件驱动，最小化窗口的 webContents 仍正常收 IPC、跑
  `runAgent` 网络请求（Electron 背景/最小化只节流渲染层定时器，不影响事件与网络）。

## 5. 边界处理

### 5.1 主窗口"关闭"（= 最小化，§4.5）

主窗口点关闭 → 最小化到任务栏，`isMainAgentWindow` 窗口与渲染层都保持存活 →
`pickExecutorWindow()` 一直命中 → 定时任务照常执行，**不存在"只剩子窗口导致暂停"**
的路径。真正结束执行只发生在显式退出（`before-quit` 置 `isQuitting` → 主窗口真正
close → 应用退出）——此时属"应用退出"边界，错过任务由下次启动 `findOverdue` 补跑
横幅兜底。

### 5.2 主窗口重建（重开/二次实例拉回）

`createWindow` 新窗口即新主窗口（`isMainAgentWindow=true`）→ 自动成为执行窗口。
无需迁移逻辑。

### 5.3 多子窗口

全部标记 `false`，全部休眠，互不干扰。`scheduledTaskDue` 只发主窗口。

### 5.4 会话 localStorage 双写

主窗口 Provider 持久化 sessions；子窗口 Provider **不持久化**（只读）。这顺带修掉
了"两个窗口各自持有一份 in-memory sessions 互相覆盖"的隐患（该隐患在定时任务实现
之前就存在，子窗口也会挂 Provider）。

### 5.5 启动即带 `?cmdopen=` 的主窗口

角色按创建路径（`createWindow` vs `createNewWindowInstance`）标记，与 URL 无关，
不受影响。

## 6. 备选方案与取舍

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A（采纳）主进程指定执行窗口** | 打角色标记 + `broadcastDue` 只投主窗口 + 渲染层按角色激活 | 单一事实源在主进程；子窗口连事件都收不到；改动集中在 3 个文件，主进程已握有"何时跑"，加"哪跑"顺理成章 |
| B 渲染层选主（leader election） | 所有窗口收广播，先到先得/最老窗口执行 | 需要跨窗口竞争与失效处理，竞态多（窗口开合、执行中关窗），复杂度高，易出隐藏重复 |
| C 广播全发 + 渲染层按角色 gate 执行 | 子窗口也收事件但不执行 | 比 A 多一步：子窗口仍被唤醒、仍要判断"我是不是主"，且横幅/订阅仍需 gate，不如 A 干净 |

不做 B/C。

**与"关闭即最小化"的关系**：A 只解决"哪个窗口执行"；主窗口关闭后的行为由 §4.5
"关闭即最小化"单独决定——它把执行窗口的存活问题从"暂停/交接二选一"变成了"窗口
根本不关"。两者组合后：执行窗口（主窗口）**既唯一又常驻**，A 的"主窗口不在时暂停"
缺口被 §4.5 直接消掉，B 的"角色漂移"也永远不需要。

## 7. 改动点清单

- `src/main/main.ts`：`createWindow` 打 `isMainAgentWindow=true`；`createNewWindowInstance`
  打 `false`；加 `isQuitting` 标记（`before-quit` 置位）；主窗口绑"关闭→最小化"拦截；
  托盘菜单确保有"显示主窗口 / 退出"项。
- `src/main/agentSchedulerIpc.ts`：`broadcastDue` 改为 `pickExecutorWindow()` 单投；
  新增 `scheduledTask:getRole` handler。
- `src/main/preload.ts`：Channels 加 `'scheduledTask:getRole'`。
- `src/renderer/components/chat/AgentSessionsContextProvider.tsx`：mount 查角色，
  `role !== 'main'` 时订阅/执行/持久化/横幅全部短路。
- （可选）`src/renderer/components/chat/AgentPanel.tsx`：子窗口下定时任务按钮/详情
  入口隐藏（或依赖 Provider 惰性天然不可用）。

不改：`agentScheduler.ts`（纯逻辑，无窗口概念）、`agentSchedulerIpc` 的 store/CRUD、
`PLAN-agent-scheduled-tasks.md` 已定调度语义。

## 8. 测试与验收

- `tsc --noEmit` 干净；`npm run test-unit` 全过（含既有 agentScheduler 用例）。
- 手工（Electron 多窗口）：
  1. 打开主窗口 + 2 个 MD 子窗口；到点任务**只跑一次**，只有主窗口会话里有执行过程。
  2. 子窗口**不**弹补跑横幅；主窗口弹且仅弹一次。
  3. 主窗口点关闭 → 最小化到任务栏（窗口还在、渲染层存活）：到点任务**照常执行**；
     从任务栏/托盘恢复主窗口，会话里有执行过程。
  4. 主窗口最小化：照常执行（渲染层未卸载）。
  5. 显式退出（Cmd+Q / 托盘退出）后重开：启动 `findOverdue` 补跑横幅出现，
     「立即补跑」工作。
  6. `scheduledTask:runNow` 在子窗口不可触发（无入口）；在主窗口触发只跑一次。
- 回归：单窗口（无子窗口）下行为与 `PLAN-agent-scheduled-tasks.md` 落地版完全一致。

## 9. 分期

- **P1（本方案范围）**：§4 全部（角色标记 + 单投广播 + 渲染层角色激活 + getRole IPC +
  主窗口"关闭即最小化" + 托盘恢复/退出）。
- **P2（可选后续）**：主窗口真正关闭时的执行角色**移交**给最老存活窗口——§4.5
  已让主窗口不真正关闭，此场景仅剩"渲染进程崩溃/强制退出"等异常路径，暂不做。
