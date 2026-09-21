//! 下载任务元信息（IGlossDownloadTaskMeta）后端存储。
//!
//! 文件位置：`app_local_data_dir/download_meta.json`（与 collection_pending.json 同级，
//! 与前端 settings.json 分离）。前端形状不固定，用 `serde_json::Value` 透传，
//! 后端只做整表 get/set + 单键 remove，不解析字段。
//! 并发写与清单存储同策略：fs2 文件锁 + tmp 写再 rename。

use std::collections::HashMap;
use tauri::Manager;

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
    read_map(&app)
}

/// 整表覆盖（前端批量落盘用，与原 PersistentStore.set 整表语义一致）。
#[tauri::command]
pub(crate) fn dl_meta_save(
    app: tauri::AppHandle,
    map: HashMap<String, serde_json::Value>,
) -> Result<(), String> {
    write_map(&app, &map)
}

/// 单键写入/合并（建任务、导入标记等单点更新用，前端传合并后的单条）。
#[tauri::command]
pub(crate) fn dl_meta_put(
    app: tauri::AppHandle,
    gid: String,
    meta: serde_json::Value,
) -> Result<(), String> {
    let mut map = read_map(&app)?;
    map.insert(gid, meta);
    write_map(&app, &map)
}

/// 单键删除（清理/移除任务时调用，与 purge 链路同生命周期）。
#[tauri::command]
pub(crate) fn dl_meta_remove(app: tauri::AppHandle, gid: String) -> Result<(), String> {
    let mut map = read_map(&app)?;
    map.remove(&gid);
    write_map(&app, &map)
}
