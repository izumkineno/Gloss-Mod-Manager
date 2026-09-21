//! 下载页后端存储：投影快照 + 引擎设置/代理/目录。
//!
//! 文件位置：`app_local_data_dir/download_store.json`（与 download_meta.json 同级）。
//! 前端仅负责显示和控制：快照/设置经本模块透传，后端只做 get/set，不解析字段。
//! 并发写与 download_meta 同策略：fs2 文件锁 + tmp 写再 rename。

use std::collections::HashMap;
use tauri::Manager;

const STORE_FILE_NAME: &str = "download_store.json";

fn store_file_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("解析数据目录失败：{err}"))?;
    std::fs::create_dir_all(&dir).map_err(|err| format!("创建数据目录失败：{err}"))?;
    Ok(dir.join(STORE_FILE_NAME))
}

fn read_map(app: &tauri::AppHandle) -> Result<HashMap<String, serde_json::Value>, String> {
    let path = store_file_path(app)?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let content =
        std::fs::read_to_string(&path).map_err(|err| format!("读取下载存储失败：{err}"))?;
    if content.trim().is_empty() {
        return Ok(HashMap::new());
    }
    serde_json::from_str(&content).map_err(|err| format!("解析下载存储失败：{err}"))
}

fn write_map(
    app: &tauri::AppHandle,
    map: &HashMap<String, serde_json::Value>,
) -> Result<(), String> {
    use fs2::FileExt;
    let path = store_file_path(app)?;
    let lock_path = path.with_extension("lock");
    let lock_file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(&lock_path)
        .map_err(|err| format!("获取下载存储锁失败：{err}"))?;
    lock_file
        .lock_exclusive()
        .map_err(|err| format!("获取下载存储锁失败：{err}"))?;
    let result = (|| -> Result<(), String> {
        let content =
            serde_json::to_string(map).map_err(|err| format!("序列化下载存储失败：{err}"))?;
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, content).map_err(|err| format!("写入下载存储失败：{err}"))?;
        std::fs::rename(&tmp, &path).map_err(|err| format!("写入下载存储失败：{err}"))?;
        Ok(())
    })();
    let _ = lock_file.unlock();
    result
}

/// 单键读取（投影快照/引擎设置/代理/目录，前端传 key）。
#[tauri::command]
pub(crate) fn dl_store_get(
    app: tauri::AppHandle,
    key: String,
) -> Result<Option<serde_json::Value>, String> {
    Ok(read_map(&app)?.get(&key).cloned())
}

/// 单键写入（前端显示/控制变更后落盘）。
#[tauri::command]
pub(crate) fn dl_store_set(
    app: tauri::AppHandle,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    let mut map = read_map(&app)?;
    map.insert(key, value);
    write_map(&app, &map)
}
