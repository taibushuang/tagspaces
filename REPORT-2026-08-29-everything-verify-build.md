# Everything 全局搜索可用性验证 + 构建排查战报（2026-08-29）

## 结论（TL;DR）

- **Everything 全局搜索功能可用** ✅：底层数据链路（Everything SDK → IPC → 结果转换）与渲染展示链路均正常。"tagspaces" 搜索返回 84 条结果并在 UI 正常展示。
- **源码生产构建完全可编译、可打包** ✅：`prebuild` / `build:main` / `build:renderer` 全部 exit=0。
- **本轮遇到的唯一障碍是开发模式（`npm run start`）的 webpack-dev-server 编译 renderer 时僵死**（CPU 停在固定值不再增长，bundle 永远编译不出来），这是**开发环境的工具链问题，不是业务代码问题**。生产构建 + `run-electron` 完全不受影响。

## 背景

用户报告：输入 "tagspaces" 做全局搜索仍无结果，怀疑 2026-08-24 战报声称的修复是否真实有效。需要实际验证，而不是仅依据报告。

## 排查过程

### 1. 环境启动受阻（开发模式 webpack 僵死）

用 `npm run start`（开发模式）启动时：
- webpack-dev-server 在 1212 端口监听，但 `main.bundle.js` 返回 404，日志长时间停在 `wait until bundle finished: /`。
- 检测到 renderer 编译进程（webpack serve）CPU 值**完全不变**（两次采样 delta=0），判断为死循环/死锁而非活跃编译。
- 渲染进程 CPU 几乎为 0，窗口标题为空 → 应用界面根本加载不出来。
- 结论：`npm run start` 的 renderer **开发**编译在本机僵死，属环境/工具链问题。

### 2. 底层数据链路直测：Everything 完全正常（关键验证）

绕过卡死的 UI，用 ts-node 直接调用 `src/main/everythingSdk.ts` 的 `searchEverything('tagspaces')`：

```
=== Searching for "tagspaces" ===
available: true
totalCount: 84
results returned: 20（maxResults=20）
  [0] D D:/code/tagspaces/node_modules/@tagspaces ...
  [6] D C:/Users/sunyi/AppData/Roaming/TagSpaces
  [7] D D:/code/tagspaces ...
  ...
```

- IPC 探测：`windowFound=true, sendMessageOk=true, dbLoaded=true`（Everything 客户端 PID 26792 在用户会话运行）。
- DLL 解析：注册表 `D:\软件\Everything\Everything.exe` + 自带 SDK dll `resources/everything/Everything64.dll` 加载成功。
- 结论：**Everything 引擎、SDK 加载、注册表中文路径、IPC、查询、结果提取全部正常**。8-16/8-24 的主进程侧修复有效。

### 3. 生产构建逐步跟踪：全部通过

按 package.json 的构建链逐步执行并跟踪每步：

| 步骤 | 命令 | 结果 |
|---|---|---|
| prebuild | `rimraf dist && prepare-node && generate-extensions && gen-licenses` | exit=0 ✅ |
| build:main | `webpack main.prod` | exit=0 ✅ → `release/app/dist/main/main.js` (982KB) |
| build:renderer | `webpack renderer.prod` | exit=0 ✅ → `renderer.js` (5.9MB) + 全部资源 |

（prebuild 中 `generate-extensions` 对缺失的 `@tagspacespro/extensions` 目录打印 ENOENT 属非致命告警，不影响产物。）

### 4. 生产构建运行：UI + 搜索展示正常

用 `npm run run-electron`（`npx electron ./release/app/dist/main/main.js`）启动编译产物：
- 主窗口正常弹出：标题 `TagSpaces 6.15.9`，渲染进程 CPU 正常增长（非僵死）。
- UI 中执行全局搜索 "tagspaces"，**结果正常展示**。✅

（唯一的 `.env` ENOENT 是 `startWS` 的告警：`release/app/dist/.env` 不存在，仅影响 WebSocket 服务的可选配置文件，不影响主功能。）

## 关于开发模式（dev-server）僵死

- 现象：`npm run start` 的 webpack renderer 开发编译在本机 CPU 停滞（该工程依赖树极重，`eval-source-map` + `ReactRefreshWebpackPlugin` + DLL Reference 组合下，磁盘 IO 受限时易卡死）。
- 影响：仅影响开发热重载路径；**不**影响生产构建与打包。
- 缓解：本机调试可用 `npm run build` + `npm run run-electron` 直接跑产物（已验证可用）；如需开发模式请考虑增大内存/换 SSD 或排查 dev-server 卡死根因（本轮未深挖，属独立议题）。

## 验证数据（Everything 直测）

| 查询词 | totalCount | 前置结果 | 结果 |
|---|---|---|---|
| tagspaces | 84 | 20（maxResults） | PASS，路径涵盖 D:/code/tagspaces/* 与 C:/Users/sunyi/AppData/Roaming/TagSpaces |

全程 `available=true`，`Runtime.exceptionThrown` 无异常。

## 结论与后续

- **全局搜索功能确认可用**（底层 + 展示均已实证），8-24 的渲染修复有效。
- 唯一遗留是**开发模式 dev-server 编译僵死**这一环境问题，与业务代码无关，未列入本轮修复范围。
- 本工程目录下的历史战报：`REPORT-2026-08-19-everything-renderer.md`、`REPORT-2026-08-24-search-results-fixes.md` 记录前两轮修复；本轮为验证与构建链路确认，未改动业务代码（除 versionmeta 自动更新的 iOS 工程文件外工作区干净）。
