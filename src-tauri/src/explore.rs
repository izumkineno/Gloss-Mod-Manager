//! 游览页后端化：Gloss 列表请求转发 + 下载状态判重。
//!
//! 前端只做纯渲染。Rust 侧手握下载器任务注册表（url/file_name/status 全在内存），
//! 列表返回时直接带每张卡的下载状态，前端不再做 N×(T+M) 全量扫描。

use super::downloader::DownloaderState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const API_BASE_URL: &str = "https://mod.3dmgame.com/api/v3";
const PAGE_SIZE_CAP: u32 = 48;

/// 前端透传的列表筛选参数（与 GlossMods.buildListUrl 对齐）。
#[derive(Deserialize)]
pub(crate) struct ExploreListParams {
    page: Option<u32>,
    #[serde(rename = "pageSize")]
    page_size: Option<u32>,
    search: Option<String>,
    original: Option<String>,
    time: Option<String>,
    #[serde(rename = "gameType")]
    game_type: Option<String>,
    #[serde(rename = "gameId")]
    game_id: Option<u32>,
    #[serde(default)]
    key: Vec<String>,
    #[serde(rename = "support_gmm")]
    support_gmm: Option<String>,
    local: Option<String>,
}

/// 单张卡的下载状态（前端直接渲染，不再计算）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExploreItemStatus {
    /// active/waiting/paused/error/complete/cloud/missing/none
    state: String,
    progress: u8,
    /// 匹配到的任务 gid（无则空串），供进度条从快照取数。
    gid: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExploreListResult {
    /// 后端原样透传的列表 JSON（前端按既有类型解析）。
    payload: serde_json::Value,
    /// modId -> 状态。
    status: HashMap<String, ExploreItemStatus>,
}

fn gloss_api_key(front_key: &str) -> Result<String, String> {
    // Vite 的 .env 只在前端 import.meta.env 可见，Rust 运行时读不到；
    // 由前端透传，环境变量仅作兜底。
    let key = front_key.trim().to_string();
    if !key.is_empty() {
        return Ok(key);
    }
    std::env::var("GLOSS_MOD_KEY")
        .map(|value| value.trim().to_string())
        .map_err(|_| "未读取到 GLOSS_MOD_KEY，请检查 .env 配置。".to_string())
        .and_then(|value| {
            if value.is_empty() {
                Err("未读取到 GLOSS_MOD_KEY，请检查 .env 配置。".to_string())
            } else {
                Ok(value)
            }
        })
}

fn normalize_compare(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect()
}

fn file_name_of_url(url: &str) -> String {
    url.split(['?', '#'])
        .next()
        .unwrap_or(url)
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_string()
}

/// 游览列表：Rust 转发 /mods 请求，并在 Rust 侧一次判重。
///
/// `local_mods`: 前端传入的本地已安装 mod 摘要（fileName/modName/webId），用于 imported 判定。
/// 任务判重走下载器内存注册表（url 精确匹配优先，其次文件名），O(T) 建索引后每卡 O(1)。
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn explore_list(
    state: tauri::State<'_, DownloaderState>,
    params: ExploreListParams,
    local_mods: Vec<LocalModBrief>,
    api_key: Option<String>,
) -> Result<ExploreListResult, String> {
    let api_key = gloss_api_key(api_key.as_deref().unwrap_or(""))?;
    let client = reqwest::Client::new();
    let mut request = client
        .get(format!("{API_BASE_URL}/mods"))
        .header("Accept", "application/json")
        .header("Authorization", api_key)
        .query(&[
            ("page", params.page.unwrap_or(1).max(1).to_string()),
            (
                "pageSize",
                params
                    .page_size
                    .unwrap_or(12)
                    .clamp(1, PAGE_SIZE_CAP)
                    .to_string(),
            ),
        ]);

    if let Some(value) = params.search.as_ref().map(|v| v.trim()) {
        if !value.is_empty() {
            request = request.query(&[("search", value)]);
        }
    }
    for (name, value) in [
        ("original", params.original.as_deref()),
        ("time", params.time.as_deref()),
        ("gameType", params.game_type.as_deref()),
    ] {
        if let Some(value) = value {
            if !value.trim().is_empty() && value != "all" {
                request = request.query(&[(name, value)]);
            }
        }
    }
    if let Some(game_id) = params.game_id {
        if game_id > 0 {
            request = request.query(&[("gameId", game_id.to_string())]);
        }
    }
    for tag in &params.key {
        if !tag.trim().is_empty() {
            request = request.query(&[("key", tag)]);
        }
    }
    if params.support_gmm.as_deref() == Some("1") {
        request = request.query(&[("support_gmm", "1")]);
    }
    if params.local.as_deref() == Some("1") {
        request = request.query(&[("local", "1")]);
    }

    let response = request.send().await.map_err(|err| err.to_string())?;
    let payload: serde_json::Value = response.json().await.map_err(|err| err.to_string())?;

    let status = build_status_map(&state, &payload, &local_mods);

    Ok(ExploreListResult { payload, status })
}

/// 本地已安装 mod 摘要（仅判重用字段）。
#[derive(Deserialize)]
pub(crate) struct LocalModBrief {
    #[serde(default, rename = "fileName")]
    file_name: String,
    #[serde(default, rename = "modName")]
    mod_name: String,
    #[serde(default, rename = "webId")]
    _web_id: String,
    #[serde(default, rename = "from")]
    _from: String,
}

/// 对 payload.data.data 逐卡判重：任务表建一次索引，本地表建一次 Set。
fn build_status_map(
    state: &DownloaderState,
    payload: &serde_json::Value,
    local_mods: &[LocalModBrief],
) -> HashMap<String, ExploreItemStatus> {
    let mut status_map = HashMap::new();
    let items = payload
        .pointer("/data/data")
        .and_then(|value| value.as_array());
    let Some(items) = items else {
        return status_map;
    };

    // 一次建索引：url 精确匹配 + 文件名匹配。
    let (url_index, name_index) = state.explore_index();
    let local_names: std::collections::HashSet<String> = local_mods
        .iter()
        .flat_map(|item| {
            [
                normalize_compare(&item.file_name),
                normalize_compare(&item.mod_name),
            ]
        })
        .filter(|name| !name.is_empty())
        .collect();

    for item in items {
        let mod_id = item
            .get("id")
            .map(|value| value.to_string().trim_matches('"').to_string())
            .unwrap_or_default();
        if mod_id.is_empty() || mod_id == "null" {
            continue;
        }
        let resources = item
            .get("mods_resource")
            .and_then(|value| value.as_array());
        let latest = resources.and_then(|list| {
            list.iter().find(|resource| {
                resource
                    .get("mods_resource_latest_version")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false)
            })
            .or_else(|| list.first())
        });
        let Some(latest) = latest else {
            status_map.insert(
                mod_id,
                ExploreItemStatus {
                    state: "missing".to_string(),
                    progress: 0,
                    gid: String::new(),
                },
            );
            continue;
        };
        let url = latest
            .get("mods_resource_url")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        if url.trim().is_empty() {
            status_map.insert(
                mod_id,
                ExploreItemStatus {
                    state: "missing".to_string(),
                    progress: 0,
                    gid: String::new(),
                },
            );
            continue;
        }
        // 云盘资源：前端直接展示外链按钮。
        if is_cloud_drive_url(&url) {
            status_map.insert(
                mod_id,
                ExploreItemStatus {
                    state: "cloud".to_string(),
                    progress: 0,
                    gid: String::new(),
                },
            );
            continue;
        }

        // 任务判重：url 优先，文件名次之。
        let matched = url_index
            .get(&url)
            .cloned()
            .or_else(|| {
                let name = file_name_of_url(&url);
                let normalized = normalize_compare(&name);
                if normalized.is_empty() {
                    None
                } else {
                    name_index.get(&normalized).cloned()
                }
            });

        let entry = if let Some((gid, task_status, progress)) = matched {
            ExploreItemStatus {
                state: task_status,
                progress,
                gid,
            }
        } else {
            // 本地判重：文件名/标题命中即 imported。
            let title = item
                .get("mods_title")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let resource_name = latest
                .get("mods_resource_name")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let imported = [resource_name, title].iter().any(|name| {
                let normalized = normalize_compare(name);
                !normalized.is_empty() && local_names.contains(&normalized)
            });
            ExploreItemStatus {
                state: if imported {
                    "imported".to_string()
                } else {
                    "none".to_string()
                },
                progress: if imported { 100 } else { 0 },
                gid: String::new(),
            }
        };
        status_map.insert(mod_id, entry);
    }

    status_map
}

fn is_cloud_drive_url(url: &str) -> bool {
    let lower = url.to_lowercase();
    ["pan.baidu.com", "alipan.com", "aliyundrive.com", "cloud.189.cn", "pan.xunlei.com", "lanzou"]
        .iter()
        .any(|domain| lower.contains(domain))
}
