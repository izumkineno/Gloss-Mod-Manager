//! 本地 Mod 导入后端化：解压/复制/落盘/mod.json 读写/导入态对账，全在 Rust 侧一次命令完成。
//!
//! 背景：前端导入链路每个文件多次 IPC（walk→逐文件 copy→逐文件读→写 mod.json），
//! 大 Mod 几千文件即几万次往返；刷新导入态还要再读一次本地列表。搬后端后：
//! - `mod_import_prepare`：清暂存目录→解压/复制→walk 取清单→探测 FOMOD，一次返回。
//! - `mod_import_commit`：FOMOD 裁剪→落盘→写 mod.json/tags.json，一次返回新 mod。
//! - `mod_import_task`：下载任务一键导入（无 FOMOD 快捷路径，有则返回需向导）。
//! - `mod_import_sync_status`：重读本地 mod.json，对账 download_meta 的 localModId。
//!
//! 日志：target="backend"，tag="[导入]"，每步 info（含文件数/耗时），失败 warn（含首项），
//! 与 fsops 的 `[导入] 目录拷贝完成` 同格式，方便按 tag 过滤定位慢点。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Instant;

/// 导入源类型：对齐前端 LocalModImportSourceType。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSource {
    pub path: String,
    pub source_type: String,
    pub file_name: Option<String>,
}

/// 导入元数据：对齐前端 importMetadata（buildImportedMod 所需字段子集）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportMetadata {
    pub mod_name: Option<String>,
    pub file_name: Option<String>,
    pub mod_version: Option<String>,
    pub mod_author: Option<String>,
    pub mod_website: Option<String>,
    pub mod_desc: Option<String>,
    pub cover: Option<String>,
    pub from: Option<String>,
    pub web_id: Option<serde_json::Value>,
    pub game_id: Option<serde_json::Value>,
    pub mod_type: Option<serde_json::Value>,
    pub tags: Option<Vec<serde_json::Value>>,
    pub other: Option<serde_json::Value>,
    pub external_id: Option<serde_json::Value>,
    pub mod_id: Option<serde_json::Value>,
}

/// prepare 返回：暂存目录 + 文件清单 + FOMOD 配置（有则前端弹窗）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPrepareResult {
    pub staging_dir: String,
    pub mod_id: i64,
    pub target_dir: String,
    pub files: Vec<String>,
    pub file_count: usize,
    /// FOMOD ModuleConfig.xml 原文（无则 null，前端有则弹窗让用户选分支）。
    pub fomod_xml: Option<String>,
    pub elapsed_ms: u64,
}

/// commit 请求：prepare 的 staging + 用户 FOMOD 选择（相对路径清单，无选择传空）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCommitRequest {
    pub staging_dir: String,
    pub mod_id: i64,
    pub target_dir: String,
    pub manager_root: String,
    pub metadata: ImportMetadata,
    pub overwrite: bool,
    /// FOMOD 选中文件的 source 相对路径（大小写不敏感前缀匹配用）。
    pub fomod_selected: Vec<String>,
}

/// commit 返回：新 mod 的 id + 文件数 + 耗时。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCommitResult {
    pub mod_id: i64,
    pub mod_name: String,
    pub file_count: usize,
    pub elapsed_ms: u64,
}

/// 任务一键导入请求（下载页 complete 任务→本地）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportTaskRequest {
    pub file_path: String,
    pub source_type: String,
    pub manager_root: String,
    pub metadata: ImportMetadata,
    pub overwrite_mod_id: Option<i64>,
}

/// 任务导入返回：need_fomod=true 时前端弹窗，拿到选择后再调 commit。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportTaskResult {
    pub mod_id: i64,
    pub mod_name: String,
    pub file_count: usize,
    pub need_fomod: bool,
    pub staging_dir: Option<String>,
    pub target_dir: Option<String>,
    pub fomod_xml: Option<String>,
    pub elapsed_ms: u64,
}

/// 对账请求：download_meta 全表（gid→meta 片段）+ 本地 mod.json 全表一次传入，后端算 diff。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSyncEntry {
    pub gid: String,
    pub local_mod_id: Option<i64>,
    pub source_type: Option<String>,
    pub external_id: Option<serde_json::Value>,
    pub mod_id: Option<serde_json::Value>,
    pub file_name: Option<String>,
    pub mod_title: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSyncRequest {
    pub manager_root: String,
    pub entries: Vec<ImportSyncEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSyncChange {
    pub gid: String,
    /// "to-imported" | "to-unimported"
    pub action: String,
    pub hit_mod_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSyncResult {
    pub changes: Vec<ImportSyncChange>,
    pub fixed_imported: usize,
    pub fixed_unimported: usize,
    pub elapsed_ms: u64,
}

/// 后端解压：经 shell 插件 sidecar 起 `sevenzip x <archive> -o<dir> -y`。
/// 与前端 `Command.sidecar("sevenzip")` 同一套二进制解析（dev/prod 均可），
/// 不自己拼 resource 路径（dev 下 resource 目录无 binaries 会找不到）。
async fn extract_archive_native(
    app: &tauri::AppHandle,
    archive: &str,
    out_dir: &str,
) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    let started = Instant::now();
    tracing::info!(target: "backend", "[导入] 解压开始：archive={} out={}", archive, out_dir);
    let output = app
        .shell()
        .sidecar("sevenzip")
        .map_err(|err| format!("未找到 7-Zip sidecar，请确认 binaries 已打包：{err}"))?
        .args(["x", archive, &format!("-o{out_dir}"), "-y"])
        .output()
        .await
        .map_err(|err| format!("启动解压进程失败：{err}"))?;
    // shell 插件返回 bytes：7z 中文输出是 GBK，按 UTF-8 宽松解码（ 第四声 错误分类只看英文关键字，不受影响）。
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if output.status.code() != Some(0) {
        let detail = format!("{stderr}\n{stdout}").to_lowercase();
        // 错误分类对齐前端 getArchiveImportErrorMessage。
        if detail.contains("cannot open the file as archive") || detail.contains("can not open the file as archive") {
            return Err("下载文件不是有效压缩包，可能下载源返回了网页/错误内容，或文件已损坏。请删除该下载任务和文件后重新下载；如果仍失败，请在浏览器手动下载正确压缩包后导入。".to_string());
        }
        if detail.contains("wrong password") || detail.contains("encrypt") {
            return Err("压缩包已加密或需要密码，无法自动导入。请先手动解压，再以文件夹方式导入。".to_string());
        }
        tracing::warn!(target: "backend", "[导入] 解压失败：archive={} 耗时={:?} code={:?} stderr={} stdout={}", archive, started.elapsed(), output.status.code(), stderr.chars().take(500).collect::<String>(), stdout.chars().take(300).collect::<String>());
        return Err(format!("解压压缩包失败：{}", stderr.lines().next().filter(|l| !l.is_empty()).unwrap_or("未知错误")));
    }
    tracing::info!(target: "backend", "[导入] 解压完成：archive={} 耗时={:?}", archive, started.elapsed());
    Ok(())
}

/// 路径穿越校验：对齐前端 SevenZip.assertSafeEntryPaths（绝对路径/.. 段拒绝）。
fn assert_safe_rel(rel: &str) -> Result<(), String> {
    let normalized = rel.replace('\\', "/");
    if normalized.starts_with('/') || (normalized.len() >= 2 && normalized.as_bytes()[1] == b':' && normalized.as_bytes()[0].is_ascii_alphabetic()) {
        return Err(format!("压缩包内存在绝对路径条目，已阻止解压：{rel}"));
    }
    if normalized.split('/').any(|seg| seg == "..") {
        return Err(format!("压缩包内存在上级目录穿越条目，已阻止解压：{rel}"));
    }
    Ok(())
}

/// 目录 walk 取相对文件清单（symlink 丢弃，与 fs_copy_dir 同口径）。
fn walk_relative_files(dir: &Path) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    for entry in walkdir::WalkDir::new(dir).follow_links(false).into_iter() {
        let entry = entry.map_err(|err| format!("遍历导入目录失败：{err}"))?;
        if entry.depth() == 0 || entry.file_type().is_symlink() {
            continue;
        }
        if entry.file_type().is_file() {
            let rel = entry
                .path()
                .strip_prefix(dir)
                .map_err(|err| format!("取相对路径失败：{err}"))?;
            files.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    files.sort();
    Ok(files)
}

/// 探测 FOMOD：大小写不敏感找 fomod/ModuleConfig.xml，返回原文。
fn detect_fomod_xml(staging: &Path) -> Option<String> {
    for name in ["fomod", "FOMOD", "Fomod"] {
        let xml_path = staging.join(name).join("ModuleConfig.xml");
        if xml_path.is_file() {
            match std::fs::read_to_string(&xml_path) {
                Ok(text) => return Some(text),
                Err(err) => {
                    tracing::warn!(target: "backend", "[导入] FOMOD 配置读取失败：path={} err={}", xml_path.display(), err);
                    return None;
                }
            }
        }
    }
    None
}

/// 分配新 mod id：读 manager_root/mod.json 取 max id + 1（文件不存在则从 1 开始）。
fn next_mod_id(manager_root: &Path) -> Result<i64, String> {
    let mods = read_mod_list(manager_root)?;
    let max_id = mods
        .iter()
        .filter_map(|m| m.get("id").and_then(|v| v.as_i64().or_else(|| v.as_u64().and_then(|u| i64::try_from(u).ok()))))
        .max()
        .unwrap_or(0);
    Ok(max_id + 1)
}

fn mod_json_path(manager_root: &Path) -> PathBuf {
    manager_root.join("mod.json")
}

fn read_mod_list(manager_root: &Path) -> Result<Vec<serde_json::Value>, String> {
    let path = mod_json_path(manager_root);
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(&path).map_err(|err| format!("读取 mod.json 失败：{err}"))?;
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&text).map_err(|err| format!("解析 mod.json 失败：{err}"))
}

/// 原子写 mod.json：tmp 写再 rename（对齐 cfg_upsert 的防半截文件策略）。
fn write_mod_list(manager_root: &Path, mods: &[serde_json::Value]) -> Result<(), String> {
    let path = mod_json_path(manager_root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("创建管理器目录失败：{err}"))?;
    }
    let text = serde_json::to_string(mods).map_err(|err| format!("序列化 mod.json 失败：{err}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|err| format!("写 mod.json 临时文件失败：{err}"))?;
    std::fs::rename(&tmp, &path).map_err(|err| format!("mod.json 原子替换失败：{err}"))?;
    Ok(())
}

fn json_str(value: Option<&serde_json::Value>) -> Option<String> {
    value.and_then(|v| v.as_str().map(|s| s.to_string()))
}

/// 下一 weight：现有最大 weight + 1（对齐前端 managerModList.length + 1 语义，覆盖时沿用原 weight）。
fn next_weight(mods: &[serde_json::Value]) -> i64 {
    mods.iter()
        .filter_map(|m| m.get("weight").and_then(|v| v.as_i64()))
        .max()
        .unwrap_or(0)
        + 1
}

/// 准备阶段：清暂存→解压/复制→walk 清单→探 FOMOD。
#[tauri::command]
pub async fn mod_import_prepare(
    app: tauri::AppHandle,
    manager_root: String,
    source: ImportSource,
    overwrite_mod_id: Option<i64>,
) -> Result<ImportPrepareResult, String> {
    let started = Instant::now();
    let root = PathBuf::from(&manager_root);
    // mod id：覆盖沿用，否则 max+1。
    let mod_id = match overwrite_mod_id {
        Some(id) => id,
        None => next_mod_id(&root)?,
    };
    let target_dir = root.join(mod_id.to_string());
    // 暂存目录：覆盖走 .gmm-import-<id>-<ts>（对齐前端），否则直写目标目录。
    let staging_dir = if overwrite_mod_id.is_some() {
        root.join(format!(".gmm-import-{mod_id}-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)))
    } else {
        target_dir.clone()
    };
    tracing::info!(target: "backend", "[导入] prepare 开始：mod_id={} source_type={} path={} staging={}", mod_id, source.source_type, source.path, staging_dir.display());
    // 清暂存 + 文件夹/单文件复制走 blocking；解压是 async（shell sidecar），在外面先做。
    let is_archive = source.source_type == "archive";
    tauri::async_runtime::spawn_blocking({
        let staging_dir = staging_dir.clone();
        let source = source.clone();
        move || {
            if staging_dir.exists() {
                std::fs::remove_dir_all(&staging_dir).map_err(|err| format!("清理临时导入目录失败：{err}"))?;
            }
            std::fs::create_dir_all(&staging_dir).map_err(|err| format!("创建导入目录失败：{err}"))?;
            match source.source_type.as_str() {
                "folder" => {
                    let copied = crate::fsops::copy_dir_sync(&source.path, &staging_dir.to_string_lossy())?;
                    tracing::info!(target: "backend", "[导入] 文件夹复制完成：files={}", copied);
                }
                "archive" => {}
                _ => {
                    let name = source.file_name.clone().unwrap_or_else(|| {
                        Path::new(&source.path)
                            .file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_else(|| "file".to_string())
                    });
                    let dst = staging_dir.join(&name);
                    std::fs::copy(&source.path, &dst).map_err(|err| format!("复制文件失败：{err}"))?;
                }
            }
            Ok::<(), String>(())
        }
    })
    .await
    .map_err(|err| format!("导入准备失败：{err}"))??;
    if is_archive {
        extract_archive_native(&app, &source.path, &staging_dir.to_string_lossy()).await?;
    }
    let prepare_result = tauri::async_runtime::spawn_blocking(move || {
        let mut files = walk_relative_files(&staging_dir)?;
        // 解压包穿越校验：清单级复查（7z 已解压但仍需确认无穿越写入）。
        for rel in &files {
            assert_safe_rel(rel)?;
        }
        if files.is_empty() {
            return Err("源文件中没有可导入的文件。".to_string());
        }
        let fomod_xml = detect_fomod_xml(&staging_dir);
        let elapsed_ms = started.elapsed().as_millis() as u64;
        tracing::info!(target: "backend", "[导入] prepare 完成：mod_id={} files={} fomod={} 耗时={:?}", mod_id, files.len(), fomod_xml.is_some(), started.elapsed());
        let file_count = files.len();
        Ok::<ImportPrepareResult, String>(ImportPrepareResult {
            staging_dir: staging_dir.to_string_lossy().into_owned(),
            mod_id,
            target_dir: target_dir.to_string_lossy().into_owned(),
            files,
            file_count,
            fomod_xml,
            elapsed_ms,
        })
    })
    .await
    .map_err(|err| format!("导入准备失败：{err}"))??;
    Ok(prepare_result)
}

/// 组装 mod.json 条目（字段对齐前端 normalizeMod/buildImportedMod），纯函数供单/批量复用。
fn build_mod_entry(mod_id: i64, weight: i64, metadata: &ImportMetadata, files: &[String], target: &Path) -> serde_json::Value {
    let mod_name = metadata.mod_name.clone().unwrap_or_else(|| format!("Mod {mod_id}"));
    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    serde_json::json!({
        "id": mod_id,
        "modName": mod_name,
        "fileName": metadata.file_name.clone().unwrap_or_else(|| format!("mod-{mod_id}")),
        "md5": "",
        "modVersion": metadata.mod_version.clone().unwrap_or_else(|| "1.0.0".to_string()),
        "isUpdate": false,
        "isInstalled": false,
        "weight": weight,
        "modFiles": files,
        "tags": metadata.tags.clone().unwrap_or_default(),
        "modAuthor": metadata.mod_author.clone().unwrap_or_default(),
        "modWebsite": metadata.mod_website.clone().unwrap_or_default(),
        "modType": metadata.mod_type.clone().unwrap_or(serde_json::json!(99)),
        "modDesc": metadata.mod_desc.clone().unwrap_or_default(),
        "other": metadata.other.clone().unwrap_or(serde_json::json!({})),
        "from": metadata.from.clone().unwrap_or_else(|| "Customize".to_string()),
        "webId": metadata.web_id.clone(),
        "cover": pick_cover(&metadata.cover, files, target),
        "gameID": metadata.game_id.clone(),
        "importedAt": now_ms,
    })
}

/// 提交阶段：FOMOD 裁剪→落盘（覆盖走备份替换）→写 mod.json。
#[tauri::command]
pub async fn mod_import_commit(req: ImportCommitRequest) -> Result<ImportCommitResult, String> {
    let started = Instant::now();
    tracing::info!(target: "backend", "[导入] commit 开始：mod_id={} staging={} fomod_selected={}", req.mod_id, req.staging_dir, req.fomod_selected.len());
    tauri::async_runtime::spawn_blocking(move || {
        let staging = PathBuf::from(&req.staging_dir);
        let target = PathBuf::from(&req.target_dir);
        let root = PathBuf::from(&req.manager_root);
        // FOMOD 裁剪：只保留选中 source 前缀 + 删 fomod 目录（对齐前端 pruneStagingToFomodSelection）。
        if !req.fomod_selected.is_empty() {
            let kept: Vec<String> = req.fomod_selected.iter().map(|s| s.replace('\\', "/").to_lowercase()).collect();
            let mut removed = 0usize;
            for entry in walkdir::WalkDir::new(&staging).follow_links(false).into_iter() {
                let entry = entry.map_err(|err| format!("裁剪 FOMOD 目录失败：{err}"))?;
                if entry.depth() == 0 || entry.file_type().is_symlink() {
                    continue;
                }
                let rel = entry.path().strip_prefix(&staging).map_err(|err| format!("取相对路径失败：{err}"))?;
                let norm = rel.to_string_lossy().replace('\\', "/").to_lowercase();
                if norm == "fomod" || norm.starts_with("fomod/") {
                    continue;
                }
                let keep = kept.iter().any(|p| norm == *p || norm.starts_with(&format!("{p}/")));
                if !keep && entry.file_type().is_file() {
                    std::fs::remove_file(entry.path()).map_err(|err| format!("裁剪多余文件失败：{err}"))?;
                    removed += 1;
                }
            }
            for name in ["fomod", "FOMOD", "Fomod"] {
                let dir = staging.join(name);
                if dir.is_dir() {
                    std::fs::remove_dir_all(&dir).map_err(|err| format!("删除 fomod 目录失败：{err}"))?;
                }
            }
            tracing::info!(target: "backend", "[导入] FOMOD 裁剪完成：mod_id={} 删除文件={}", req.mod_id, removed);
        }
        let files = walk_relative_files(&staging)?;
        if files.is_empty() {
            return Err("源文件中没有可导入的文件。".to_string());
        }
        // 覆盖：备份→替换→删备份（对齐前端 replaceImportedFolder）。
        if req.overwrite {
            if target.exists() {
                let backup = PathBuf::from(format!("{}.gmmback-{}", target.display(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)));
                std::fs::rename(&target, &backup).map_err(|err| format!("备份现有 Mod 目录失败：{err}"))?;
                match std::fs::rename(&staging, &target) {
                    Ok(()) => {
                        std::fs::remove_dir_all(&backup).ok();
                    }
                    Err(err) => {
                        std::fs::remove_dir_all(&target).ok();
                        if backup.exists() {
                            std::fs::rename(&backup, &target).ok();
                        }
                        return Err(format!("替换现有 Mod 目录失败：{err}"));
                    }
                }
            } else if staging != target {
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent).map_err(|err| format!("创建目标目录失败：{err}"))?;
                }
                std::fs::rename(&staging, &target).map_err(|err| format!("移动导入目录失败：{err}"))?;
            }
        } else if staging != target {
            // 非覆盖且 staging==target 时已在目标目录，无需移动。
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|err| format!("创建目标目录失败：{err}"))?;
            }
            std::fs::rename(&staging, &target).map_err(|err| format!("移动导入目录失败：{err}"))?;
        }
        // 组装 mod 条目（字段对齐前端 normalizeMod/buildImportedMod）。
        let mut mods = read_mod_list(&root)?;
        let file_count = files.len();
        let weight = if req.overwrite {
            mods.iter().find(|m| m.get("id").and_then(|v| v.as_i64()) == Some(req.mod_id)).and_then(|m| m.get("weight").and_then(|v| v.as_i64())).unwrap_or_else(|| next_weight(&mods))
        } else {
            next_weight(&mods)
        };
        let entry = build_mod_entry(req.mod_id, weight, &req.metadata, &files, &target);
        let mod_name = entry.get("modName").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if let Some(pos) = mods.iter().position(|m| m.get("id").and_then(|v| v.as_i64()) == Some(req.mod_id)) {
            mods[pos] = entry;
        } else {
            mods.push(entry);
        }
        write_mod_list(&root, &mods)?;
        let elapsed_ms = started.elapsed().as_millis() as u64;
        tracing::info!(target: "backend", "[导入] commit 完成：mod_id={} files={} overwrite={} 耗时={:?}", req.mod_id, file_count, req.overwrite, started.elapsed());
        Ok(ImportCommitResult { mod_id: req.mod_id, mod_name, file_count, elapsed_ms })
    })
    .await
    .map_err(|err| format!("导入提交失败：{err}"))?
}

/// 封面选择：metadata.cover 优先；否则关键字（image/cover/logo/icon）→图片扩展名（对齐前端）。
fn pick_cover(cover: &Option<String>, files: &[String], target: &Path) -> Option<String> {
    if let Some(c) = cover {
        if !c.trim().is_empty() {
            return Some(c.clone());
        }
    }
    let lower: Vec<(String, String)> = files.iter().map(|f| (f.clone(), f.to_lowercase())).collect();
    let hit = lower.iter().find(|(_, n)| ["image", "cover", "logo", "icon"].iter().any(|k| n.contains(k))).map(|(o, _)| o.clone()).or_else(|| {
        lower.iter().find(|(_, n)| [".jpg", ".png", ".jpeg", ".webp"].iter().any(|e| n.ends_with(e))).map(|(o, _)| o.clone())
    });
    hit.map(|rel| target.join(&rel).to_string_lossy().into_owned())
}

/// 下载任务一键导入：prepare +（无 FOMOD 则直接 commit）一次搞定；有 FOMOD 返回 need_fomod。
#[tauri::command]
pub async fn mod_import_task(
    app: tauri::AppHandle,
    req: ImportTaskRequest,
) -> Result<ImportTaskResult, String> {
    let started = Instant::now();
    tracing::info!(target: "backend", "[导入] 任务导入开始：path={} source_type={}", req.file_path, req.source_type);
    let prepared = mod_import_prepare(
        app,
        req.manager_root.clone(),
        ImportSource { path: req.file_path.clone(), source_type: req.source_type.clone(), file_name: req.metadata.file_name.clone() },
        req.overwrite_mod_id,
    )
    .await?;
    // 有 FOMOD 配置 → 返回给前端弹窗，不自动提交。
    if prepared.fomod_xml.is_some() {
        tracing::info!(target: "backend", "[导入] 任务导入需 FOMOD 向导：mod_id={} files={}", prepared.mod_id, prepared.file_count);
        return Ok(ImportTaskResult {
            mod_id: prepared.mod_id,
            mod_name: String::new(),
            file_count: prepared.file_count,
            need_fomod: true,
            staging_dir: Some(prepared.staging_dir),
            target_dir: Some(prepared.target_dir),
            fomod_xml: prepared.fomod_xml,
            elapsed_ms: started.elapsed().as_millis() as u64,
        });
    }
    let committed = mod_import_commit(ImportCommitRequest {
        staging_dir: prepared.staging_dir,
        mod_id: prepared.mod_id,
        target_dir: prepared.target_dir,
        manager_root: req.manager_root,
        metadata: req.metadata,
        overwrite: req.overwrite_mod_id.is_some(),
        fomod_selected: Vec::new(),
    })
    .await?;
    tracing::info!(target: "backend", "[导入] 任务导入完成：mod_id={} files={} 总耗时={:?}", committed.mod_id, committed.file_count, started.elapsed());
    Ok(ImportTaskResult {
        mod_id: committed.mod_id,
        mod_name: committed.mod_name,
        file_count: committed.file_count,
        need_fomod: false,
        staging_dir: None,
        target_dir: None,
        fomod_xml: None,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// 批量任务导入项（gid 只用于结果回填，后端不关心）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBatchItem {
    pub gid: String,
    pub file_path: String,
    pub source_type: String,
    pub metadata: ImportMetadata,
}

/// 批量任务导入请求：items 全走新建（无 FOMOD 快捷路径；FOMOD 包按全量提交）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBatchRequest {
    pub manager_root: String,
    pub items: Vec<ImportBatchItem>,
    /// 类型识别规则（前端游戏配置 checkModType 数组透传，后端按规则匹配 modType）。
    #[serde(default)]
    pub type_rules: Vec<ModTypeRule>,
}

/// 类型识别规则：对齐前端游戏配置 checkModType（Keyword/UseFunction/TypeId；前端字段大写开头，大小写不敏感反序列化）。
#[derive(Debug, Clone, Deserialize)]
pub struct ModTypeRule {
    #[serde(default, alias = "Keyword", alias = "keyword")]
    pub keyword: Vec<String>,
    #[serde(default, alias = "UseFunction", alias = "useFunction")]
    pub use_function: String,
    #[serde(default, alias = "TypeId", alias = "typeId")]
    pub type_id: Option<i64>,
}

/// 按规则匹配 modType（对齐前端 detectModType：inPath/basename/扩展名三路）。
/// 调试版：返回 (type_id, 命中的规则下标, 命中的文件)，日志用。
fn detect_mod_type_debug(files: &[String], rules: &[ModTypeRule]) -> (i64, Option<usize>, Option<String>) {
    for (index, rule) in rules.iter().enumerate() {
        let hit_file = files.iter().find(|file| {
            let norm = file.replace('\\', "/").to_lowercase();
            rule.keyword.iter().any(|keyword| {
                let key = keyword.to_lowercase();
                match rule.use_function.as_str() {
                    "inPath" => norm.contains(&key),
                    "basename" => norm.rsplit('/').next().unwrap_or(&norm) == key,
                    _ => {
                        let ext = norm.rsplit('.').next().unwrap_or("");
                        ext == key || format!(".{ext}") == format!(".{key}")
                    }
                }
            })
        });
        if let Some(file) = hit_file {
            return (rule.type_id.unwrap_or(99), Some(index), Some(file.clone()));
        }
    }
    (99, None, None)
}
/// 按规则匹配 modType（对齐前端 detectModType：inPath/basename/扩展名三路）。
fn detect_mod_type(files: &[String], rules: &[ModTypeRule]) -> i64 {
    for rule in rules {
        let hit = files.iter().any(|file| {
            let norm = file.replace('\\', "/").to_lowercase();
            rule.keyword.iter().any(|keyword| {
                let key = keyword.to_lowercase();
                match rule.use_function.as_str() {
                    "inPath" => norm.contains(&key),
                    "basename" => norm.rsplit('/').next().unwrap_or(&norm) == key,
                    _ => {
                        let ext = norm.rsplit('.').next().unwrap_or("");
                        ext == key || format!(".{ext}") == format!(".{key}")
                    }
                }
            })
        });
        if hit {
            return rule.type_id.unwrap_or(99);
        }
    }
    99
}
/// 内置类型识别（函数式规则游戏的回退）：赛博朋克 2077（GlossGameId=195），与前端 checkModType 同口径。
/// 1=CET / 4=主目录(archive/bin/engine/r6/red4ext/mods) / 2=.archive / 3=.lua / 5=未知。
fn builtin_mod_type(game_id: &str, files: &[String]) -> Option<i64> {
    if game_id != "195" {
        return None;
    }
    const FOLDERS: &[&str] = &["archive", "bin", "engine", "r6", "red4ext", "mods"];
    let mut cet = false;
    let mut archive = false;
    let mut lua = false;
    let mut main_folder = false;
    for file in files {
        let norm = file.replace('\\', "/").to_lowercase();
        if norm.rsplit('/').next().unwrap_or(&norm) == "cyber_engine_tweaks.asi" {
            cet = true;
        }
        if norm.split('/').any(|part| FOLDERS.contains(&part)) {
            main_folder = true;
        }
        let ext = norm.rsplit('.').next().unwrap_or("");
        if ext == "archive" {
            archive = true;
        }
        if ext == "lua" {
            lua = true;
        }
    }
    if cet {
        return Some(1);
    }
    if main_folder {
        return Some(4);
    }
    if archive {
        return Some(2);
    }
    Some(5)
}

/// 无 gameID 时的赛博朋克文件特征识别：与 builtin_mod_type 同口径，但不要求 game=195。
/// archive/bin/engine/r6/red4ext/mods 路径或 .archive/.xl/.reds/.lua/.yaml 特征出现即判赛博朋克。
fn builtin_cyberpunk_by_files(files: &[String]) -> Option<i64> {
    const FOLDERS: &[&str] = &["archive", "bin", "engine", "r6", "red4ext", "mods"];
    let mut cet = false;
    let mut archive = false;
    let mut lua = false;
    let mut main_folder = false;
    let mut cyberpunk_hint = false;
    for file in files {
        let norm = file.replace('\\', "/").to_lowercase();
        if norm.rsplit('/').next().unwrap_or(&norm) == "cyber_engine_tweaks.asi" {
            cet = true;
        }
        if norm.split('/').any(|part| FOLDERS.contains(&part)) {
            main_folder = true;
        }
        let ext = norm.rsplit('.').next().unwrap_or("");
        if ext == "archive" {
            archive = true;
        }
        if ext == "lua" {
            lua = true;
        }
        if ["xl", "reds", "yaml"].contains(&ext) {
            cyberpunk_hint = true;
        }
    }
    if cet {
        return Some(1);
    }
    if main_folder {
        return Some(4);
    }
    if archive {
        return Some(2);
    }
    if lua {
        return Some(3);
    }
    if cyberpunk_hint {
        // 纯零散 reds/yaml（无主目录）：仍判未知 5，但说明是赛博朋克文件而非彻底未知。
        return Some(5);
    }
    None
}

/// 批量单项结果：ok 时 mod_id/file_count 有效；err 时看 error。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBatchItemResult {
    pub gid: String,
    pub ok: bool,
    pub mod_id: Option<i64>,
    pub file_count: Option<usize>,
    pub error: Option<String>,
}

/// 批量单项 worker：独立暂存解压→落盘→组 entry（不碰 mod.json，由批量统一写）。
/// 暂存 `.gmm-batch-<id>` 与目标同级；成功时 staging 已 rename 到 target。
async fn import_one_batch_item(
    app: &tauri::AppHandle,
    manager_root: &str,
    mod_id: i64,
    weight: i64,
    item: &ImportBatchItem,
    type_rules: &[ModTypeRule],
) -> Result<(usize, serde_json::Value), (String, String)> {
    let err = |msg: String| (item.gid.clone(), msg);
    let root = PathBuf::from(manager_root);
    let target = root.join(mod_id.to_string());
    let staging = root.join(format!(".gmm-batch-{mod_id}"));
    let source = ImportSource { path: item.file_path.clone(), source_type: item.source_type.clone(), file_name: item.metadata.file_name.clone() };
    // 清暂存 + 物化（blocking 做文件 IO；解压 async 在外）。
    let staging_path = staging.clone();
    let staging_str = staging.to_string_lossy().into_owned();
    let staging_str2 = staging_str.clone();
    let source2 = source.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if staging_path.exists() {
            std::fs::remove_dir_all(&staging_path).map_err(|e| format!("清理临时导入目录失败：{e}"))?;
        }
        std::fs::create_dir_all(&staging_path).map_err(|e| format!("创建导入目录失败：{e}"))?;
        match source2.source_type.as_str() {
            "folder" => {
                crate::fsops::copy_dir_sync(&source2.path, &staging_path.to_string_lossy())?;
            }
            "archive" => {}
            _ => {
                let name = source2.file_name.clone().unwrap_or_else(|| {
                    Path::new(&source2.path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".to_string())
                });
                std::fs::copy(&source2.path, staging_path.join(&name)).map_err(|e| format!("复制文件失败：{e}"))?;
            }
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| err(format!("导入准备失败：{e}")))
    .and_then(|r| r.map_err(err))?;
    if source.source_type == "archive" {
        extract_archive_native(app, &source.path, &staging_str).await.map_err(err)?;
    }
    let item_owned = item.clone();
    let rules_owned = type_rules.to_vec();
    let game_id_owned = item.metadata.game_id.clone().map(|v| v.to_string()).unwrap_or_default();
    let (files, entry) = tauri::async_runtime::spawn_blocking(move || {
        let staging = PathBuf::from(&staging_str2);
        let mut files = walk_relative_files(&staging)?;
        for rel in &files {
            assert_safe_rel(rel)?;
        }
        if files.is_empty() {
            return Err("源文件中没有可导入的文件。".to_string());
        }
        if target.exists() {
            return Err(format!("目标目录已存在（id 冲突）：{}", target.display()));
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目标目录失败：{e}"))?;
        }
        std::fs::rename(&staging, &target).map_err(|e| format!("移动导入目录失败：{e}"))?;
        let mut entry = build_mod_entry(mod_id, weight, &item_owned.metadata, &files, &target);
        // 规则为空（函数式规则游戏）→内置回退；否则按规则匹配。
        let type_id = if rules_owned.is_empty() {
            // gameID 可能为空（前端旧包/未传）：文件结构本身就是赛博朋克特征时直接认，不等 game。
            builtin_mod_type(&game_id_owned, &files)
                .or_else(|| builtin_cyberpunk_by_files(&files))
                .unwrap_or(99)
        } else {
            detect_mod_type(&files, &rules_owned)
        };
        entry["modType"] = serde_json::json!(type_id);
        // 详细链路日志：gameID 原始值/文件总数/前5文件/规则明细，定位类型丢失环节。
        tracing::info!(target: "backend", "[导入] 类型识别：mod_id={} modType={} game原始值={} 文件数={} 首5文件={:?} 规则数={}", mod_id, type_id, game_id_owned, files.len(), files.iter().take(5).collect::<Vec<_>>(), rules_owned.len());
        for (ri, rule) in rules_owned.iter().enumerate() {
            tracing::info!(target: "backend", "[导入] 类型规则[{}]：use={} type={:?} 关键词={:?}", ri, rule.use_function, rule.type_id, rule.keyword);
        }
        tracing::info!(target: "backend", "[导入] 入库条目：mod_id={} modType={} modName={:?} fileName={:?}", mod_id, entry.get("modType").map(|v| v.to_string()).unwrap_or_default(), entry.get("modName").and_then(|v| v.as_str()), entry.get("fileName").and_then(|v| v.as_str()));
        Ok::<(usize, serde_json::Value), String>((files.len(), entry))
    })
    .await
    .map_err(|e| err(format!("导入提交失败：{e}")))
    .and_then(|r| r.map_err(err))?;
    Ok((files, entry))
}

/// 批量任务导入：ID 预分配 + tokio 信号量并行解压落盘 + 单次合并写 mod.json。
/// 并行障碍：`next_mod_id` 读时 max+1 会分重复 ID；`mod.json` 逐个读写会丢条目。
/// 解压是 async sidecar（rayon 跑不了 async），用 tokio 并发 + 信号量限流。
#[tauri::command]
pub async fn mod_import_batch(
    app: tauri::AppHandle,
    req: ImportBatchRequest,
) -> Result<Vec<ImportBatchItemResult>, String> {
    use std::sync::Arc;
    use tokio::sync::Semaphore;
    let started = Instant::now();
    let root = PathBuf::from(&req.manager_root);
    if req.items.is_empty() {
        return Ok(Vec::new());
    }
    // ID 预分配 + 身份判重：一次读表，score>=100 的直接 skipped（回填 hitModId），其余连续分段。
    let (skipped, base_id, base_weight) = tauri::async_runtime::spawn_blocking({
        let root = root.clone();
        let items = req.items.clone();
        move || {
            let mods = read_mod_list(&root)?;
            let max_id = mods.iter().filter_map(|m| m.get("id").and_then(|v| v.as_i64().or_else(|| v.as_u64().and_then(|u| i64::try_from(u).ok())))).max().unwrap_or(0);
            let mut skipped: Vec<ImportBatchItemResult> = Vec::new();
            let mut live = 0usize;
            for item in &items {
                let dup_req = ImportDuplicatesRequest {
                    manager_root: String::new(),
                    source_type: item.metadata.from.clone(),
                    external_id: item.metadata.web_id.clone(),
                    mod_id: item.metadata.mod_id.clone(),
                    file_name: item.metadata.file_name.clone(),
                    mod_title: item.metadata.mod_name.clone(),
                };
                let hit = mods.iter().filter_map(|m| {
                    let (score, _) = local_mod_match_score(m, &dup_req);
                    if score >= 100 { m.get("id").and_then(|v| v.as_i64()) } else { None }
                }).next();
                if hit.is_some() {
                    skipped.push(ImportBatchItemResult { gid: item.gid.clone(), ok: true, mod_id: hit, file_count: Some(0), error: Some("skipped".to_string()) });
                } else {
                    live += 1;
                }
            }
            Ok::<(Vec<ImportBatchItemResult>, i64, i64), String>((skipped, max_id + 1, next_weight(&mods)))
        }
    })
    .await
    .map_err(|err| format!("批量导入准备失败：{err}"))??;
    let limit = std::thread::available_parallelism().map(|n| (n.get() / 2).clamp(2, 8)).unwrap_or(4);
    let sem = Arc::new(Semaphore::new(limit));
    tracing::info!(target: "backend", "[导入] 批量开始：n={} 跳过={} base_id={} 并发={} 规则数={} 首规则={:?}", req.items.len(), skipped.len(), base_id, limit, req.type_rules.len(), req.type_rules.first());
    // 首项 metadata 回显：确认 gameID/modType/tags 进没进后端（前端漏传在此现形）。
    if let Some(first) = req.items.first() {
        tracing::info!(target: "backend", "[导入] 首项metadata：gameID={:?} modType={:?} tags={:?} from={:?} webId={:?}", first.metadata.game_id, first.metadata.mod_type, first.metadata.tags, first.metadata.from, first.metadata.web_id);
    }
    // 函数式规则（赛博朋克等）前端传不过来：规则为空时按游戏 ID 回退内置识别。
    let mut results: Vec<ImportBatchItemResult> = skipped;
    let skipped_gids: std::collections::HashSet<String> = results.iter().map(|r| r.gid.clone()).collect();
    let mut live_index = 0usize;
    let type_rules = req.type_rules.clone();
    let mut handles = Vec::new();
    for item in req.items.into_iter() {
        if skipped_gids.contains(&item.gid) {
            continue;
        }
        let app = app.clone();
        let sem = sem.clone();
        let manager_root = req.manager_root.clone();
        let rules = type_rules.clone();
        let mod_id = base_id + live_index as i64;
        let weight = base_weight + live_index as i64;
        live_index += 1;
        handles.push(tauri::async_runtime::spawn(async move {
            let gid = item.gid.clone();
            let _permit = sem.acquire_owned().await.map_err(|e| format!("批量导入信号量已关闭：{e}"))?;
            match import_one_batch_item(&app, &manager_root, mod_id, weight, &item, &rules).await {
                Ok((file_count, entry)) => Ok((gid, mod_id, file_count, entry)),
                Err((_, msg)) => Err(format!("{gid}|||{msg}")),
            }
        }));
    }
    // 收敛：成功项一次合并写 mod.json（单次读-改-写，无丢失更新）。
    let mut ok_entries: Vec<(String, i64, usize, serde_json::Value)> = Vec::new();
    for handle in handles {
        match handle.await.map_err(|err| format!("批量导入任务 panic：{err}"))? {
            Ok((gid, mod_id, file_count, entry)) => {
                ok_entries.push((gid.clone(), mod_id, file_count, entry));
                results.push(ImportBatchItemResult { gid, ok: true, mod_id: Some(mod_id), file_count: Some(file_count), error: None });
            }
            Err(combined) => {
                let (gid, msg) = combined.split_once("|||").map(|(a, b)| (a.to_string(), b.to_string())).unwrap_or_else(|| (String::new(), combined));
                results.push(ImportBatchItemResult { gid, ok: false, mod_id: None, file_count: None, error: Some(msg) });
            }
        }
    }
    if !ok_entries.is_empty() {
        let entries = ok_entries.iter().map(|(_, _, _, e)| e.clone()).collect::<Vec<_>>();
        let root2 = root.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut mods = read_mod_list(&root2)?;
            mods.extend(entries);
            write_mod_list(&root2, &mods)
        })
        .await
        .map_err(|err| format!("批量导入写表失败：{err}"))??;
    }
    let ok_count = ok_entries.len();
    tracing::info!(target: "backend", "[导入] 批量完成：ok={} fail={} 耗时={:?}", ok_count, results.len() - ok_count, started.elapsed());
    Ok(results)
}

/// 身份匹配：与前端 findGlossDuplicateLocalMods 同口径（webId/外部 id 命中即 score>=100）。
/// 简化实现：mod.json 条目的 webId/externalId/modId 任一与请求相等（字符串化比较）即命中。
fn identity_hit(mods: &[serde_json::Value], req: &ImportSyncEntry) -> Option<i64> {
    let want: Vec<String> = [
        req.external_id.clone(),
        req.mod_id.clone(),
        req.web_id_str(),
    ]
    .into_iter()
    .flatten()
    .map(|v| json_val_to_key(&v))
    .filter(|s| !s.is_empty())
    .collect();
    if want.is_empty() {
        return None;
    }
    for m in mods {
        let id = m.get("id").and_then(|v| v.as_i64().or_else(|| v.as_u64().and_then(|u| i64::try_from(u).ok())));
        let candidates: Vec<String> = [
            m.get("webId"),
            m.get("externalId"),
            m.get("modId"),
        ]
        .into_iter()
        .flatten()
        .map(json_val_to_key)
        .filter(|s| !s.is_empty())
        .collect();
        if candidates.iter().any(|c| want.iter().any(|w| c == w)) {
            return id;
        }
    }
    None
}

fn json_val_to_key(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.trim().to_lowercase(),
        serde_json::Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

impl ImportSyncEntry {
    fn web_id_str(&self) -> Option<serde_json::Value> {
        // webId 与 externalId 同源：externalId 优先，modId 次之（对齐前端 getTaskExternalId）。
        self.external_id.clone().or_else(|| self.mod_id.clone())
    }
}

/// 导入态对账：读本地 mod.json，与传入条目 diff，返回改动（前端按改动写回 download_meta）。
#[tauri::command]
pub async fn mod_import_sync_status(req: ImportSyncRequest) -> Result<ImportSyncResult, String> {
    let started = Instant::now();
    tracing::info!(target: "backend", "[导入] 对账开始：entries={}", req.entries.len());
    let entry_count = req.entries.len();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&req.manager_root);
        let mods = read_mod_list(&root)?;
        let local_ids: std::collections::HashSet<i64> = mods
            .iter()
            .filter_map(|m| m.get("id").and_then(|v| v.as_i64().or_else(|| v.as_u64().and_then(|u| i64::try_from(u).ok()))))
            .collect();
        let mut changes = Vec::new();
        for entry in &req.entries {
            match entry.local_mod_id {
                Some(id) if local_ids.contains(&id) => {}
                Some(_) => {
                    changes.push(ImportSyncChange { gid: entry.gid.clone(), action: "to-unimported".to_string(), hit_mod_id: None });
                }
                None => {
                    if let Some(hit) = identity_hit(&mods, entry) {
                        changes.push(ImportSyncChange { gid: entry.gid.clone(), action: "to-imported".to_string(), hit_mod_id: Some(hit) });
                    }
                }
            }
        }
        Ok::<Vec<ImportSyncChange>, String>(changes)
    })
    .await
    .map_err(|err| format!("导入对账失败：{err}"))??;
    let fixed_imported = result.iter().filter(|c| c.action == "to-imported").count();
    let fixed_unimported = result.len() - fixed_imported;
    tracing::info!(
        target: "backend", "[导入] 对账完成：entries={} 改动={}（标已导入={}，打回未导入={}）耗时={:?}",
        entry_count, result.len(), fixed_imported, fixed_unimported, started.elapsed()
    );
    Ok(ImportSyncResult {
        changes: result,
        fixed_imported,
        fixed_unimported,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}
/// 判重查询请求：对齐前端 IGlossDuplicateCriteria。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportDuplicatesRequest {
    pub manager_root: String,
    pub source_type: Option<String>,
    pub external_id: Option<serde_json::Value>,
    pub mod_id: Option<serde_json::Value>,
    pub file_name: Option<String>,
    pub mod_title: Option<String>,
}

/// 判重命中：mod 全量 JSON（前端弹窗展示用）+ score + reason。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportDuplicateMatch {
    pub mod_data: serde_json::Value,
    pub reason: String,
    pub score: i64,
}

fn normalize_compare_text(value: &str) -> String {
    value.trim().to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_same_id(left: &serde_json::Value, right: &serde_json::Value) -> bool {
    let l = json_val_to_key(left);
    let r = json_val_to_key(right);
    !l.is_empty() && !r.is_empty() && l == r
}

/// 本地 mod 打分：逐字对齐前端 getLocalModMatchScore（100 同源/60 文件名/40 标题）。
fn local_mod_match_score(mod_data: &serde_json::Value, req: &ImportDuplicatesRequest) -> (i64, String) {
    let file_name = normalize_compare_text(req.file_name.as_deref().unwrap_or(""));
    let title = normalize_compare_text(req.mod_title.as_deref().unwrap_or(""));
    let source_type = req.source_type.as_deref().map(str::trim).unwrap_or("");
    let criteria_external = req.external_id.clone().or_else(|| req.mod_id.clone());
    let mod_from = mod_data.get("from").and_then(|v| v.as_str()).unwrap_or("");
    // 同一来源 Mod：from 相等且 webId == externalId。
    if !source_type.is_empty() && mod_from == source_type {
        if let (Some(web_id), Some(ext)) = (mod_data.get("webId"), criteria_external.as_ref()) {
            if is_same_id(web_id, ext) {
                return (100, "同一来源 Mod".to_string());
            }
        }
    }
    // 同一 Gloss Mod：无 sourceType 且 from==GlossMod 且 webId == modId。
    if source_type.is_empty() && mod_from == "GlossMod" {
        if let (Some(web_id), Some(mid)) = (mod_data.get("webId"), req.mod_id.as_ref()) {
            if is_same_id(web_id, mid) {
                return (100, "同一 Gloss Mod".to_string());
            }
        }
    }
    // 文件名重复。
    if !file_name.is_empty() {
        if let Some(name) = mod_data.get("fileName").and_then(|v| v.as_str()) {
            if normalize_compare_text(name) == file_name {
                return (60, "文件名重复".to_string());
            }
        }
    }
    // 标题重复。
    if !title.is_empty() {
        if let Some(name) = mod_data.get("modName").and_then(|v| v.as_str()) {
            if normalize_compare_text(name) == title {
                return (40, "标题重复".to_string());
            }
        }
    }
    (0, String::new())
}

/// 判重查询：读 mod.json 打分排序，前端弹窗用。日志记候选数与耗时。
#[tauri::command]
pub async fn mod_import_duplicates(req: ImportDuplicatesRequest) -> Result<Vec<ImportDuplicateMatch>, String> {
    let started = Instant::now();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&req.manager_root);
        let mods = read_mod_list(&root)?;
        let mut hits: Vec<ImportDuplicateMatch> = mods
            .into_iter()
            .filter_map(|m| {
                let (score, reason) = local_mod_match_score(&m, &req);
                if score > 0 {
                    Some(ImportDuplicateMatch { mod_data: m, reason, score })
                } else {
                    None
                }
            })
            .collect();
        hits.sort_by(|a, b| b.score.cmp(&a.score));
        Ok::<Vec<ImportDuplicateMatch>, String>(hits)
    })
    .await
    .map_err(|err| format!("查询重复 Mod 失败：{err}"))??;
    tracing::info!(target: "backend", "[导入] 判重查询完成：hits={} 耗时={:?}", result.len(), started.elapsed());
    Ok(result)
}
