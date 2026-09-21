//! 下载任务元信息（IGlossDownloadTaskMeta）后端存储。
//!
//! 文件位置：`app_local_data_dir/download_meta.json`（与 collection_pending.json 同级，
//! 与前端 settings.json 分离）。前端形状不固定，用 `serde_json::Value` 透传，
//! 后端只做整表 get/set + 单键 remove，不解析字段。
//! 并发写与清单存储同策略：fs2 文件锁 + tmp 写再 rename。

use std::collections::HashMap;
use tauri::Manager;

/// 抽取 meta 中的展示名用于日志，避免整包序列化刷屏。
fn meta_display_name(value: &serde_json::Value) -> String {
    value
        .get("fileName")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            value
                .get("resourceName")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "-".to_string())
}

const META_FILE_NAME: &str = "download_meta.json";

fn meta_file_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("解析数据目录失败：{err}"))?;
    std::fs::create_dir_all(&dir).map_err(|err| format!("创建数据目录失败：{err}"))?;
    Ok(dir.join(META_FILE_NAME))
}

fn read_map(app: &tauri::AppHandle) -> Result<HashMap<String, serde_json::Value>, String> {
    let path = meta_file_path(app)?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let content =
        std::fs::read_to_string(&path).map_err(|err| format!("读取下载元信息失败：{err}"))?;
    if content.trim().is_empty() {
        return Ok(HashMap::new());
    }
    serde_json::from_str(&content).map_err(|err| format!("解析下载元信息失败：{err}"))
}

fn write_map(
    app: &tauri::AppHandle,
    map: &HashMap<String, serde_json::Value>,
) -> Result<(), String> {
    use fs2::FileExt;
    let path = meta_file_path(app)?;
    let lock_path = path.with_extension("lock");
    let lock_file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(&lock_path)
        .map_err(|err| format!("获取下载元信息锁失败：{err}"))?;
    lock_file
        .lock_exclusive()
        .map_err(|err| format!("获取下载元信息锁失败：{err}"))?;
    let result = (|| -> Result<(), String> {
        let content =
            serde_json::to_string(map).map_err(|err| format!("序列化下载元信息失败：{err}"))?;
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, content).map_err(|err| format!("写入下载元信息失败：{err}"))?;
        std::fs::rename(&tmp, &path).map_err(|err| format!("写入下载元信息失败：{err}"))?;
        Ok(())
    })();
    let _ = lock_file.unlock();
    result
}

/// 整表读取（前端展示/判重用）。
#[tauri::command]
pub(crate) fn dl_meta_list(
    app: tauri::AppHandle,
) -> Result<HashMap<String, serde_json::Value>, String> {
    let map = read_map(&app)?;
    let total = map.len();
    let missing = map.iter().filter(|(_, v)| meta_display_name(v) == "-").count();
    if missing > 0 {
        tracing::warn!(target: "gmm::meta", "[uuid-trace] dl_meta_list total={} missing_name={} — 存在无名 meta（会回退为 gid/uuid 展示）", total, missing);
        for (gid, v) in map.iter().filter(|(_, v)| meta_display_name(v) == "-") {
            let src = v.get("sourceType").and_then(|x| x.as_str()).unwrap_or("-");
            let durl = v.get("downloadUrl").and_then(|x| x.as_str()).unwrap_or("-");
            tracing::warn!(target: "gmm::meta", "[uuid-trace] dl_meta_list orphan gid={} sourceType={} downloadUrl_head={} meta={}", gid, src, &durl[..durl.len().min(80)], v);
        }
    } else {
        tracing::debug!(target: "gmm::meta", "[uuid-trace] dl_meta_list total={} missing_name=0", total);
    }
    Ok(map)
}

/// 按 gid 合并写入（治本：前端各链路持有的表快照可能滞后，整表替换会把并发期间
/// 其它链路刚写入的 gid 条目整体洗掉，表现为下载页任务名回退成 uuid）。合并语义：
/// 只覆盖传入的键、保留未传入的键，删除仍走 dl_meta_remove。
#[tauri::command]
pub(crate) fn dl_meta_save(
    app: tauri::AppHandle,
    map: HashMap<String, serde_json::Value>,
) -> Result<(), String> {
    if map.is_empty() {
        tracing::debug!(target: "gmm::meta", "[uuid-trace] dl_meta_save skip empty");
        return Ok(());
    }
    let incoming = map.len();
    let incoming_missing = map.iter().filter(|(_, v)| meta_display_name(v) == "-").count();
    if incoming_missing > 0 {
        tracing::warn!(target: "gmm::meta", "[uuid-trace] dl_meta_save incoming={} missing_name={} — 入参已含无名条目，会直接产生 uuid 展示", incoming, incoming_missing);
        for (gid, v) in map.iter().filter(|(_, v)| meta_display_name(v) == "-") {
            tracing::warn!(target: "gmm::meta", "[uuid-trace] dl_meta_save incoming orphan gid={} meta={}", gid, v);
        }
    }
    let mut current = read_map(&app)?;
    let before = current.len();
    for (gid, meta) in map {
        let name = meta_display_name(&meta);
        if name == "-" {
            tracing::warn!(target: "gmm::meta", "[uuid-trace] dl_meta_save put gid={} name=- sourceType={}", gid, meta.get("sourceType").and_then(|x| x.as_str()).unwrap_or("-"));
        } else {
            tracing::debug!(target: "gmm::meta", "[uuid-trace] dl_meta_save put gid={} name={}", gid, name);
        }
        current.insert(gid, meta);
    }
    tracing::info!(target: "gmm::meta", "[uuid-trace] dl_meta_save merged before={} incoming={} after={}", before, incoming, current.len());
    write_map(&app, &current)
}

/// 单键写入/合并（建任务、导入标记等单点更新用，前端传合并后的单条）。
#[tauri::command]
pub(crate) fn dl_meta_put(
    app: tauri::AppHandle,
    gid: String,
    meta: serde_json::Value,
) -> Result<(), String> {
    let name = meta_display_name(&meta);
    let src = meta.get("sourceType").and_then(|v| v.as_str()).unwrap_or("-");
    let has_file = meta.get("fileName").and_then(|v| v.as_str()).map(|s| !s.trim().is_empty()).unwrap_or(false);
    let has_res = meta.get("resourceName").and_then(|v| v.as_str()).map(|s| !s.trim().is_empty()).unwrap_or(false);
    if name == "-" {
        tracing::warn!(target: "gmm::meta", "[uuid-trace] dl_meta_put gid={} sourceType={} fileName_empty={} resourceName_empty={} — 无名写入，前端将回退 gid/uuid！ meta={}", gid, src, !has_file, !has_res, meta);
    } else {
        tracing::info!(target: "gmm::meta", "[uuid-trace] dl_meta_put gid={} name={} sourceType={}", gid, name, src);
    }
    let mut map = read_map(&app)?;
    let existed = map.contains_key(&gid);
    map.insert(gid.clone(), meta);
    let res = write_map(&app, &map);
    if res.is_ok() {
        tracing::debug!(target: "gmm::meta", "[uuid-trace] dl_meta_put done gid={} existed={} total={}", gid, existed, map.len());
    } else {
        tracing::error!(target: "gmm::meta", "[uuid-trace] dl_meta_put FAILED gid={} existed={}", gid, existed);
    }
    res
}

/// 单键删除（清理/移除任务时调用，与 purge 链路同生命周期）。
#[tauri::command]
pub(crate) fn dl_meta_remove(app: tauri::AppHandle, gid: String) -> Result<(), String> {
    tracing::info!(target: "gmm::meta", "[uuid-trace] dl_meta_remove gid={}", gid);
    let mut map = read_map(&app)?;
    let existed = map.contains_key(&gid);
    map.remove(&gid);
    let res = write_map(&app, &map);
    if res.is_ok() {
        tracing::debug!(target: "gmm::meta", "[uuid-trace] dl_meta_remove done gid={} existed={} total={}", gid, existed, map.len());
    } else {
        tracing::error!(target: "gmm::meta", "[uuid-trace] dl_meta_remove FAILED gid={}", gid);
    }
    res
}
