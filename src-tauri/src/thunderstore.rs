//! Thunderstore 纯后端：列表缓存 + 过滤/排序/分页/归一化全在 Rust 侧，
//! 前端只做纯渲染。
//!
//! 背景：`GET /c/{community}/api/v1/package/` 无分页无过滤（page_size/ordering/search
//! 参数全部被忽略），valheim 一次返回约 1.1 万个包。Rust 内存缓存全量 JSON
//! （默认 10 分钟 TTL），每次请求在 Rust 侧完成过滤/排序/分页后只返回当页数据。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 缓存有效期：10 分钟。
const CACHE_TTL: Duration = Duration::from_secs(600);
/// 上游整体超时：30 秒。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// 内存缓存项：按 community 缓存上游原始 JSON 数组。
struct CacheEntry {
    fetched_at: Instant,
    payload: serde_json::Value,
}

#[derive(Default)]
pub(crate) struct ThunderstoreState {
    list_cache: Mutex<HashMap<String, CacheEntry>>,
}

/// 前端透传的列表查询参数（与 IThirdPartyListQuery 对齐）。
///
/// tauri 的 invoke 参数默认按 JS 传过来的 snake_case 反序列化，
/// 这里同时接受 snake_case 与 camelCase，避免 page 等参数丢失导致翻页无效。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThunderstoreListParams {
    community: String,
    page: Option<u32>,
    #[serde(alias = "page_size")]
    page_size: Option<u32>,
    #[serde(alias = "search_text")]
    search_text: Option<String>,
    sort: Option<String>,
}

/// 前端直接渲染的 mod 文件（与 IThirdPartyModFile 对齐，camelCase）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ThunderstoreModFile {
    id: String,
    name: String,
    version: String,
    size: u64,
    created_at: String,
    download_url: String,
    details_url: String,
}

/// 前端直接渲染的 mod 卡片（与 IThirdPartyModItem 对齐，camelCase）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ThunderstoreModItem {
    source: String,
    id: String,
    route_id: String,
    route_query: HashMap<String, String>,
    title: String,
    summary: String,
    author: String,
    version: String,
    website: String,
    cover: String,
    gallery: Vec<String>,
    downloads: u64,
    likes: i64,
    categories: Vec<String>,
    tags: Vec<String>,
    created_at: String,
    updated_at: String,
    nsfw: bool,
    files_count: u32,
    primary_file: Option<ThunderstoreModFile>,
}

/// 列表返回体（与 IThirdPartyModListResult 对齐，camelCase）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThunderstoreListResult {
    items: Vec<ThunderstoreModItem>,
    page: u32,
    page_size: u32,
    total_count: usize,
    total_pages: u32,
    cache_age_secs: u64,
}

fn thunderstore_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent("Gloss-Mod-Manager")
        .build()
        .map_err(|err| err.to_string())
}

/// 拉取上游全量包列表（原始 JSON 数组，不解析）。
async fn fetch_upstream_list(community: &str) -> Result<serde_json::Value, String> {
    let client = thunderstore_client()?;
    let response = client
        .get(format!(
            "https://thunderstore.io/c/{community}/api/v1/package/"
        ))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|err| format!("请求 Thunderstore 列表失败：{err}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "获取 Thunderstore 列表失败：{}",
            response.status()
        ));
    }

    response
        .json::<serde_json::Value>()
        .await
        .map_err(|err| format!("解析 Thunderstore 列表失败：{err}"))
}

/// 取缓存的全量数组（未命中/过期则回源），同时返回缓存年龄。
async fn cached_payload(
    state: &tauri::State<'_, ThunderstoreState>,
    community: &str,
    force_refresh: bool,
) -> Result<(serde_json::Value, u64), String> {
    if !force_refresh {
        if let Ok(cache) = state.list_cache.lock() {
            if let Some(entry) = cache.get(community) {
                if entry.fetched_at.elapsed() < CACHE_TTL {
                    return Ok((
                        entry.payload.clone(),
                        entry.fetched_at.elapsed().as_secs(),
                    ));
                }
            }
        }
    }

    let payload = fetch_upstream_list(community).await?;

    if let Ok(mut cache) = state.list_cache.lock() {
        cache.insert(
            community.to_string(),
            CacheEntry {
                fetched_at: Instant::now(),
                payload: payload.clone(),
            },
        );
    }

    Ok((payload, 0))
}

fn str_of(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string()
}

fn u64_of(value: &serde_json::Value, key: &str) -> u64 {
    value.get(key).and_then(|v| v.as_u64()).unwrap_or(0)
}

fn i64_of(value: &serde_json::Value, key: &str) -> i64 {
    value.get(key).and_then(|v| v.as_i64()).unwrap_or(0)
}

fn bool_of(value: &serde_json::Value, key: &str) -> bool {
    value
        .get(key)
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// 上游包归一化为前端卡片（与前端 normalizeThunderstoreMod 对齐）。
///
/// 注意列表与详情接口结构不同：列表项有 `uuid4`/`versions`/`latest.uuid4`；
/// 详情接口无 `uuid4` 无 `versions` 数组，`latest` 里也没有 `uuid4`/`file_size`。
/// id 兜底链：uuid4 → owner-name → namespace-name → name。
fn normalize_item(item: &serde_json::Value) -> Option<ThunderstoreModItem> {
    let owner = str_of(item, "owner").if_empty_then(&str_of(item, "namespace"));
    let name = str_of(item, "name");
    let uuid = str_of(item, "uuid4").if_empty_then(
        &format!(
            "{}-{}",
            if owner.is_empty() { "unknown" } else { &owner },
            if name.is_empty() { "unknown" } else { &name },
        ),
    );
    if name.is_empty() {
        return None;
    }

    let empty = serde_json::Value::Null;
    let latest = item.get("latest").unwrap_or(&empty);
    let latest = if latest.is_null() {
        item.get("versions")
            .and_then(|v| v.as_array())
            .and_then(|arr| arr.first())
            .unwrap_or(&empty)
    } else {
        latest
    };

    let primary_file = if latest.is_null() {
        None
    } else {
        let version_number = str_of(latest, "version_number");
        Some(ThunderstoreModFile {
            id: str_of(latest, "uuid4").if_empty_then(&version_number),
            name: str_of(latest, "full_name").if_empty_then(&str_of(latest, "name")),
            version: version_number,
            size: u64_of(latest, "file_size"),
            created_at: str_of(latest, "date_created"),
            download_url: str_of(latest, "download_url"),
            details_url: str_of(item, "package_url"),
        })
    };

    let mut route_query = HashMap::new();
    route_query.insert("source".to_string(), "Thunderstore".to_string());
    route_query.insert("namespace".to_string(), owner.clone());
    route_query.insert("name".to_string(), name.clone());

    let full_name = str_of(item, "full_name");
    let title = if full_name.is_empty() { name.clone() } else { full_name };
    let categories: Vec<String> = item
        .get("categories")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let cover = str_of(latest, "icon");
    let gallery = if cover.is_empty() {
        Vec::new()
    } else {
        vec![cover.clone()]
    };

    Some(ThunderstoreModItem {
        source: "Thunderstore".to_string(),
        id: uuid.clone(),
        route_id: uuid,
        route_query,
        title,
        summary: str_of(latest, "description"),
        author: owner,
        version: str_of(latest, "version_number"),
        website: str_of(item, "package_url"),
        cover,
        gallery,
        downloads: u64_of(latest, "downloads"),
        likes: i64_of(item, "rating_score"),
        categories: categories.clone(),
        tags: categories,
        created_at: str_of(item, "date_created"),
        updated_at: str_of(item, "date_updated"),
        nsfw: bool_of(item, "has_nsfw_content"),
        files_count: if primary_file.is_some() { 1 } else { 0 },
        primary_file,
    })
}

trait IfEmptyThen {
    fn if_empty_then(&self, fallback: &str) -> String;
}

impl IfEmptyThen for String {
    fn if_empty_then(&self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self.clone()
        }
    }
}

/// 列表：缓存 + 过滤 + 排序 + 分页 + 归一化，全在 Rust 侧。
#[tauri::command]
pub(crate) async fn thunderstore_list(
    state: tauri::State<'_, ThunderstoreState>,
    params: ThunderstoreListParams,
) -> Result<ThunderstoreListResult, String> {
    let community = params.community.trim().to_string();
    // 翻页故障排查：确认前端传进来的 page 到底是多少。
    tracing::info!(
        target: "gmm::thunderstore",
        community = %community,
        page = ?params.page,
        page_size = ?params.page_size,
        search = ?params.search_text,
        sort = ?params.sort,
        "thunderstore_list 请求参数",
    );
    if community.is_empty() {
        return Err("缺少 Thunderstore 社区标识。".to_string());
    }

    let (payload, cache_age_secs) = cached_payload(&state, &community, false).await?;
    let packages = payload.as_array().cloned().unwrap_or_default();

    let search = params
        .search_text
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_lowercase();

    let mut items: Vec<ThunderstoreModItem> = packages
        .iter()
        .filter(|item| !bool_of(item, "is_deprecated"))
        .filter(|item| {
            if search.is_empty() {
                return true;
            }
            let latest = item.get("latest").unwrap_or(&serde_json::Value::Null);
            let cats: Vec<String> = item
                .get("categories")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            let haystack = format!(
                "{} {} {} {} {}",
                str_of(item, "name"),
                str_of(item, "full_name"),
                str_of(item, "owner"),
                latest
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default(),
                cats.join(" "),
            );
            haystack.to_lowercase().contains(&search)
        })
        .filter_map(normalize_item)
        .collect();

    // 排序（与前端 sortThirdPartyListItems 语义对齐：downloads/updatedAt/createdAt）。
    match params.sort.as_deref().unwrap_or("default") {
        "createdAt" => items.sort_by(|a, b| b.created_at.cmp(&a.created_at)),
        "downloads" | "default" => items.sort_by(|a, b| b.downloads.cmp(&a.downloads)),
        _ => items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at)),
    }

    let page_size = params.page_size.unwrap_or(12).clamp(1, 48);
    let total_count = items.len();
    let total_pages = if total_count == 0 {
        0
    } else {
        total_count.div_ceil(page_size as usize) as u32
    };
    let page = params.page.unwrap_or(1).max(1).min(total_pages.max(1));
    let start = ((page - 1) * page_size) as usize;
    let page_items: Vec<ThunderstoreModItem> = items
        .into_iter()
        .skip(start)
        .take(page_size as usize)
        .collect();

    Ok(ThunderstoreListResult {
        items: page_items,
        page,
        page_size,
        total_count,
        total_pages,
        cache_age_secs,
    })
}

/// 缓存状态：前端用来显示“数据 x 分钟前更新”。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThunderstoreCacheStatus {
    pub cached: bool,
    /// 缓存年龄（秒），未缓存时为 None。
    pub age_secs: Option<u64>,
}

#[tauri::command]
pub(crate) async fn thunderstore_cache_status(
    state: tauri::State<'_, ThunderstoreState>,
    community: String,
) -> Result<ThunderstoreCacheStatus, String> {
    let community = community.trim().to_string();

    if let Ok(cache) = state.list_cache.lock() {
        if let Some(entry) = cache.get(&community) {
            return Ok(ThunderstoreCacheStatus {
                cached: true,
                age_secs: Some(entry.fetched_at.elapsed().as_secs()),
            });
        }
    }

    Ok(ThunderstoreCacheStatus {
        cached: false,
        age_secs: None,
    })
}

/// 手动刷新：强制回源并覆盖缓存，返回刷新后的包总数。
#[tauri::command]
pub(crate) async fn thunderstore_refresh(
    state: tauri::State<'_, ThunderstoreState>,
    community: String,
) -> Result<u64, String> {
    let community = community.trim().to_string();

    if community.is_empty() {
        return Err("缺少 Thunderstore 社区标识。".to_string());
    }

    let (payload, _) = cached_payload(&state, &community, true).await?;
    Ok(payload.as_array().map(|arr| arr.len() as u64).unwrap_or(0))
}

/// 详情归一化体（与 IThirdPartyModDetail 对齐，camelCase，前端直接渲染）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThunderstoreDetailResult {
    #[serde(flatten)]
    item: ThunderstoreModItem,
    description: String,
    description_format: String,
    files: Vec<ThunderstoreModFile>,
}

/// 详情：详情 + readme 都在 Rust 侧做并归一化（版本兜底只在 latest 缺失时才发）。
#[tauri::command]
pub(crate) async fn thunderstore_detail(
    namespace: String,
    name: String,
) -> Result<ThunderstoreDetailResult, String> {
    let namespace = namespace.trim().to_string();
    let name = name.trim().to_string();

    if namespace.is_empty() || name.is_empty() {
        return Err("缺少 Thunderstore 包标识。".to_string());
    }

    let client = thunderstore_client()?;
    let detail_url = format!(
        "https://thunderstore.io/api/experimental/package/{namespace}/{name}/"
    );
    let detail: serde_json::Value = client
        .get(&detail_url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|err| format!("读取 Thunderstore 详情失败：{err}"))?
        .json()
        .await
        .map_err(|err| format!("解析 Thunderstore 详情失败：{err}"))?;

    if detail.get("name").and_then(|v| v.as_str()).is_none() {
        return Err("读取 Thunderstore 详情失败。".to_string());
    }

    let mut merged = detail.clone();

    // latest 缺失时补拉版本接口。
    let latest_missing = merged
        .get("latest")
        .is_none_or(|v| v.is_null());
    if latest_missing {
        if let Some(first) = merged
            .get("versions")
            .and_then(|v| v.as_array())
            .and_then(|arr| arr.first())
        {
            let version_name = first
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if !version_name.is_empty() {
                let version_url = format!("{detail_url}{version_name}/");
                if let Ok(version) = client
                    .get(&version_url)
                    .header("Accept", "application/json")
                    .send()
                    .await
                {
                    if let Ok(payload) = version.json::<serde_json::Value>().await {
                        if payload.get("name").and_then(|v| v.as_str()).is_some() {
                            merged["latest"] = payload;
                        }
                    }
                }
            }
        }
    }

    let latest_name = merged
        .get("latest")
        .and_then(|v| v.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let readme_url = format!("{detail_url}{latest_name}/readme/");
    let readme_response = client
        .get(&readme_url)
        .header("Accept", "application/json")
        .send()
        .await
        .ok();
    let mut readme_markdown: Option<String> = None;
    if let Some(resp) = readme_response {
        if let Ok(payload) = resp.json::<serde_json::Value>().await {
            readme_markdown = payload
                .get("markdown")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
        }
    }

    let item = normalize_item(&merged).ok_or("解析 Thunderstore 详情失败。")?;
    let files = item.primary_file.clone().into_iter().collect::<Vec<_>>();
    let description = readme_markdown.unwrap_or_else(|| item.summary.clone());

    Ok(ThunderstoreDetailResult {
        item,
        description,
        description_format: "markdown".to_string(),
        files,
    })
}
