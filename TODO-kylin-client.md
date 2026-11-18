# TODO: 麒麟操作系统客户端打包（等待 CPU 型号）

- 状态：**等待用户提供麒麟机器 CPU 型号**
- 创建：2026-11-15
- 触发条件：用户告知目标机器的 CPU 型号 / 架构（最好同时给出下文三条命令的输出）

## 需求（用户 2026-11-15 提出）

出一个麒麟操作系统上可用的 TagSpaces 客户端，必须具备：

1. **文件夹浏览能力**：能打开本地目录，在 grid / list / notes 视角中浏览文件夹内容。
2. **调用系统命令打开文件**：能对文件夹里的文件（含二进制文件）使用系统默认程序打开
   （现有实现即文件菜单 / 右键的 *Open File Natively*，快捷键 `Ctrl/Cmd + Enter`，
   主进程走 `shell.openPath`，见 `src/main/mainEvents.ts:795`、
   `src/renderer/components/EntryContainerMenu.tsx:389`）。

这两项现有代码已经具备，正常情况下**不需要改代码**，任务主体是「选对架构、构建、实机验收」。

## 第一步：确认目标环境（用户提供后填写）

```bash
uname -m                    # x86_64 / aarch64 / loongarch64 / sw_64
cat /etc/os-release         # 麒麟具体版本（桌面 V10 / V10 SP1 / 其他）
ldd --version | head -1     # glibc 版本
```

已知约束：Electron 42.4.0 的 Linux 预编译二进制最高只依赖 **GLIBC_2.25**
（已实测 x64 / arm64）；银河麒麟桌面 V10 SP1 为 glibc 2.31，满足要求。

- [ ] CPU 型号：______
- [ ] 架构：______
- [ ] 系统版本：______
- [ ] glibc 版本：______

## 第二步：按架构选择方案

| 架构 | 结论 | 动作 |
|---|---|---|
| x86_64（兆芯 / 海光 / Intel / AMD） | 直接可用 | 交付 `tagspaces-linux-amd64-*.deb` / `x64.tar.gz` |
| aarch64（飞腾 / 鲲鹏） | 直接可用 | 交付 `tagspaces-linux-arm64-*.deb` / `arm64.tar.gz` |
| loongarch64（龙芯 3A5000/3A6000） | 官方 Electron 无产物 | 需评估龙芯 Electron 移植版（改 `electronDist` / 自定义 `electronVersion`），工作量与风险都要先与用户确认 |
| sw_64（申威） | 不支持 | 告知用户；建议改走 Web 版（`npm run package-web`） |

## 第三步：构建（当前版本 6.23.0）

2026-11-15 已交叉构建过一次，产物在 `../builds/`（macOS 交叉构建，**未在麒麟实机验证**）：

```
tagspaces-linux-amd64-6.23.0.deb    134M  9de8ef2db96531a3ca02793a2b5db0bbb40fbcd1faeec94ac1f6c1085008454b
tagspaces-linux-arm64-6.23.0.deb    128M  747f147931206e0147d779dc016eac435c969a1dad659ac6ea20dd22e638c840
tagspaces-linux-x64-6.23.0.tar.gz   162M  2fd43fb6c55d3939e36d256cfe3966082b250ea4643bebc4097044ce46c0d450
tagspaces-linux-arm64-6.23.0.tar.gz 160M  08435a250e1be8e44b2ae61733367ffde374752c372654ab6ee4a3b98fa471df
```

复现命令（代码有改动则先按 AGENTS.md 版本规则 bump 版本号）：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run build
npx electron-builder --linux deb --x64 --config resources/builder.json
npx electron-builder --linux deb --arm64 --config resources/builder.json
npx electron-builder --linux tar.gz --x64 --config resources/builder.json
npx electron-builder --linux tar.gz --arm64 --config resources/builder.json
```

**已知坑（2026-11-15 实测）**：一次性并行多目标（deb + tar.gz，x64 + arm64）时
deb 阶段报 `Cannot cleanup / app-builder exit code 1`；按架构、按目标分开执行则成功。
AppImage 目标在 macOS 上未验证。

若目标机器能装 Node 环境，**优先在麒麟机器上原生构建**（`npm run package-linux`），
产物与系统 glibc 天然对齐，也便于当场验证。

## 第四步：麒麟实机验收清单

- [ ] `sudo dpkg -i tagspaces-linux-amd64-6.23.0.deb` 安装成功（含桌面图标、`tagspaces` 命令）
- [ ] 启动无 sandbox 报错（deb 的 postinst 已处理 `chrome-sandbox` 权限）
- [ ] 打开本地文件夹，grid / list 视角正常渲染文件（含二进制文件条目）
- [ ] 选中 `.pdf` / `.docx` / `.mp4` 等，走 *Open File Natively* 能用系统默认程序打开
- [ ] 选中 `.dll` / `.so` / `.bin` 等无内置查看器的文件，同样能走 *Open File Natively*
- [ ] 浏览器内双击默认打开内部查看器（不是系统程序），符合预期
- [ ] 中文输入法、中文字体渲染正常（异常时 `GTK_IM_MODULE=fcitx` 启动）
- [ ] 国产显卡驱动下界面正常（异常时加 `--disable-gpu`）
- [ ] 托盘图标（如启用）：缺 `libappindicator3-1` 时补装

排查命令：`./tagspaces --no-sandbox`、`ls -l /opt/TagSpaces/chrome-sandbox`、
`dpkg -s libgtk-3-0 libnss3 libxss1 libatspi2.0-0 libsecret-1-0`。

## 待决策

- [ ] 若用户要求「用指定命令（而非系统默认程序）打开文件」，需要新增可配置的外部打开命令，
      现状只支持 `shell.openPath`（系统默认关联程序）。
- [ ] 龙芯机器是否接受 Electron 移植方案（成本较高，需先评估再动手）。
