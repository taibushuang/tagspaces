# 待处理问题：文件版本清理（File Version Cleanup）方案与代码审查

日期：2026-08-19
状态：**P0/P1 主要问题已修复**（2026-08-19 第二轮，方案经用户讨论确认），P2 部分遗留
涉及文件：
- `src/renderer/utils/fileVersionGrouper.ts`
- `src/renderer/components/dialogs/FileVersionCleanupDialog.tsx`
- `src/renderer/components/dialogs/hooks/FileVersionCleanupDialogContextProvider.tsx`
- `src/renderer/perspectives/grid/components/MainToolbar.tsx`（工具栏入口）
- `src/renderer/locales/en/core.json` / `zh_CN/core.json`
- `tests/unit/fileVersionGrouper.test.js`

## 总体结论

代码质量不错（Context 模式与项目一致、dialog lazy 加载、单测 20 例齐全、删除/移动复用会连带处理 `.ts` 元数据+缩略图+revisions 的 `deleteEntries`/`moveFiles`），但**方案层面有会导致误删/误移动的严重问题**，修复前不建议在真实数据上广泛使用。

---

## ✅ 已修复（2026-08-19 第二轮，经用户讨论确认的方案）

**检测层（`fileVersionGrouper.ts`）**：
- 文件类型白名单：MS Office（doc/docx/xls/xlsx/ppt/pptx）+ WPS（wps/et/dps）+ ODF（odt/ods/odp）
- 基础名加权长度 ≥ 12（CJK 字符算 2，即 ≥6 汉字或 ≥12 ASCII）——排除 IMG/a/b 类短名
- 无 `v` 前缀时排除前导零（`0001` 序号）和 4 位年份（19xx/20xx）；带 `v` 前缀（如 `报告-v2024`）仍识别
- 正则改为 `/[-_\s(](v)?(\d+(?:\.\d+)*)[-_\s)]?$/i`，group 1 捕获 v 前缀用于上述守卫

**处置层（`FileVersionCleanupDialog.tsx`）**：
- **逐组确认**：每组一个"确认清理此文件的旧版本"按钮，点击即执行该组；移除全局一键执行按钮
- 移动保留文件改为 checkbox（`versionCleanupMoveKept`），**默认关闭**；目标目录 = 该组最新版本所在目录；跨 location 按 locationID 分组调用 moveFiles
- 护栏：组内至少保留 1 个版本才能执行；组内文件 location 不可解析时禁用执行并提示；executingGroup 防双击
- 执行成功后该组从列表移除；删除失败（deleteEntries 返回 false）不移除、不报成功
- 修复 `versionCleanupSuccess` i18n 占位符（{deleted}/{moved}），`formatDate` 空值保护
- 工具栏按钮在无选中文件时隐藏（`MainToolbar.tsx`）

**测试**：`tests/unit/fileVersionGrouper.test.js` 重写为 27 例，覆盖全部新守卫（短名/CJK 加权/类型白名单/前导零/年份/v2024 放行）。`tsc --noEmit` 0 错误，全量单测 423 通过。

## 遗留（P2）

- keepCount 固定为 2，UI 不可调（grouper 已支持参数）
- Dialog 内本地实现的 `formatFileSize`/`formatDate` 与 `@tagspaces/tagspaces-common/misc` 重复
- 跨目录分组保留（输入是用户手动选中的条目 + 逐组确认 + 移动默认关闭，风险可控）

---

## 原始审查记录（2026-08-19 第一轮）

## P0 — 严重问题

### 1. 版本正则误报（最高危）

`fileVersionGrouper.ts:35`：`/[-_\s(]v?(\d+(?:\.\d+)*)[-_\s)]?$/i` 中 `v?` 可选，导致任何以"分隔符+数字"结尾的文件名都被当成版本。已实测复现：

```
IMG_0001       -> base="IMG"      ver=0001   ← 相机连号照片
report-2024    -> base="report"   ver=2024   ← 年份
meeting 2024   -> base="meeting"  ver=2024
budget (2024)  -> base="budget"   ver=2024
file-1         -> base="file"     ver=1
```

后果：`IMG_0001.jpg`～`IMG_9999.jpg` 会被归为一组，默认保留 2 张、其余全部标记删除。

**修复方案**：正则要求显式 `v` 前缀（如 `[-_\s(]v(\d+(?:\.\d+)*)[-_\s)]?$`），或对无 `v` 前缀的纯数字加限制（排除 4 位年份 19xx/20xx、排除 ≥4 位纯数字编号）。修复后需同步更新单测和 AGENTS.md 中的模式说明。

### 2. 跨目录分组 + 强制移动保留文件

- 分组 key 只有 `baseName.ext`，**不含目录**——`/projectA/report-v1.docx` 与 `/projectB/report-v2.docx` 被当成同一系列（单测 `'handles files in different directories'` 把该行为固化为预期，需一并改）。
- `FileVersionCleanupDialog.tsx:128-136`：执行清理时**所有保留文件被强制移动**到 targetDir（第一组第一个保留文件所在目录），targetDir 只读不可改、移动不可关闭。
- 同组不同目录下的同名文件移动到同一 targetDir 会**文件名冲突**，`moveFiles(force=false)` 行为未定义。

**修复方案**：① 分组 key 加入目录路径（`extractContainingDirectoryPath`）；② "移动保留文件到统一目录"改为 checkbox，**默认关闭**。

---

## P1 — 中等问题

### 3. 无当前 location 时"执行清理"静默无效

`FileVersionCleanupDialog.tsx:112-113`：`findLocation()` 无参取当前 location，没有时直接 `return`，无提示。注意：2026-08-19 修复 RenderPerspective B1 后，"无 location 全局搜索"已能显示结果，此场景更易触发。
另外多 location 的搜索结果统一用当前 location 的 uuid 调 `moveFiles`，跨 location 移动是错的（`deleteEntries` 内部按 `entry.locationID` 各自找 location，无此问题）。

**修复方案**：无 location 时禁用执行按钮或 toast 提示；`moveFiles` 按 entry.locationID 分组执行。

### 4. i18n 占位符不匹配

`versionCleanupSuccess` 调用传了 `{deleted, moved}`，但 en/zh_CN 文案均无占位符，数量信息丢失。

### 5. 无"至少保留一个"护栏

可把一组内所有文件（含最新版）都切成"删除"，手滑即全删。建议组内至少保留 1 个。

### 6. 删除风险提示不足

删除走 `useTrashCan` 设置（正确），但对话框未提示删除是否进回收站，破坏性操作确认信息不足。

---

## P2 — 轻微问题

7. `formatDate(file.lmdt)`：lmdt 缺失时显示 "Invalid Date"。
8. keepCount 固定为 2，UI 不可调（grouper 已支持参数）。
9. 未选中文件时工具栏按钮仍可点击，弹出空对话框。
10. `deleteEntries` 返回的 boolean 未检查，删除失败仍继续移动并报"成功"。
11. Dialog 内本地实现的 `formatFileSize`/`formatDate` 与 `@tagspaces/tagspaces-common/misc` 重复。
