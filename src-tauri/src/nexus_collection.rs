//! NexusMods Collection GraphQL 直调：revision 列表 + 文件清单归一化 + 待下载清单存储。
//!
//! 收益：apikey 不再经 WebView 发请求；超时/重试/解析统一在 Rust 侧；
//! 前端只拿归一化结果做弹窗渲染。
//! 上游：`POST https://api-router.nexusmods.com/graphql`，30s 超时。

use serde::{Deserialize, Serialize};

const GRAPHQL_URL: &str = "https://api-router.nexusmods.com/graphql";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollectionRevision {
    pub(crate) revision_number: i64,
    pub(crate) revision_status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollectionInfo {
    pub(crate) name: String,
    pub(crate) latest_revision_number: Option<i64>,
    pub(crate) mod_count: i64,
    pub(crate) revisions: Vec<CollectionRevision>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollectionFile {
    pub(crate) mod_id: String,
    pub(crate) file_id: String,
    pub(crate) name: String,
    pub(crate) version: String,
    pub(crate) optional: bool,
}

fn graphql_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("Gloss-Mod-Manager")
        .build()
        .map_err(|err| err.to_string())
}

async fn post_graphql(
    query: &str,
    variables: serde_json::Value,
    api_key: &str,
) -> Result<serde_json::Value, String> {
    let client = graphql_client()?;
    let mut request = client
        .post(GRAPHQL_URL)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "query": query, "variables": variables }));
    if !api_key.trim().is_empty() {
        request = request.header("apikey", api_key.trim());
    }
    let response = request
        .send()
        .await
        .map_err(|err| format!("获取 NexusMods Collection 信息失败：{err}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "获取 NexusMods Collection 信息失败：{}",
            response.status()
        ));
    }
    response
        .json::<serde_json::Value>()
        .await
        .map_err(|err| format!("解析 NexusMods Collection 信息失败：{err}"))
}

fn get_i64(value: &serde_json::Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|v| i64::try_from(v).ok()))
}

#[tauri::command]
pub(crate) async fn nexus_collection_info(
    game_domain: String,
    slug: String,
    api_key: Option<String>,
) -> Result<CollectionInfo, String> {
    let payload = post_graphql(
        "query CollectionInfo($slug: String, $domainName: String) {
            collection(slug: $slug, domainName: $domainName) {
                name
                latestPublishedRevision { revisionNumber modCount }
                revisions { revisionNumber revisionStatus }
            }
        }",
        serde_json::json!({ "slug": slug, "domainName": game_domain }),
        api_key.as_deref().unwrap_or(""),
    )
    .await?;
    let collection = payload
        .pointer("/data/collection")
        .ok_or_else(|| "未找到该 Collection。".to_string())?;
    if collection.is_null() {
        return Err("未找到该 Collection。".to_string());
    }
    let mut revisions: Vec<CollectionRevision> = collection
        .get("revisions")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|item| {
            get_i64(item.get("revisionNumber")?).map(|revision_number| CollectionRevision {
                revision_number,
                revision_status: item
                    .get("revisionStatus")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            })
        })
        .collect();
    revisions.sort_by_key(|item| std::cmp::Reverse(item.revision_number));
    Ok(CollectionInfo {
        name: collection
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(&slug)
            .to_string(),
        latest_revision_number: collection
            .get("latestPublishedRevision")
            .and_then(|v| v.get("revisionNumber"))
            .and_then(get_i64),
        mod_count: collection
            .get("latestPublishedRevision")
            .and_then(|v| v.get("modCount"))
            .and_then(get_i64)
            .unwrap_or(0),
        revisions,
    })
}

#[tauri::command]
pub(crate) async fn nexus_collection_files(
    game_domain: String,
    slug: String,
    revision: i64,
    api_key: Option<String>,
) -> Result<Vec<CollectionFile>, String> {
    let payload = post_graphql(
        "query CollectionRevisionFiles($slug: String, $revision: Int, $domainName: String) {
            collectionRevision(slug: $slug, revision: $revision, domainName: $domainName) {
                revisionNumber
                modCount
                modFiles {
                    fileId
                    version
                    optional
                    file { modId fileId name version }
                }
            }
        }",
        serde_json::json!({ "slug": slug, "revision": revision, "domainName": game_domain }),
        api_key.as_deref().unwrap_or(""),
    )
    .await?;
    let empty = Vec::new();
    let mod_files = payload
        .pointer("/data/collectionRevision/modFiles")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);
    Ok(mod_files
        .iter()
        .filter_map(|item| {
            let file = item.get("file");
            let mod_id = file.and_then(|f| f.get("modId")).and_then(get_i64)?;
            let file_id = file
                .and_then(|f| f.get("fileId"))
                .and_then(get_i64)
                .or_else(|| get_i64(item.get("fileId")?))?;
            let name = file
                .and_then(|f| f.get("name"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("文件 {file_id}"));
            let version = file
                .and_then(|f| f.get("version"))
                .and_then(|v| v.as_str())
                .or_else(|| item.get("version").and_then(|v| v.as_str()))
                .unwrap_or("")
                .to_string();
            Some(CollectionFile {
                mod_id: mod_id.to_string(),
                file_id: file_id.to_string(),
                name,
                version,
                optional: item
                    .get("optional")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            })
        })
        .collect())
}

// NexusMods Collection 待下载清单后端存储。
//
// 文件位置：`app_local_data_dir/collection_pending.json`（与前端 settings.json 分离，
// 数据量大时不污染设置文件）。并发写用 fs2 文件锁 + tmp 写再 rename，保证原子性。

use std::collections::HashMap;
use tauri::Manager;

const PENDING_FILE_NAME: &str = "collection_pending.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollectionPendingItem {
    pub(crate) mod_id: String,
    pub(crate) file_id: String,
    pub(crate) name: String,
    pub(crate) version: String,
    pub(crate) optional: bool,
    pub(crate) status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollectionPending {
    pub(crate) id: String,
    pub(crate) game_domain: String,
    pub(crate) slug: String,
    pub(crate) revision: i64,
    pub(crate) name: String,
    pub(crate) game: String,
    #[serde(default)]
    pub(crate) game_name: String,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
    pub(crate) items: Vec<CollectionPendingItem>,
}

fn pending_file_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("解析数据目录失败：{err}"))?;
    std::fs::create_dir_all(&dir).map_err(|err| format!("创建数据目录失败：{err}"))?;
    Ok(dir.join(PENDING_FILE_NAME))
}

fn read_map(app: &tauri::AppHandle) -> Result<HashMap<String, CollectionPending>, String> {
    let path = pending_file_path(app)?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let content =
        std::fs::read_to_string(&path).map_err(|err| format!("读取待下载清单失败：{err}"))?;
    if content.trim().is_empty() {
        return Ok(HashMap::new());
    }
    serde_json::from_str(&content).map_err(|err| format!("解析待下载清单失败：{err}"))
}

/// 原子写：同目录 tmp 写后 rename；fs2 跨进程文件锁防并发丢条目。
fn write_map(
    app: &tauri::AppHandle,
    map: &HashMap<String, CollectionPending>,
) -> Result<(), String> {
    use fs2::FileExt;
    let path = pending_file_path(app)?;
    let lock_path = path.with_extension("lock");
    // 锁文件仅用于 fs2 排他锁，内容无关：存在即复用，不截断。
    let lock_file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lock_path)
        .map_err(|err| format!("获取待下载清单锁失败：{err}"))?;
    lock_file
        .lock_exclusive()
        .map_err(|err| format!("获取待下载清单锁失败：{err}"))?;
    let result = (|| -> Result<(), String> {
        let content = serde_json::to_string_pretty(map)
            .map_err(|err| format!("序列化待下载清单失败：{err}"))?;
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, content).map_err(|err| format!("写入待下载清单失败：{err}"))?;
        std::fs::rename(&tmp, &path).map_err(|err| format!("写入待下载清单失败：{err}"))?;
        Ok(())
    })();
    let _ = lock_file.unlock();
    result
}

#[tauri::command]
pub(crate) fn collection_pending_list(
    app: tauri::AppHandle,
) -> Result<Vec<CollectionPending>, String> {
    let map = read_map(&app)?;
    let mut entries: Vec<CollectionPending> = map.into_values().collect();
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.updated_at));
    Ok(entries)
}

#[tauri::command]
pub(crate) fn collection_pending_save(
    app: tauri::AppHandle,
    entry: CollectionPending,
) -> Result<CollectionPending, String> {
    let mut map = read_map(&app)?;
    map.insert(entry.id.clone(), entry.clone());
    write_map(&app, &map)?;
    Ok(entry)
}

#[tauri::command]
pub(crate) fn collection_pending_update_item(
    app: tauri::AppHandle,
    id: String,
    mod_id: String,
    file_id: String,
    status: String,
    reason: Option<String>,
    updated_at: i64,
) -> Result<(), String> {
    let mut map = read_map(&app)?;
    if let Some(entry) = map.get_mut(&id) {
        for item in &mut entry.items {
            if item.mod_id == mod_id && item.file_id == file_id {
                item.status = status.clone();
                item.reason = reason.clone();
            }
        }
        entry.updated_at = updated_at;
        write_map(&app, &map)?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn collection_pending_remove(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut map = read_map(&app)?;
    map.remove(&id);
    write_map(&app, &map)?;
    Ok(())
}

#[tauri::command]
pub(crate) fn collection_pending_clear_finished(app: tauri::AppHandle) -> Result<(), String> {
    let mut map = read_map(&app)?;
    // 语义：仅保留仍有 pending 项的清单。
    map.retain(|_, entry| entry.items.iter().any(|item| item.status == "pending"));
    write_map(&app, &map)?;
    Ok(())
}
