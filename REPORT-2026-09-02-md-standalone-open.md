# 2026-09-02 单独打开 .md 文件体验优化

## 需求

优化默认打开 .md 文件的三项行为：

1. 打开单独 md 文件时不显示整个应用的文件夹列表和主页（欢迎面板）；
2. 单个已经打开的 .md 文件允许刷新；
3. 只读（查看）模式下点击文件内容任意处会直接进入编辑模式，应改为只有点击"编辑"按钮才进入。

## 改动清单（5 个源文件 + 2 个测试文件）

### 1. 单独打开文件时隐藏文件夹列表和主页

- **`src/renderer/containers/MainPage.tsx`**
  - 新增 `useCurrentLocationContext()` 取 `currentLocationId`；
  - 新增判定 `standaloneEntry = !!openedEntry && !currentLocationId`（有打开的文件但没有当前位置，即文件经 OS 文件关联 / cmdopen 单独打开）；
  - `fullWidthView = isEntryInFullWidth || standaloneEntry`，统一接管三处布局逻辑：
    - 抽屉关闭 effect：`fullWidthView` 为真时 `setDrawerOpened(false)`；
    - `hideSplit = !openedEntry || fullWidthView`；
    - Splitter `hiddenTake={fullWidthView ? 'secondary' : 'primary'}`（折叠文件夹区，文件视图占满窗口）。
- **`src/renderer/components/RenderPerspective.tsx`**
  - 欢迎面板显示条件追加 `!openedEntry`：
    `showWelcomePanel = !currentLocationId && !isSearchMode && !openedEntry`。
  - 兜底覆盖 `openDirectory` 失败 → `closeAllLocations()` 清空 location 后欢迎面板回显的路径。

### 2. 已打开文件支持刷新（新增工具栏按钮）

- **`src/renderer/components/EntryContainerNav.tsx`**
  - 新增 prop `reloadDocument: () => void`；
  - 在"下一文件"按钮后新增刷新按钮：`ReloadIcon`（CommonIcons 已有）+ tooltip `core:reloadFile`（locale key 已存在）+ 快捷键提示 `keyBindings.reloadDocument`，`data-tid="fileContainerReloadFile"`。
- **`src/renderer/components/EntryContainer.tsx`**
  - 给 `<EntryContainerNav>` 传入已有的 `reloadDocument`（`:448`，内部已正确处理编辑模式未保存修改的确认框；刷新经 `reloadOpenedFile()` 重新从磁盘读取属性，`lmdt` 变化驱动 iframe 重载，内容无应用层缓存）。

### 3. 查看模式双击不再进入编辑

- 根因：`.md` 查看器是 `@tagspaces/extensions/md-editor` 扩展（Milkdown Crepe），在 iframe 内 window 上绑定 `dblclick` → 向主程序 `postMessage({command:'editDocument'})`；主程序 `EntryContainer.tsx` 收到后只要 `editingSupported` 就 `setEditMode(true)`。扩展原生支持 URL 参数 `readonly`（`readOnly` prop 守卫 dblclick 监听），但主程序从不传。
- 修复：**`src/renderer/components/FileView.tsx`** 查看模式（else 分支）的 iframe URL 追加 `&readonly=true`。
  - 只加在查看分支：编辑分支带 `&edit=true`，若编辑模式 iframe 也拿到 `readonly=true` 会禁用编辑。
  - 其他 viewer 扩展对未知参数静默忽略，无副作用。

## 新增 e2e 用例

- **`tests/e2e/cmdopen.pw.e2e.js` → TST5106**：在 `os.tmpdir()` 创建 location 之外的独立 md 文件，经 `?cmdopen=` 打开后断言：
  - 文件正常打开（`OpenedTID`）；
  - 无欢迎面板（`WelcomePanelTID` detached）；
  - 抽屉关闭（`main.MainPage-contentShift`）；
  - 文件夹区被 Splitter 折叠（computed `grid-template-columns` 首列为 `0px`）。
  - 注意：不能用 `isVisible()` 检查 grid 内部元素——pane 的 `overflow:hidden` 裁剪后子元素仍保有非零 bounding box，会误判。
- **`tests/e2e/markdown-editor.pw.e2e.js` → TST6904**：查看模式下在 iframe 正文 `dblclick`，断言仍在查看模式（编辑按钮在、无 `contenteditable=true`）；再点编辑按钮断言进入编辑模式。
- **`tests/e2e/markdown-editor.pw.e2e.js` → TST6905**：外部覆写 `sample.md` 追加标记内容，点击工具栏刷新按钮，断言查看器显示新内容（`expectFileContain`）。

## 验收结果（2026-09-02，本机 macOS，electron-light 工程）

- `npm run type-check`（tsc --noEmit）通过；
- ESLint 改动文件无新增错误（存量告警不变，HEAD 对比 113 vs 113）；
- `npm run test-unit`：423 个单元测试全部通过；
- e2e：`cmdopen.pw.e2e.js` + `markdown-editor.pw.e2e.js` 共 8 通过 / 2 跳过 / 1 失败：
  - 新增 TST5106、TST6904、TST6905 全部通过；
  - 既有 TST5101/5104/5105、TST6901/6902 通过；
  - **TST6903（Save text）失败为存量问题**：已用未改动的 HEAD 构建做对照基线，无改动时按顺序跑同样失败（根因：TST6902 结束后文件停留在编辑模式，TST6903 等不到编辑按钮）。与本次改动无关，未处理。

## 测试环境备注（非代码改动）

- `tests/testdata` 完整克隆网络超时，改为手工放置最小集合（`file-structure/supported-filestypes/sample.md` + `empty_folder/`）。如需跑其他 e2e 文件，请先 `npm run test-clone-data` 补齐完整测试数据。
- Playwright 缺 `chromium_headless_shell-1208`（网络下载超时），用已缓存的 1228 版本复制顶替（`~/Library/Caches/ms-playwright/`）。该组件只在测试失败截图时被 `page` fixture 拉起，与 Electron 应用本身无关；网络恢复后建议 `npx playwright install chromium` 补齐正版。
