# Everything 全局搜索修复战报（2026-08-24）

## 背景

用户报告两个问题：① Everything 搜索不可用（dll 加载失败）；② 修复加载后搜索"有结果展示但同时报 `Cannot read properties of undefined (reading 'checkFileEncryptedPromise')`"，且部分查询结果不渲染。

## 根因与修复（共 7 处）

### A. Everything 不可用（上一轮已修，见 git 869feff）

1. **自带 SDK dll 损坏**：`.gitattributes` 的 `* text eol=lf` 让 autocrlf 在 checkout 时改写 dll 字节 → LoadLibrary 报 193。已加 `*.dll binary` 并重新入库官方 SDK dll。
2. **注册表中文路径乱码**：reg.exe 输出 OEM 码页文本被 execSync(utf8) 解码成 U+FFFD，`D:\软件\Everything` 永远探测不到。改为 koffi 直调 advapi32（RegOpenKeyExW/RegQueryValueExW/RegCloseKey）。
3. **RegQueryValueExW 的 cbData 是 in+out 参数**：声明成纯 koffi.out 会丢失容量初值，永远 ERROR_MORE_DATA。必须 `koffi.inout(koffi.pointer('uint32'))`。
4. **服务-only 安装误判**：Everything 以 `-svc` 服务运行在 session 0 时 tasklist 可见但本会话无 IPC 窗口；旧逻辑误判"进程在跑"不触发自动启动。改为 probeIpc 三分支：无窗口→拉起用户会话客户端 / SendMessage 被拦→UIPI 提示 / DB 未就绪→等待。

### B. 结果展示崩溃与不渲染（本轮）

5. **checkFileEncryptedPromise TypeError**
   - 触发链：全局搜索模式（无 currentDirectory）下视角回退 effect（FolderContainer.tsx:121）自动调 `setManualDirectoryPerspective` → `getAllPropertiesPromise(undefined)` → `findLocation(undefined)` 返回 undefined。
   - 修复：`getAllPropertiesPromise` 入口守卫（无 location/entryPath 时 reject 可读错误）；`setManualDirectoryPerspective` 无目录时仅内存记录、不写 meta。

6. **enhanceSearchEntry 返回 undefined 导致结果被覆盖**（核心显示 bug）
   - `enhanceSearchEntry` 对无 location / 无缩略图的条目返回 `undefined`（非 Promise）；`executePromisesInBatches` 把 undefined 透传进增强结果数组；随后 `updateCurrentDirEntries` 用这个残缺数组覆盖刚写入的完整搜索结果（mergeByPath 访问 undefined.path 还会抛被静默吞掉的异常）。全局搜索绝大多数条目无 location 归属，因此几乎全军覆没——fiber 实测 entries 只剩 2 条历史残留。
   - 修复：所有路径 `return Promise.resolve(entry)` 保底；`updateCurrentDirEntries` 恢复 undefined/null 过滤（纵深防御）。

7. **`ext:` 空过滤器吞掉全部结果**（最隐蔽）
   - `SearchTypeGroups.any = [""]`（空字符串数组表示"任意类型"）。`translateToEverythingQuery` 判断 `!includes('any')` 对 `[""]` 失效，拼出裸 `ext:` 过滤器——Everything 语义为"仅无扩展名文件"，全盘匹配只剩 2 个无扩展名文件。
   - 修复：拼接前过滤空串/占位值，空则不加 ext 子句。

## 调试方法论教训

- **CDP console 收集器跨 Page.reload 会静默失效**：reload 后必须重装（或直接用页面内 `console.log` 包装到 `window.__logs` 的钩子，100% 可靠）。本次曾据此误判"executeSearch 未执行"，绕了远路。
- **Electron 主进程 console.log 在 Windows 不写 stdout**（stderr 错误才可见），主进程观测不能依赖 stdout 重定向。
- **React fiber 挖掘是验证 context 运行时状态的利器**：从 DOM 元素 `__reactFiber$` 沿 return 链找 Provider 的 memoizedProps.value，直读 currentDirectoryEntries/isSearchMode，比日志推断快得多。
- **合成 input 事件对 MUI Autocomplete 受控组件有效**，但 CDP `Input.insertText` + 真实点击更接近人类操作，避免 isTrusted 相关差异。
- **gridCellDescription 不是可靠的渲染计数指标**（条件渲染），应数 `[data-entry-id]`。

## 验证（CDP 自动化，真实 UI 操作路径）

| 查询词 | 渲染格子 | 结果 |
|---|---|---|
| tagspace | 80 | PASS |
| everything | 93 | PASS |
| node.exe | 4 | PASS |
| 交付领域工具建设工作总结与计划 | 2 | PASS |
| zzzNoSuchTermQQQ123（无结果词） | 0 空态 | PASS |

全程 Runtime.exceptionThrown = 0。

## 改动文件

- `.gitattributes` — 加 `*.dll binary`
- `resources/everything/*.dll` — 官方 SDK 替换
- `src/main/everythingSdk.ts` — koffi 原生注册表读取（inout 修正）、服务 ImagePath 探测、IPC 三分支判定
- `src/main/mainEvents.ts` — （调试日志已清理，无净变更则不提交）
- `src/renderer/services/everythingSearch.ts` — ext: 空过滤器修复
- `src/renderer/hooks/LocationIndexContextProvider.tsx` — enhanceSearchEntry 保底返回
- `src/renderer/hooks/DirectoryContentContextProvider.tsx` — getAllPropertiesPromise 守卫、setManualDirectoryPerspective 无目录守卫、updateCurrentDirEntries 过滤
