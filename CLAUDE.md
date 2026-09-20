# CLAUDE.md

本文件为 Claude Code（claude.ai/code）在本仓库工作时提供指导。

## 项目简介

Gloss Mod Manager（GMM）是跨平台（Windows/macOS/Linux）桌面应用，用于浏览、下载、安装和管理游戏 Mod。内置 AI 聊天助手，通过嵌入式 MCP 服务器直接操作应用本体。V2 是 V1 的完整重写，目标是减小安装体积并增加 AI/MCP/Skills 能力；与 V1 保持数据兼容（Mod 列表、游戏列表、自定义游戏、标签分类、备份）。

## 命令

```bash
bun dev              # vite 开发服务器（仅前端，无 Tauri 窗口）
bun tauri dev         # 完整应用开发模式（Rust + 前端）
bun build             # 先 vue-tsc --noEmit 类型检查，再 vite build
bun tauri build       # 完整生产构建（前后端改动后运行此命令验证无编译错误）
bun preview           # 预览前端生产构建
```

`package.json` 中没有配置 lint 或 test 脚本——本仓库目前没有 ESLint/Prettier/Vitest，排查失败时不要假设它们存在。

`predev`/`prebuild`/`pretauri` 钩子会自动运行 `scripts/sync-version.ts`（同步 `package.json`/`Cargo.toml` 等处的版本号）和 `scripts/prepare-sidecars.ts`（将 bundled 外部二进制文件 staged 到 `src-tauri/binaries/`）——执行 `dev`/`build`/`tauri` 命令前无需手动运行。

## 架构

### Rust 与 TypeScript 分工

Rust 侧（`src-tauri/`）负责原生 OS 能力（文件系统、stronghold 加密存储、单实例、deep-link/文件关联处理、自启动、窗口状态、日志）加一个 raw-socket MCP 传输桥。业务逻辑默认在 TypeScript 中实现；有性能需求务必使用 Rust。

### Expands：按游戏的 Mod 安装逻辑（`src/Expands/`）

每个受支持游戏对应 `src/Expands/` 下的一个文件，导出异步 `supportedGames(): Promise<ISupportedGames>`。文件由 `src/Expands/index.ts` 中的 `import.meta.glob("./*.ts", { eager: true })` 自动发现——新增游戏只需往该目录丢一个新文件，无需更新中央注册表。

每个游戏的 `modType` 可以是完整自定义 `IType[]` 数组（每个类型自带 `install`/`uninstall` 实现），也可以委托给共享的引擎通用逻辑：
- `src/lib/UnityGame.ts`——通用 Unity Mod 安装逻辑
- `src/lib/UnrealEngine.ts`——通用 Unreal Engine 安装逻辑（处理 pak/UE4SS Mod 布局）

多数 Expand 文件使用 `Manager.checkInstalled`、`Manager.getModStoragePath`、`Manager.generalInstall`/`generalUninstall` 和 `FileHandler.*` 辅助函数（`src/lib/Manager.ts`、`src/lib/FileHandler.ts`），而不是手写文件拷贝逻辑。新增游戏前先看一个现有的 Expand 文件（例如 `EldenRing.ts`）——多数游戏是同一形状（基于字典文件的 Mod 到路径映射、`modType` 列表、可选 `checkModType` 分类器）。

V1 遗留自定义游戏/类型（用户自定义，非内置 Expand 文件）由 `src/lib/legacy-custom-data.ts` 在运行时合并，通过 `getAllExpands()` 与内置 Expands 列表汇合。

整个系统的全局 ambient 类型定义（`ISupportedGames`、`IType`、`IModInfo`、`IGameInfo`、`ISettings`、各 Mod 源接口如 `IThunderstoreMod`/`ISteamWorkshopItem`/`ICurseForgeMod`/`IGitHubRelease`/`IGameBananaMod`/`INexusMods` 等）位于 `src/ts/Interfaces.d.ts`——单个无 import/export 的 ambient `.d.ts`，所有类型全局可用，无需 import。

### MCP 服务器：Rust 只做传输

`src-tauri/src/mcp_server.rs` 直接基于 `TcpListener` 手写 HTTP/1.1 服务端（无 HTTP crate），仅绑定 `127.0.0.1`。它不实现任何 MCP 协议逻辑——接受 POST 到 `/mcp`，发出 `mcp-http-request` Tauri 事件携带请求体，然后阻塞（60s 超时）等待前端回调 `mcp_complete_request` 命令返回状态码和 body。真正的 JSON-RPC/MCP 协议处理和工具分发全在 `src/lib/mcp-service.ts`。改 MCP 行为（加工具、改返回）几乎总是改 `mcp-service.ts`，不是 Rust。

### Skills（`src/skills/*/SKILL.md`）

这些是运行时工作流文档，供应用内 AI 助手消费（与 Claude Code 的 skill 系统是两回事）——中文编写，每个工作流按 `mcp-service.ts` 暴露的 MCP 工具名描述（例如 `mcp_gloss-mod-man_add-game-to-manager`）。新增代表多步用户工作流的 MCP 工具时，考虑是否需要新增或更新对应的 SKILL.md。

### 前端结构

- 基于 `unplugin-vue-router` 的文件路由：页面在 `src/pages/*.vue`，经 `vue-router/auto-routes`（`src/routes/index.ts`）自动注册为路由；没有手动路由表可改。
- 状态用 `src/stores/` 下的 Pinia stores 管理（例如 `manager.ts` 管当前管理游戏/Mod 状态，`settings.ts`、`ai-chat.ts`）。注意 `src/stores/manager.ts`（Pinia store）与 `src/lib/Manager.ts`（安装/卸载/标签工具静态类）是两个东西——不要混淆。
- `vite.config.ts` 配置了自动导入：Vue/vue-router/@vueuse/core/pinia API，以及 `src/lib/` 和 `src/stores/` 导出的所有内容，均可不写 import 直接使用。`src/components/ui` 和 `src/components/` 下的组件自动注册；任何以 `Icon` 开头的组件名解析到 `lucide-vue-next`。
- UI 优先用 shadcn-vue 组件（基于 reka-ui，Tailwind v4 样式），而不是手写自定义组件。
- i18n：`src/lang/*.ts`（每种语言一个文件）加 `src/lang/index.ts`/`locales.ts`。新增用户可见字符串要加到所有语言文件，至少 `zh_CN.ts`（源语言）和 `en_US.ts`。

### 下载与外部工具

- 内置下载器负责实际文件下载（不再依赖外部 aria2 进程）。
- Sidecar 二进制（随应用 bundled 的外部工具可执行文件，由 `scripts/prepare-sidecars.ts` staged 到 `src-tauri/binaries/`）经 `src/lib/sidecar.ts` 调用。`sevenZip.ts` 和 `dotnet-tool.ts` 封装了特定的 bundled 工具。
- Mod 源按平台逐个集成：NexusMods、Thunderstore、Mod.io、SteamWorkshop、CurseForge、GitHub、GameBanana，加原生 GlossMod 平台（`gloss-mod-api.ts`、`gloss-download-queue.ts`）。每个源在 `Interfaces.d.ts` 有自己的接口集，在 `src/lib/` 有自己的 API 客户端。
- 自定义 URI/文件处理：`gmm://` 和 `nxm://`（Nexus Mods 下载协议）URI、`.gmm` 文件关联，在 Rust 侧 `src-tauri/src/lib.rs`（`normalize_file_launch_arg`）解析，经 `app-launch-files` 事件 / `app_take_pending_launch_files` 命令透给前端。

## 代码风格

完整规则见 `CodeStyle.md`——以下为工具链不强制的关键点（未配置 linter）：
- 类 PascalCase，变量/函数 camelCase，文件名 kebab-case。
- 接口前缀 `I`（如 `IModInfo`），枚举前缀 `E`，类型别名/泛型 PascalCase。
- 变量声明一律显式标注类型；避免 `any`。
- 用 `const` 不用 `readonly`；每个模块一个 import；禁用 namespace（用 ES6 import/export）。
- 注释用中文写，在代码看不出"为什么"时按作者判断添加——这是本仓库现有惯例，加注释时遵循。
- 4 空格缩进，左大括号不换行，模板字符串优先于拼接，优先解构。

来自 `.github/copilot-instructions.md`：
- 本项目目标是 Tauri 2.0——改 Tauri 相关代码前先查 Tauri JS API 和插件文档，API 与 Tauri 1.x 不同。
- 改完后运行 `bun tauri build` 确认无编译错误。
