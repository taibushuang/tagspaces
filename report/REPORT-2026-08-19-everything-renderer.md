# Everything 搜索结果不显示 — 渲染层修复报告

日期：2026-08-19
前置状态：见 `AGENTS.md` 战报（2026-08-16）——主进程链路已打通（查询/计数/路径提取全部正确），剩余 bug：渲染进程不显示结果列表。

## 排查结论

对 AGENTS.md 战报中列出的 3 个排查方向逐一核实，并从 `currentDirectoryEntries` 到屏幕渲染做了完整链路审查：

| 战报排查点 | 结论 |
|---|---|
| 1. `convertToFileSystemEntry` 产物（uuid/locationID undefined）导致 RowCell 崩溃 | **部分确认**：RowCell（列表透视）全程有 `?.` 保护，安全；但 **GridCell（网格透视）存在真实崩溃点**（见下 A1/A2），且 undefined 字段会触发排序函数崩溃（A3/A4） |
| 2. `setSearchResults` 被 `isSearchMode.current` 门控 | **排除**：`setSearchQuery` 在发起搜索前同步将 `isSearchMode.current = true`，门控时序无问题 |
| 3. `enhanceSearchEntry` 对无 location 条目返回 `undefined` | **排除（无害）**：`mergeByPath` → `buildMetaLookup` 有 `if (!entry) continue` 保护，且 `updateCurrentDirEntries(entriesEnhanced, false)` 不触发 path 检查 |

链路审查新发现（按嫌疑度排序）：

### A. 崩溃点（抛异常 → PerspectiveBoundary 接管，界面近似空白）

- **A1（首要嫌疑）`GridCell.tsx:338`**：`gridCellLocation.isReadOnly` 无空值保护。`findLocation(undefined)` 会回退到当前 location；**当没有打开的 location 时回退结果为 undefined → TypeError**。触发条件：Everything 未匹配条目（locationID undefined）+ 无当前 location。
- **A2 `GridCell.tsx:264`**：早退 `return null` 位于多个 hooks 之前，违反 rules of hooks。条件翻转时 React 报 "Rendered fewer hooks than expected" 直接崩溃。
- **A3 `tagspaces-common/misc.js:982 sortByExtension`**：`a.extension.toString()` 无空值保护。旧形态 Everything 结果目录条目 `extension: undefined`，与文件混排时必崩。已实测复现：`Cannot read properties of undefined (reading 'toString')`。
- **A4 `tagspaces-common/misc.js:991 sortByFirstTag`**：`a.tags.length` 在 `a.tags === undefined && b.tags !== undefined` 时求值崩溃。Everything 结果天然是 tags 有/无混合数组（索引命中条目才有 tags）。已实测复现。

### B. 静默丢弃 / 列表为空

- **B1（核心根因）`RenderPerspective.tsx:284`**：`showWelcomePanel = !currentLocationId`。**没有打开的 location 时，透视区直接渲染 WelcomePanel 或 null，搜索结果永远不渲染**。这正是"主进程返回正确结果但 UI 空白"的最直接解释：零/未打开 location 场景下全局搜索（`searchLocationIndex` 在 `!currentLocation` 时转 `searchAllLocations`）结果写入成功但被遮挡。
- **B4 `SortedDirContextProvider.tsx:102`**：残留 `searchFilter`（`filter:` 动作设置，仅 `exitSearchMode`/`loadDirectorySuccess` 清除）会把新搜索结果按旧关键字过滤光。

### C. uuid undefined 次生问题（不崩溃，功能受损）

框选（marquee）按 `data-entry-id={uuid}` 查 DOM，uuid undefined 的条目永久无法框选；openedEntry 滚动定位失效；`enhanceSearchEntries` 后 `buildMetaLookup` 给无 id 的 meta 注入随机 `getUuid()`，`mergeByPath` 将其覆盖为条目 uuid → 身份每次 enhance 都变。

## 修复清单

| # | 文件 | 修改 |
|---|---|---|
| 1 | `src/renderer/components/RenderPerspective.tsx` | `showWelcomePanel = !currentLocationId && !isSearchMode` —— 搜索模式下即使没有打开的 location 也渲染透视结果（修 B1） |
| 2 | `src/renderer/perspectives/grid/components/GridCell.tsx` | ① `gridCellLocation.isReadOnly` → `gridCellLocation?.isReadOnly`（修 A1）；② 264 行的早退 `return null` 移到所有 hooks 之后、最终 `return` 之前（修 A2） |
| 3 | `src/renderer/services/everythingSearch.ts` | `convertToFileSystemEntry` 数据加固：`uuid: getUuid()`、`tags: []`、目录 `extension: ''`（修 A3/A4/C，从数据源消除 undefined 字段） |
| 4 | `src/renderer/hooks/DirectoryContentContextProvider.tsx` | `setSearchQuery` 进入搜索模式时 `dispatch(AppActions.setSearchFilter(undefined))` 清除残留过滤器（修 B4，对索引搜索同样生效） |
| 5 | `src/renderer/services/utils-io.ts` | `mergeByPath`：`uuid` 覆盖改为 `extraMeta.id && !e.uuid` 时才生效，避免 enhance 过程把已有 uuid 覆盖成随机 id（修 C 身份抖动） |
| 6 | `src/renderer/perspectives/list/components/RowCell.tsx` | 缩略图 `src` 拼接处 `currentLocation.haveObjectStoreSupport()` → `currentLocation?.`（防御：带缩略图元数据的条目 + 无当前 location） |
| 7 | `src/main/mainEvents.ts` | `const progress = {}` → `Record<string, any>`，修复 5 个存量 TS2339 类型错误（ Everything 工作期间引入，`type-check` 现全绿） |

## 本地验证

- ✅ `tsc --noEmit`：0 错误（修复前 5 个存量错误在 mainEvents.ts）
- ✅ 单元测试：414 passed（`playwright.unit.js`）
- ✅ 排序崩溃实测（node 直接调 `tagspaces-common/misc` 的 `sortByCriteria`）：
  - 旧形态（`extension: undefined` / `tags: undefined` 混合）：`byExtension`、`byFirstTag` 均崩溃
  - 新形态（`extension: ''` / `tags: []`）：两种排序正常输出

## 待 Windows 实机验证

1. 无打开的 location → 全局搜索 → 结果列表应直接显示（此前空白）
2. 有 location + 网格透视 + 结果含未匹配系统文件 → 不再崩溃
3. localStorage 持久化了 `byExtension`/`byFirstTag` 排序的场景 → 不再崩溃
4. 崩溃时应能看到 `data-tid="errorBoundaryTID"` 的 Alert；若仍空白，开 DevTools 看 console 是否有 `ErrorBoundary caught: Perspective ...`

## 遗留（本次未修）

- `tagspaces-common/misc.js` 的 `sortByExtension`/`sortByFirstTag` 空值地雷对**普通目录列表**仍存在（node_modules 内，上游包）。Everything 路径已通过数据加固绕开。
- `ListCellsContainer.tsx` 为死代码（无任何引用），未清理。
