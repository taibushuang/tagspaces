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

## 打包规范

- **Windows 只打绿色版**：`tagspaces-win-x64-{version}.zip`。不打 NSIS 安装版（.exe）——`resources/builder.json` 的 `win.target` 已配置为 `["zip"]`，不要改回去。当前是调试迭代阶段，安装版浪费时间
- 分卷压缩使用 `split` 命令，命名格式为 `{filename}.00`, `{filename}.01` 等
- 分卷后必须验证 MD5 一致性

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

**Everything 集成（Windows only）**：
- `src/main/everythingSdk.ts` — koffi 加载 Everything64/32.dll，调用 `Everything_QueryW` 等 W API；含 debug 日志环形缓冲、自动补齐逻辑（DB 未加载时自动启动 Everything.exe）
- `src/renderer/services/everythingSearch.ts` — TS.SearchQuery → Everything 查询语法转换、结果合并 location 索引元数据
- `src/main/mainEvents.ts` — IPC：`searchEverything` / `getEverythingDebugInfo` / `everythingEnsureRunning` / `installEverything`（非 Windows 平台全部返回 unavailable）
- **依赖自动补齐**：DLL 探测顺序 = ① 用户自定义路径（设置项 `everythingPath`，诊断对话框里可填安装目录/exe/dll 路径）→ ② 注册表 App Paths + 默认安装路径（兼容 Everything64.dll/Everything32.dll/Everything.dll 三种命名）→ ③ **自带的 SDK dll**（`resources/everything/Everything64.dll`，通过 builder.json `extraResources` 打入包内——voidtools 安装包不含 SDK dll，必须自带）；Everything.exe 未运行时自动 `-startup` 拉起并等 DB 加载；未安装时可通过诊断对话框 winget 安装
- **诊断界面**：`src/renderer/components/dialogs/EverythingDebugDialog.tsx`（设置 → 常规 → Everything 搜索旁的"Everything 诊断"按钮），1 秒轮询实时状态 + 测试搜索 + 实时日志
- Everything 不可用时静默回退索引搜索，并把原因通过 `everythingSearchUnavailable` 通知用户

**索引格式**：`<location>/.ts/tsi.json`（主索引）+ `.ts/tsft.jsonl`（全文索引），详见 `CLAUDE.md` 的 Indexing & Search 章节

### Everything 搜索调试战报（2026-08-16，6.15.0→6.15.9）

**当前状态（2026-08-19 更新）：渲染层展示问题已修复，待 Windows 实机验证。** 详见 `REPORT-2026-08-19-everything-renderer.md`。

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

### 原生依赖（koffi）打包注意事项

- koffi 的原生 `.node` 二进制按平台分包发布（`@koromix/koffi-<os>-<arch>`）。
- 在 macOS 上交叉打包 Windows/Linux 时，`npm install` 只会安装 darwin 平台包，导致目标平台
  运行时报 `Cannot find the native Koffi module`。
- 打包脚本已内置 `install-koffi-{win,linux}-{x64,arm64}` 步骤（调用
  `scripts/install-koffi-platform.js`），会在 `electron-builder` 前把目标平台的 koffi
  原生包强制安装到 `release/app/node_modules`。**打包前勿手动删除这些平台包**。
- 若新增其他带原生模块的依赖（如 wasm-vips、jszip 之外的 native 包），需同样确保
  目标平台的原生二进制被打入包内。
