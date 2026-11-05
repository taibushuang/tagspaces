# TODO：TagSpaces 兼容子公司模式 LLM 网关（ccb_subsidiary）

> 状态：**已完成并真机验证通过（2026-11-05），已随 6.22.0 提交打包。**
> 日期：2026-11-04（实现）/ 2026-11-05（验证）

## 背景

目标网关：`aiyunwei/monitor-qwen-final/llm_gateway/`（生产 `upstream_mode: ccb_subsidiary`，
URL 形如 `https://im5.ccbft.com/node3/chat-gen/...`）。该网关**不是 OpenAI 协议**：

- 鉴权：`X-Api-Key: <token>`（新）或 `Cookie: access-token=<token>`（旧）
- 对话：`POST /chat-gen/conversation`，body=`{message(必填), session_id(必填, ^[A-Za-z0-9_-]{1,64}$), messages?(OpenAI 格式透传), model?, stream?}`
- `job-` 前缀 session = 上游自管（messages 透传）；`wx-` = 网关托管记忆
- 响应：SSE `data: {"content": "..."}` … `data: [DONE]`
- 模型列表：`GET /chat-gen/models` → `data.models`（字符串数组）
- **无 tool-calling**：Agent 在该引擎下降级为纯对话
- 网关校验 messages 每条必须有 `role`+`content`（assistant 工具调用消息 content 为 null 会被拒）

## 已完成（代码改动，全部未提交）

| 文件 | 改动 |
|---|---|
| `src/renderer/components/chat/ChatTypes.ts` | `AIProviders` 增加 `'llm-gateway'` |
| `src/renderer/components/chat/LlmGatewayClient.ts` | **新增**：协议适配（URL 归一、双鉴权头、SSE 解析、messages 消毒透传、每次请求独立 `job-ts<uuid>` session、list/probe/verify） |
| `src/renderer/components/chat/AiClient.ts` | `getAiClient`/`verifyProviderModel`/`probeProviderEndpoint` 三处加 llm-gateway 分支 |
| `src/renderer/components/chat/AgentService.ts` | `AgentRunOptions` 加 `engine?`；runAgent 内按 engine 分派 `chatGatewayCompletion`/`chatOpenAICompletion`（completion 常量） |
| `AgentSessionsContextProvider.tsx` / `hooks/ChatProvider.tsx` | 两处 `runAgent({...})` 调用点传 `engine: defaultAiProvider.engine` |
| `src/renderer/components/chat/aiPresets.ts` | 新增预设 `ccb-gateway`「CCB 子公司网关」，默认 URL `https://im5.ccbft.com/node3` |
| `manual/mock-gateway-subsidiary.js` | **新增**：子公司协议 mock（端口 8318，token=`testtoken`，模型 `F-G-9B-TEST-0000-00`，stdout 打印每轮 messages 数量用于验证多轮透传） |

已验证：`npx tsc --noEmit` 通过；`npx playwright test --config ./playwright.unit.js` 733/733 通过。

## 待办（全部完成 ✅ 2026-11-05）

1. ✅ **真机 CDP 端到端验证**：`manual/drive-subsidiary-verify.js` PASS——预设菜单可见、
   建引擎、保存并验证、切默认引擎、Agent 两轮对话（网关侧确认 messages 2→4 条透传）。
   测试 provider 已从 dev profile 清除，mock/dev 进程已停。
2. ✅ AGENTS.md 已加「子公司模式 LLM 网关接入」章节。
3. ✅ commit + push + 6.22.0 Windows 包。

## 遗留观察（非本次引入，未处理）

- **AgentSessions `apiMessages` 不含最终助手回复**：`runAgent` 的 conversation 只在
  工具调用时 push assistant 消息，最终纯文本回复只作为 `result.content` 返回，导致
  `apiMessages: result.messages`（AgentSessionsContextProvider 908 行）里没有最后一轮
  助手答复——多轮时模型看不到自己上一轮的回答（所有引擎共有，mock 日志
  `roles=[system,system,user,user]` 证实）。后续可让 runAgent 在结束前 push 最终
  assistant 消息。
- **dev 启动怪癖（本机）**：`npx electron .` 静默 exit(0)（单实例锁分支），但直接
  `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .erb/dll/main.bundle.dev.js`
  可正常启动（CDP 9222 正常）。原因未深究，electronmon 路径未复测。
- **Windows 实机部署注意**：生产网关 `https://im5.ccbft.com` 若为企业自签证书，需先装
  企业 CA（渲染层直连，`webSecurity:false` 已关 CORS，但证书链仍由 Chromium 校验），
  遇到 `ERR_CERT_AUTHORITY_INVALID` 先装 CA 再测；token 由网关管理员分配，填在
  引擎卡片的 API Key 栏。
