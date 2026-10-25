# 方案：Agent 运行期的会话锁 + 续跑 location 一致性校验

> 执行者注意：行号基于 commit `c2e53c425` 之后的代码，可能有漂移，**以符号名定位为准**。
> 改动只涉及 `src/renderer/components/chat/AgentPanel.tsx` 和两个 locale 文件，
> **不要动 `AgentService.ts`**（`drainInterruptQueue` 与事件协议已按 run 隔离，无需改）。

## 背景

Step 边界注入已落地（`6041e08b9` + 修复 `c2e53c425`）：run 运行中输入框不禁用，
用户发的补充指令进 `AgentInterruptQueue`，由 `runAgent` 在每个 step 边界 drain 注入；
run 结束时未 drain 的残留指令由 resume effect 折叠成一次续跑（`skipUserBubble: true`）。

剩余两个 bug（详细描述）：

### Bug 1：切会话导致气泡错位 + 指令注入错误 run + 续跑落错会话

**现象**（三个连锁错位，同一根因）：

1. run 在会话 A 运行中，用户切到会话 B 发补充指令：气泡显示在会话 B，
   但指令被注入会话 A 的 run。会话 B 里留下一条永远不会有回应的 user 气泡，
   会话 A 的模型却收到了用户以为是发给 B 的指令。
2. 若 run 结束时该指令未 drain 触发续跑：续跑 effect 用最新 `handleSend`，
   以"当下"的 `currentSession`（= 会话 B）发起 run——指令在错误的会话里执行。
3. 更糟的是续跑带 `skipUserBubble: true`：会话 B 里连指令气泡都不显示，
   直接凭空出现一个 assistant 空气泡开始调工具，用户完全看不出发生了什么。

**复现步骤**：会话 A 发任务 → run 运行中发一条补充指令（排队）→
点顶部任务目标按钮切到会话 B → 等 run 自然结束。

**根因**：`pendingQueueRef` / `resumeRef` 是全局单例，不绑定会话；
queue 分支取 `session.id`（发送时刻的当前会话）而注入目标是运行中 run 的
conversation；resume effect 用最新闭包里的 `currentSession`。

### Bug 2：续跑用"当下"的 location 上下文执行旧任务

**现象**：run 结束触发续跑时，`handleSend` 用当下的 `findLocation()` /
`currentDirectoryPath` / `selectedEntries` 重建 system prompt 和工具集
（`buildTools()` 闭包，`AgentPanel.tsx` 约 333-347 行）。若用户在 run 期间
切换了 location，续跑会拿新 location 的地图执行原 location 的任务：模型收到
新 location 的系统提示 + 旧 location 的操作历史 + 指令，行为不可预期。

**复现步骤**：location X 发任务 → run 运行中发一条补充指令（排队）→
切换到 location Y → 等 run 自然结束 → 续跑在 Y 的上下文里执行 X 的任务。

**根因**：run 启动时对 system prompt 输入做了快照，但续跑路径没有复用快照，
而是重新按"当下"构建。

## 需求（用户已确认）

- 运行中**允许切换 location**（主功能，不能挡）。
- 运行中**禁止切换/新建/删除会话（任务目标）**。
- 指令必须落在发送时界面对应的 Agent 上下文中。

改动 1 消除 Bug 1 的全部三个错位（会话锁死后，"当前会话"恒等于 run 的会话，
气泡、注入、续跑全部同会话）；改动 2 消除 Bug 2 的续跑分支。注：排队注入本身
注入的是 run 启动时的 conversation 副本，切 location 对运行中的 run 无影响，
该部分不需要处理。

## 改动 1：运行中禁用会话操作（AgentPanel.tsx）

三个入口加 `disabled={isRunning}`：

1. 任务目标按钮（`data-tid="agentTaskGoalTID"`，会话下拉菜单的锚点按钮）；
2. 新建会话按钮（`tooltip={t('core:aiAgentNewSession')}` 的 `TsIconButton`，
   `onClick={handleNewSession}`）；
3. 删除会话按钮（`tooltip={t('core:aiAgentDeleteSession')}` 的 `TsIconButton`，
   `onClick={handleDeleteSession}`）。

加固（可选但建议）：`handleNewSession` / `handleDeleteSession` 函数体开头加
`if (isRunningRef.current) return;`，防未来新增调用路径绕过 UI 禁用。

MUI disabled 的按钮 tooltip 仍会显示，无需额外处理。导出、重命名、模型选择
不受影响。

## 改动 2：续跑的 location 一致性校验（AgentPanel.tsx）

1. **记录发起 run 时的 location**：新增
   `const runLocationIdRef = useRef<string>('');`，在 run 启动处（现有
   `const myRunId = ++runIdRef.current;` 附近）赋值：
   `runLocationIdRef.current = findLocation()?.uuid ?? '';`

2. **resumeRef 携带 locationId**：结构从 `useRef<string[]>([])` 改为
   `useRef<{ locationId: string; texts: string[] } | null>(null)`。finally 里
   存 leftover 时：
   `resumeRef.current = { locationId: runLocationIdRef.current, texts: leftover };`
   （注意同步改 handleStop、effect 里的所有读写点；`texts` 为空数组时同样视为无残留。）

3. **resume effect 改为校验后分支**（替换现有 effect 体）：

   ```tsx
   useEffect(() => {
     if (isRunning || !resumeRef.current) {
       return;
     }
     const { locationId, texts } = resumeRef.current;
     resumeRef.current = null;
     if ((findLocation()?.uuid ?? '') === locationId) {
       // 同一 location：自动续跑（现有行为），复用已显示的气泡
       handleSend(texts.join('\n\n'), { skipUserBubble: true });
     } else {
       // location 已切换：不自动续跑（会拿新 location 的上下文执行旧任务）。
       // 指令放回输入框，由用户确认后手动发送。
       setInput(texts.join('\n\n'));
       showNotification(t('core:aiAgentResumeContextChanged'), 'warning');
     }
   }, [isRunning, handleSend, findLocation]);
   ```

   说明：
   - `showNotification` AgentPanel 已在用（provider 未配置的 warning），
     import 现成；severity 用 `warning`。
   - **已知取舍**：放回输入框后用户重新发送，会话里该指令会出现两次
     （排队时一次、重发一次）。可接受——用户发送前还能编辑指令，且重发时
     上下文由用户自己确认过。不要尝试删除原气泡（多条同内容消息会误删）。
   - effect 依赖加 `findLocation`（context 提供的函数，切 location 后引用
     更新会触发 effect 重跑，语义正确）。

## 改动 3：i18n（en + zh_CN 各加一条）

`src/renderer/locales/en/core.json`：

```json
"aiAgentResumeContextChanged": "The location changed since the task started — queued instruction(s) were moved back to the input box. Review and send when ready."
```

`src/renderer/locales/zh_CN/core.json`：

```json
"aiAgentResumeContextChanged": "任务开始后位置已切换，未送达的补充指令已放回输入框，请确认后手动发送。"
```

（放在现有 `aiAgentQueuedHint` 附近，保持两个文件键顺序一致。）

## 明确不做

- 不限制 location 切换；不改排队注入逻辑（它注入的是 run 的 conversation 副本，
  与当下 UI 无关）。
- 不改 `AgentService.ts`；不新增单测文件（本次逻辑都在 UI 层，无可纯函数化的点）。
- 不做按会话并行的多 run（完整方案留待后续，见讨论记录）。

## 验收清单

1. `npx tsc --noEmit -p tsconfig.json` 无报错；`npm run test-unit` 全部通过
   （本机 `npm run lint` 因 eslint-plugin-jest 安装损坏跑不起来，跳过）。
2. run 运行中：任务目标按钮、新建、删除三个入口点击无响应。
3. run 运行中切换 location：run 正常继续，工具仍操作原 location 的文件；
   此时发补充指令正常排队注入，气泡与注入都在原会话。
4. run 结束（自然完成或预算硬停）且 location 未变、有残留指令：自动续跑，
   会话中不出现重复 user 气泡。
5. run 结束且 location 已变、有残留指令：不自动续跑，指令出现在输入框，
   弹出 warning 通知；手动发送走正常新 run。
6. 点「停止」后：无残留续跑发生（stop 清队列的中断语义不变）。
7. 无排队指令时一切照旧：续跑 effect 空转，无 notification。
