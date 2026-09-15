# 后端化迁移计划书（Rust 性能优化）

> 状态：草案 / 日期：2026-09-13 / 范围：只规划不改代码
> 目标：将前端计算密集、IO 密集的逻辑搬到 Rust 后端，提升整体速度，
> 保持适配器配置层在 TS，MCP/AI 语义层不动。

## 1. 现状与瓶颈

- 安装/导入管线全在前端逐文件串行 IPC（`src/lib/Manager.ts`、`FileHandler.ts`、
  `local-mod-import.ts`、`gmm-package.ts`）：每个文件多次 invoke
  （建父目录→判存在→备份→拷贝），大 Mod 即 N 倍 round-trip。
- `FileHandler.getFileMd5` 全量读进 JS 再 `js-md5`；`readFileAsBase64`
  用 `btoa(String.fromCharCode(...data))`，大文件爆栈/爆内存。
- 递归枚举 `getAllFilesInFolder` 串行 `readDir`，卸载/扫描重复遍历。
- 下载进度靠 `gloss-download-monitor.ts` 定时全量拉快照（轮询）。
- INI/TXT/XML 配置读改写无锁（Starfield/Bethesda、`REEngine` pakList、
  `RDR2` mods.xml、`BG3` modsettings.lsx），并发易丢条目。
- `createLink` 每目录 spawn powershell，默认退化成拷贝。
- 附带 bug：`Expands/EldenRing.ts` 内 `some(async…)` 恒假；
  `Expands/DyingLight2.ts` 内 `filter(async…)` 恒真。

后端已有基础（`src-tauri/src/`）：`lib.rs` 注册 20 个 command；
`downloader.rs` 进程内下载注册表（aria2 兼容快照）；
`mcp_server.rs` 回环 HTTP 桥（传输+鉴权在 Rust，业务语义在前端——保持）。

## 2. 迁移清单

### P0（必做，收益最大）

| # | 内容 | 现状位置 | Rust 方案 |
|---|------|----------|-----------|
| 1 | 安装/卸载批量化 | `Manager.ts`、`FileHandler.ts` | `mod_install_batch(files, backup)` / `mod_uninstall_batch`：一次 invoke 传文件表，后端 `walkdir`+`fs_extra` 执行，进度经事件回推；`checkModType` 表驱动下沉并修复两处 async 谓词 bug |
| 2 | 流式哈希 | `FileHandler.ts:626-650,1092` | `fs_file_hash(path, algo)`（blake3/sha256 流式，O(1) 内存）；图片改 `asset://` 直出，删除 base64 中转 |
| 3 | 递归枚举单次化 | `FileHandler.getAllFilesInFolder` 系 | `fs_walk(dir) -> [{rel, size, is_dir}]`，后端 `walkdir` 一次扫完 |

### P1（建议做）

| # | 内容 | 现状位置 | Rust 方案 |
|---|------|----------|-----------|
| 4 | 下载事件推送 | `gloss-download-monitor.ts:285-302` | Rust 0.5s 节流 `emit("dl-progress", delta)` + 终局事件，保持 aria2 快照形状兼容 |
| 5 | 配置原子写 | Starfield/BG3/RDR2/REEngine | `cfg_upsert(path, kind, entries)`：文件锁 + 写 tmp 再 rename；BG3 DOM 改 `quick-xml` |
| 6 | 游戏扫描下沉 | `scan-game.ts:113-155` | `scan_steam_libraries()`（含注册表读路径），删全量 `console.log` |
| 7 | symlink 直调 | `FileHandler.createLink` | `std::os::windows::fs::symlink_*` 直调，省 powershell spawning；退化拷贝改显式选项 |

### 不搬（明确非目标）

- `stores/ai-chat.ts`、`mcp-service.ts`：语义层在前端是有意设计，无性能收益。
- 下载队列状态机：瓶颈在轮询（见 P1-4）而非位置。
- 140+ Expands 适配器声明：纯配置，保留 TS 方便社区贡献；只下沉其中 6 处真解析。
- `download.vue` 大列表：用虚拟列表解决，不是后端问题。

## 3. 落地顺序

1. `fs_walk` + `fs_file_hash`（底座，最小可验证）。
2. `mod_install_batch`（收益最大，依赖底座验证）。
3. 下载事件推送。
4. 配置原子写 / 游戏扫描。

## 4. Command 接口草案

```rust
// 底座
fs_walk(dir: String) -> Vec<WalkEntry { rel: String, size: u64, is_dir: bool }>
fs_file_hash(path: String, algo: String) -> String   // "blake3" | "sha256"

// 批量安装
mod_install_batch(req: InstallBatch {
  items: Vec<InstallItem { src: String, dst: String, op: String }>, // op: copy|link|mkdir
  backup: bool,
}) -> InstallReport { ok: u32, failed: Vec<InstallError> }
// 进度事件： "mod-install-progress" { done: u32, total: u32 }
// 终局随 command 返回值；失败项回滚已执行 op。

mod_uninstall_batch(req: UninstallBatch {
  paths: Vec<String>,
  restore_backup: bool,
}) -> InstallReport

// 类型判定（表驱动，替代前端逐文件 IPC + 修复 async 谓词 bug）
mod_classify(files: Vec<String>, rules: ClassifyRules) -> i32

// 配置原子写
cfg_upsert(path: String, kind: String, entries: Map<String, String>) -> ()
// kind: "ini" | "txt-lines" | "pak-list" | "lsx" | "mods-xml"

// 扫描
scan_steam_libraries() -> Vec<SteamLibrary { path: String, app_ids: Vec<u32> }>

// 下载增量推送（事件）
/// "dl-progress" { gid: String, completed: String, speed: String }
/// "dl-done" { gid: String, status: String }
```

前端保留：适配器声明（140+ Expands）、队列视图合并、MCP/AI 语义。

## 5. 验收标准

- 基线：1GB 包导入 + 安装耗时，搬前后对比（同一机器同一包）。
- `fs_walk` / `fs_file_hash`：与前端旧实现结果一致（路径表、哈希值）。
- `mod_install_batch`：成功/失败回滚语义与旧逐文件逻辑一致；两处 async 谓词 bug 修复。
- 下载推送：终局状态与轮询快照一致，无丢事件。
- 全程 `yarn tauri build` 无编译错误；不引入新前端依赖。
