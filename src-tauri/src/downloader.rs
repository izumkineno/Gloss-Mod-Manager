//! 基于 simple_downloader 的进程内下载注册表。
//!
//! 前端经 `native-downloader.ts` 门面调用，任务状态为 active/waiting/paused/error/complete。
//! 并发上限 5；暂停 = 中止任务，
//! 恢复 = 携带 resume sidecar 重建（断点续传由 simple_downloader `resume` feature 保证）。

use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use tauri::Emitter;

const MAX_ACTIVE: usize = 5;

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum TaskStatus {
    Active,
    Waiting,
    Paused,
    Error,
    Complete,
}

impl TaskStatus {
    fn as_status_str(self) -> &'static str {
        match self {
            TaskStatus::Active => "active",
            TaskStatus::Waiting => "waiting",
            TaskStatus::Paused => "paused",
            TaskStatus::Error => "error",
            TaskStatus::Complete => "complete",
        }
    }
}

struct TaskEntry {
    gid: String,
    url: String,
    dir: String,
    file_name: String,
    headers: Vec<(String, String)>,
    workers: u64,
    proxy: Option<String>,
    status: TaskStatus,
    total: u64,
    downloaded: u64,
    speed: f64,
    error: Option<String>,
    handle: Option<tauri::async_runtime::JoinHandle<()>>,
    /// 上次 dl-progress 发送时刻（MonitorUpdate 节流，0.5s 一跳）。
    last_emit: Option<std::time::Instant>,
}

impl TaskEntry {
    fn output_path(&self) -> String {
        format!(
            "{}/{}",
            self.dir.trim_end_matches(['/', '\\']),
            self.file_name
        )
    }
}

#[derive(Default)]
struct Inner {
    tasks: HashMap<String, TaskEntry>,
    pending: VecDeque<String>,
}

#[derive(Default, Clone)]
pub struct DownloaderState {
    inner: std::sync::Arc<Mutex<Inner>>,
    app: std::sync::Arc<Mutex<Option<tauri::AppHandle>>>,
}

/// 进度增量（前端收到后拉一次快照；事件只做触发器，不做数据源）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DlProgress {
    gid: String,
    downloaded: u64,
    total: u64,
    speed: f64,
}

/// 任务终局/状态变迁（complete/error/paused/waiting/removed）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DlTaskChanged {
    gid: String,
    status: String,
}

impl DownloaderState {
    /// setup 时注入 AppHandle（manage 在 setup 之前，构造时拿不到）。
    pub fn set_app(&self, app: tauri::AppHandle) {
        *self.app.lock().expect("downloader app lock") = Some(app);
    }

    fn emit_progress(&self, payload: DlProgress) {
        if let Some(app) = self.app.lock().expect("downloader app lock").as_ref() {
            let _ = app.emit("dl-progress", payload);
        }
    }

    fn emit_changed(&self, gid: &str, status: &str) {
        if let Some(app) = self.app.lock().expect("downloader app lock").as_ref() {
            let _ = app.emit(
                "dl-task-changed",
                DlTaskChanged {
                    gid: gid.to_string(),
                    status: status.to_string(),
                },
            );
        }
    }
    /// 游览页判重索引：一次锁内建 url 精确索引 + 文件名索引。
    /// 返回 (url -> (gid, status, progress), normalizedFileName -> (gid, status, progress))。
    /// removed 状态不入索引；error/complete 保留（前端展示失败/重下）。
    pub(crate) fn explore_index(
        &self,
    ) -> (
        std::collections::HashMap<String, (String, String, u8)>,
        std::collections::HashMap<String, (String, String, u8)>,
    ) {
        let mut url_index = std::collections::HashMap::new();
        let mut name_index = std::collections::HashMap::new();
        let Ok(inner) = self.inner.lock() else {
            return (url_index, name_index);
        };
        for entry in inner.tasks.values() {
            let status = entry.status.as_status_str().to_string();
            let progress = if entry.total > 0 {
                ((entry.downloaded.min(entry.total) as f64 / entry.total as f64) * 100.0) as u8
            } else if status == "complete" {
                100
            } else {
                0
            };
            let record = (entry.gid.clone(), status, progress);
            if !entry.url.trim().is_empty() {
                url_index.insert(entry.url.clone(), record.clone());
            }
            let normalized: String = entry
                .file_name
                .to_lowercase()
                .chars()
                .filter(|ch| !ch.is_whitespace())
                .collect();
            if !normalized.is_empty() {
                name_index.entry(normalized).or_insert(record);
            }
        }
        (url_index, name_index)
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskFileSnapshot {
    path: String,
    length: String,
    completed_length: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskSnapshot {
    gid: String,
    status: String,
    total_length: String,
    completed_length: String,
    download_speed: String,
    dir: String,
    files: Vec<TaskFileSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_message: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GlobalStat {
    download_speed: String,
    num_active: String,
    num_waiting: String,
    num_stopped: String,
}

fn snapshot_of(entry: &TaskEntry) -> TaskSnapshot {
    let path = entry.output_path();
    TaskSnapshot {
        gid: entry.gid.clone(),
        status: entry.status.as_status_str().to_string(),
        total_length: entry.total.to_string(),
        completed_length: entry.downloaded.to_string(),
        download_speed: (entry.speed.max(0.0) as u64).to_string(),
        dir: entry.dir.clone(),
        files: vec![TaskFileSnapshot {
            path,
            length: entry.total.to_string(),
            completed_length: entry.downloaded.to_string(),
        }],
        error_message: entry.error.clone(),
    }
}

/// 启动一个任务的下载 future；结束（完成/失败/中止）后泵出等待队列。
fn spawn_task(state: DownloaderState, gid: String) {
    let worker_state = state.clone();
    let worker_gid = gid.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let (url, output, headers, workers, proxy) = {
            let inner = state.inner.lock().expect("downloader lock");
            match inner.tasks.get(&gid) {
                Some(entry) => (
                    entry.url.clone(),
                    entry.output_path(),
                    entry.headers.clone(),
                    entry.workers.max(1),
                    entry.proxy.clone(),
                ),
                None => return,
            }
        };

        let proxy_for_builder = proxy.clone();
        let builder = simple_downloader::Downloader::builder(url, output)
            .workers(workers)
            .resume(true)
            .headers(headers)
            .client_builder(move || {
                let mut client =
                    simple_downloader::reqwest::ClientBuilder::new().connect_timeout(
                        std::time::Duration::from_secs(10),
                    );
                if let Some(proxy_url) = proxy_for_builder.as_deref() {
                    if let Ok(proxy) = simple_downloader::reqwest::Proxy::all(proxy_url) {
                        client = client.proxy(proxy);
                    }
                }
                client
            });


        let state_for_progress = state.clone();
        let gid_for_progress = gid.clone();
        let result = builder
            .run(|total_size, mut info_rx| async move {
                // 块级落盘累加：MonitorUpdate 默认 0.5s 一跳，小文件零 Tick 照样有进度；
                // ChunkProgress.downloaded 为单块累计（非增量），按块 id 取最大后求和。
                let mut chunk_downloaded: HashMap<simple_downloader::ChunkId, u64> =
                    HashMap::new();
                {
                    let mut inner = state_for_progress
                        .inner
                        .lock()
                        .expect("downloader lock");
                    if let Some(entry) = inner.tasks.get_mut(&gid_for_progress) {
                        entry.total = total_size;
                    }
                }
                while let Ok(info) = info_rx.recv().await {
                    let mut inner = state_for_progress
                        .inner
                        .lock()
                        .expect("downloader lock");
                    let Some(entry) = inner.tasks.get_mut(&gid_for_progress) else {
                        break;
                    };
                    match info {
                        simple_downloader::DownloadInfo::MonitorUpdate {
                            total_size,
                            total_downloaded,
                            total_speed,
                            ..
                        } => {
                            entry.total = entry.total.max(total_size);
                            entry.downloaded = total_downloaded;
                            entry.speed = total_speed;
                            // 0.5s 节流：事件只做触发器，前端收到后拉快照。
                            let now = std::time::Instant::now();
                            let due = entry
                                .last_emit
                                .map(|at| now.duration_since(at).as_millis() >= 500)
                                .unwrap_or(true);
                            if due {
                                entry.last_emit = Some(now);
                                let payload = DlProgress {
                                    gid: gid_for_progress.clone(),
                                    downloaded: entry.downloaded,
                                    total: entry.total,
                                    speed: entry.speed,
                                };
                                drop(inner);
                                state_for_progress.emit_progress(payload);
                                continue;
                            }
                        }
                        simple_downloader::DownloadInfo::ChunkProgress {
                            id,
                            downloaded,
                            ..
                        } => {
                            let slot = chunk_downloaded.entry(id).or_insert(0);
                            *slot = (*slot).max(downloaded);
                            let summed: u64 = chunk_downloaded.values().sum();
                            entry.downloaded = entry.downloaded.max(summed);
                        }
                        _ => {}
                    }
                }
            })
            .await;

        let terminal = {
            let mut inner = state.inner.lock().expect("downloader lock");
            let terminal = if let Some(entry) = inner.tasks.get_mut(&gid) {
                entry.handle = None;
                entry.speed = 0.0;
                // 中止（pause/cancel）时状态已被调用方改写，不覆盖。
                if entry.status == TaskStatus::Active {
                    match result {
                        Ok(()) => {
                            entry.status = TaskStatus::Complete;
                            // 终局对齐：成功即全量（零 Tick/流式场景 downloaded 可能滞后）。
                            if entry.total > 0 {
                                entry.downloaded = entry.total;
                            } else {
                                entry.total = entry.downloaded;
                            }
                        }
                        Err(error) => {
                            entry.status = TaskStatus::Error;
                            entry.error = Some(error.to_string());
                        }
                    }
                }
                (entry.status == TaskStatus::Complete || entry.status == TaskStatus::Error)
                    .then(|| (gid.clone(), entry.status.as_status_str().to_string()))
            } else {
                None
            };
            drop(inner);
            terminal
        };
        if let Some((done_gid, status)) = terminal {
            state.emit_changed(&done_gid, &status);
        }
        pump(state.clone());
    });

    let mut inner = worker_state.inner.lock().expect("downloader lock");
    if let Some(entry) = inner.tasks.get_mut(&worker_gid) {
        entry.handle = Some(handle);
    }
}

/// 泵出等待队列：临界区只做标记，spawn 在锁外，避免与 worker 回调的锁嵌套。
fn pump(state: DownloaderState) {
    let starters: Vec<String> = {
        let mut inner = state.inner.lock().expect("downloader lock");
        let active = inner
            .tasks
            .values()
            .filter(|entry| entry.status == TaskStatus::Active)
            .count();
        let mut slots = MAX_ACTIVE.saturating_sub(active);
        let mut starters = Vec::new();
        while slots > 0 {
            let Some(next) = inner.pending.pop_front() else {
                break;
            };
            let alive = inner
                .tasks
                .get(&next)
                .is_some_and(|entry| entry.status == TaskStatus::Waiting);
            if !alive {
                continue;
            }
            slots -= 1;
            if let Some(entry) = inner.tasks.get_mut(&next) {
                entry.status = TaskStatus::Active;
                entry.error = None;
            }
            starters.push(next);
        }
        starters
    };
    for next in starters {
        spawn_task(state.clone(), next);
    }
}

#[tauri::command]
pub fn dl_enqueue(
    state: tauri::State<DownloaderState>,
    url: String,
    dir: String,
    file_name: String,
    headers: HashMap<String, String>,
    workers: u64,
    proxy: Option<String>,
) -> Result<String, String> {
    if url.trim().is_empty() {
        return Err("下载地址为空".to_string());
    }
    if file_name.trim().is_empty() {
        return Err("输出文件名为空".to_string());
    }
    let gid = uuid::Uuid::new_v4().to_string();
    let header_vec: Vec<(String, String)> = headers.into_iter().collect();
    {
        let mut inner = state.inner.lock().map_err(|_| "下载注册表锁异常".to_string())?;
        inner.tasks.insert(
            gid.clone(),
            TaskEntry {
                gid: gid.clone(),
                url,
                dir,
                file_name,
                headers: header_vec,
                workers: workers.max(1),
                proxy: proxy.and_then(|value| {
                    let trimmed = value.trim().to_string();
                    if trimmed.is_empty() {
                        None
                    } else {
                        Some(trimmed)
                    }
                }),
                status: TaskStatus::Waiting,
                total: 0,
                downloaded: 0,
                speed: 0.0,
                error: None,
                handle: None,
                last_emit: None,
            },
        );
        inner.pending.push_back(gid.clone());
    }
    pump((*state).clone());
    // 入队即事件：前端纯事件驱动需要此触发器，否则新任务要等下一次刷新才出现。
    state.emit_changed(&gid, TaskStatus::Waiting.as_status_str());
    Ok(gid)
}

fn abort_entry(entry: &mut TaskEntry) {
    if let Some(handle) = entry.handle.take() {
        handle.abort();
    }
    entry.speed = 0.0;
}

#[tauri::command]
pub fn dl_pause(state: tauri::State<DownloaderState>, gid: String) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|_| "下载注册表锁异常".to_string())?;
    let Some(entry) = inner.tasks.get_mut(&gid) else {
        return Err(format!("任务不存在：{gid}"));
    };
    if entry.status == TaskStatus::Active {
        abort_entry(entry);
    }
    entry.status = TaskStatus::Paused;
    inner.pending.retain(|pending| pending != &gid);
    drop(inner);
    // 腾出槽位后泵出等待队列。
    state.emit_changed(&gid, TaskStatus::Paused.as_status_str());
    pump((*state).clone());
    Ok(())
}

#[tauri::command]
pub fn dl_resume(state: tauri::State<DownloaderState>, gid: String) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|_| "下载注册表锁异常".to_string())?;
    let Some(entry) = inner.tasks.get_mut(&gid) else {
        return Err(format!("任务不存在：{gid}"));
    };
    if entry.status == TaskStatus::Active || entry.status == TaskStatus::Complete {
        return Ok(());
    }
    entry.status = TaskStatus::Waiting;
    entry.error = None;
    if !inner.pending.contains(&gid) {
        inner.pending.push_back(gid.clone());
    }
    drop(inner);
    state.emit_changed(&gid, TaskStatus::Waiting.as_status_str());
    pump((*state).clone());
    Ok(())
}

#[tauri::command]
pub fn dl_cancel(
    state: tauri::State<DownloaderState>,
    gid: String,
    delete_file: bool,
) -> Result<(), String> {
    let output = {
        let mut inner = state.inner.lock().map_err(|_| "下载注册表锁异常".to_string())?;
        let Some(mut entry) = inner.tasks.remove(&gid) else {
            return Ok(());
        };
        abort_entry(&mut entry);
        inner.pending.retain(|pending| pending != &gid);
        entry.output_path()
    };
    if delete_file {
        let _ = std::fs::remove_file(&output);
        let _ = std::fs::remove_file(format!("{output}.download.bitcode"));
    }
    state.emit_changed(&gid, "removed");
    pump((*state).clone());
    Ok(())
}

/// 仅遗忘已终局任务，不删文件。
#[tauri::command]
pub fn dl_forget(state: tauri::State<DownloaderState>, gid: String) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|_| "下载注册表锁异常".to_string())?;
    if let Some(entry) = inner.tasks.get(&gid) {
        if entry.status == TaskStatus::Active || entry.status == TaskStatus::Waiting {
            return Err("任务尚未终局".to_string());
        }
    }
    inner.tasks.remove(&gid);
    inner.pending.retain(|pending| pending != &gid);
    Ok(())
}

/// 更新后续启动（重试/恢复）生效的参数。
#[tauri::command]
pub fn dl_change_option(
    state: tauri::State<DownloaderState>,
    gid: String,
    headers: HashMap<String, String>,
    workers: u64,
    proxy: Option<String>,
) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|_| "下载注册表锁异常".to_string())?;
    let Some(entry) = inner.tasks.get_mut(&gid) else {
        return Err(format!("任务不存在：{gid}"));
    };
    entry.headers = headers.into_iter().collect();
    entry.workers = workers.max(1);
    entry.proxy = proxy.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });
    Ok(())
}

#[tauri::command]
pub fn dl_tell_status(
    state: tauri::State<DownloaderState>,
    gid: String,
) -> Result<TaskSnapshot, String> {
    let inner = state.inner.lock().map_err(|_| "下载注册表锁异常".to_string())?;
    inner
        .tasks
        .get(&gid)
        .map(snapshot_of)
        .ok_or_else(|| format!("任务不存在：{gid}"))
}

fn collect_by(
    inner: &Inner,
    matches: fn(TaskStatus) -> bool,
    offset: usize,
    num: usize,
) -> Vec<TaskSnapshot> {
    let mut snapshots: Vec<TaskSnapshot> = inner
        .tasks
        .values()
        .filter(|entry| matches(entry.status))
        .map(snapshot_of)
        .collect();
    snapshots.sort_by(|left, right| left.gid.cmp(&right.gid));
    snapshots.into_iter().skip(offset).take(num).collect()
}

#[tauri::command]
pub fn dl_tell_active(state: tauri::State<DownloaderState>) -> Result<Vec<TaskSnapshot>, String> {
    let inner = state.inner.lock().map_err(|_| "下载注册表锁异常".to_string())?;
    Ok(collect_by(&inner, |status| status == TaskStatus::Active, 0, usize::MAX))
}

#[tauri::command]
pub fn dl_tell_waiting(
    state: tauri::State<DownloaderState>,
    offset: usize,
    num: usize,
) -> Result<Vec<TaskSnapshot>, String> {
    let inner = state.inner.lock().map_err(|_| "下载注册表锁异常".to_string())?;
    Ok(collect_by(
        &inner,
        |status| status == TaskStatus::Waiting || status == TaskStatus::Paused,
        offset,
        num,
    ))
}

#[tauri::command]
pub fn dl_tell_stopped(
    state: tauri::State<DownloaderState>,
    offset: usize,
    num: usize,
) -> Result<Vec<TaskSnapshot>, String> {
    let inner = state.inner.lock().map_err(|_| "下载注册表锁异常".to_string())?;
    Ok(collect_by(
        &inner,
        |status| status == TaskStatus::Complete || status == TaskStatus::Error,
        offset,
        num,
    ))
}

#[tauri::command]
pub fn dl_global_stat(state: tauri::State<DownloaderState>) -> Result<GlobalStat, String> {
    let inner = state.inner.lock().map_err(|_| "下载注册表锁异常".to_string())?;
    let mut active = 0;
    let mut waiting = 0;
    let mut stopped = 0;
    let mut speed = 0u64;
    for entry in inner.tasks.values() {
        match entry.status {
            TaskStatus::Active => {
                active += 1;
                speed += entry.speed.max(0.0) as u64;
            }
            TaskStatus::Waiting | TaskStatus::Paused => waiting += 1,
            TaskStatus::Complete | TaskStatus::Error => stopped += 1,
        }
    }
    Ok(GlobalStat {
        download_speed: speed.to_string(),
        num_active: active.to_string(),
        num_waiting: waiting.to_string(),
        num_stopped: stopped.to_string(),
    })
}
// ---------- 从服务器获取文件名（移植自 sdownloader lib.rs） ----------
// 优先级：Content-Disposition（含 filename* RFC5987/6266）> 预签名 URL 查询参数
// response-content-disposition > URL 尾段；无扩展名时按 Content-Type 补扩展名。
const PROBE_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeFilename {
    name: String,
    source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_bytes: Option<u64>,
}

// 百分号解码（URL 尾段 / filename* / 查询参数共用，不引入新依赖）。
fn percent_decode(s: &str) -> String {
    let mut buf = Vec::with_capacity(s.len());
    let b = s.as_bytes();
    let mut i = 0;
    let hex = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    };
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                buf.push(h << 4 | l);
                i += 3;
                continue;
            }
        }
        buf.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&buf).into_owned()
}

// 非法字符替换 + Windows 保留名/尾点空格/超长保护。
fn sanitize_file_name(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    s = s.trim().to_string();
    while s.ends_with('.') || s.ends_with(' ') {
        s.pop();
    }
    if s.is_empty() {
        return "download.bin".to_string();
    }
    let upper = s.to_ascii_uppercase();
    let stem = upper.split('.').next().unwrap_or("");
    if matches!(
        stem,
        "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "COM2" | "COM3" | "COM4" | "COM5" | "COM6"
            | "COM7" | "COM8" | "COM9" | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6"
            | "LPT7" | "LPT8" | "LPT9"
    ) {
        s = format!("_{s}");
    }
    const MAX: usize = 180;
    if s.chars().count() > MAX {
        if let Some(dot) = s.rfind('.') {
            let ext: String = s[dot + 1..].chars().take(16).collect();
            if !ext.is_empty() && ext.len() < s.len() {
                let keep = MAX.saturating_sub(ext.len() + 1);
                let stem: String = s.chars().take(keep).collect();
                return format!("{stem}.{ext}");
            }
        }
        s = s.chars().take(MAX).collect();
    }
    s
}

// filename*（RFC5987 编码）优先于普通 filename。
fn filename_from_disposition(value: &str) -> Option<String> {
    let mut plain: Option<String> = None;
    for part in value.split(';') {
        let (key, val) = match part.split_once('=') {
            Some((k, v)) => (k.trim(), v.trim()),
            None => continue,
        };
        if key.eq_ignore_ascii_case("filename*") {
            let val = val.trim_matches('"').trim();
            let encoded = match val.split_once('\'') {
                Some((_, after)) => after.split_once('\'').map(|(_, v)| v).unwrap_or(after),
                None => val,
            };
            let decoded = percent_decode(encoded).trim().to_string();
            if !decoded.is_empty() {
                return Some(decoded);
            }
        } else if key.eq_ignore_ascii_case("filename") {
            let v = val.trim_matches('"').trim();
            if !v.is_empty() && plain.is_none() {
                plain = Some(v.to_string());
            }
        }
    }
    plain
}

fn ext_for_mime(mime: &str) -> Option<&'static str> {
    match mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "application/pdf" => Some("pdf"),
        "application/zip" | "application/x-zip-compressed" => Some("zip"),
        "application/gzip" | "application/x-gzip" => Some("gz"),
        "application/x-tar" => Some("tar"),
        "application/x-7z-compressed" => Some("7z"),
        "application/vnd.rar" | "application/x-rar-compressed" => Some("rar"),
        "application/zstd" => Some("zst"),
        "application/json" => Some("json"),
        "text/html" => Some("html"),
        "text/plain" => Some("txt"),
        "text/csv" => Some("csv"),
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/svg+xml" => Some("svg"),
        "video/mp4" => Some("mp4"),
        "video/webm" => Some("webm"),
        "audio/mpeg" => Some("mp3"),
        "audio/ogg" => Some("ogg"),
        _ => None,
    }
}

fn ensure_extension(name: &str, mime: Option<&str>) -> String {
    if let Some(dot) = name.rfind('.') {
        if dot + 1 < name.len() && name.len() - dot - 1 <= 10 {
            return name.to_string();
        }
    }
    if let Some(m) = mime.and_then(ext_for_mime) {
        return format!("{name}.{m}");
    }
    name.to_string()
}

fn name_from_url(url: &str) -> Option<String> {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let raw = path.rsplit('/').next().unwrap_or("").trim();
    if raw.is_empty() {
        return None;
    }
    let decoded = percent_decode(raw).trim().to_string();
    if decoded.is_empty() {
        return None;
    }
    Some(sanitize_file_name(&decoded))
}

// 预签名 URL（如 S3 response-content-disposition）中的文件名。
fn name_from_query(url: &str) -> Option<String> {
    let q = url.split('?').nth(1)?.split('#').next().unwrap_or("");
    for kv in q.split('&') {
        let (k, v) = kv.split_once('=')?;
        if !k.trim().eq_ignore_ascii_case("response-content-disposition") {
            continue;
        }
        let disp = percent_decode(&v.replace('+', " "));
        let name = filename_from_disposition(disp.trim())?;
        if !name.trim().is_empty() {
            return Some(sanitize_file_name(name.trim()));
        }
    }
    None
}

fn suggest_from_headers(
    headers: &simple_downloader::reqwest::header::HeaderMap,
    final_url: &str,
) -> (Option<String>, Option<String>) {
    use simple_downloader::reqwest::header::{CONTENT_DISPOSITION, CONTENT_TYPE};
    let disp = headers
        .get(CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok())
        .and_then(filename_from_disposition)
        .map(|n| sanitize_file_name(&n));
    let ctype = headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let name = disp
        .or_else(|| name_from_query(final_url))
        .or_else(|| name_from_url(final_url));
    let name = name.map(|n| ensure_extension(&n, ctype.as_deref()));
    (name, ctype)
}

// 206 优先 Content-Range 总量（Range 0-0 的 Content-Length 只有 1 字节）；HEAD/200 回退 Content-Length。
fn total_from_headers(headers: &simple_downloader::reqwest::header::HeaderMap) -> Option<u64> {
    use simple_downloader::reqwest::header::{CONTENT_LENGTH, CONTENT_RANGE};
    if let Some(total) = headers
        .get(CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.rsplit('/').next())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|v| *v > 0)
    {
        return Some(total);
    }
    headers
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|v| *v > 0)
}

fn probe_http_error(status: u16) -> String {
    match status {
        401 | 403 => format!("服务器拒绝访问({status})，链接可能已过期或需要登录"),
        404 | 410 => format!("链接不存在({status})，请检查链接是否有效"),
        408 | 429 => format!("服务器繁忙({status})，稍后重试"),
        500..=599 => format!("服务器错误({status})，稍后重试"),
        _ => format!("服务器返回({status})，未能获取文件名"),
    }
}

fn probe_client(
    url: &str,
    headers: &[(String, String)],
    proxy: Option<&str>,
) -> Option<simple_downloader::reqwest::Client> {
    use std::time::Duration;
    let mut b = simple_downloader::reqwest::ClientBuilder::new()
        .http1_only()
        .connect_timeout(Duration::from_secs(10));
    // 探测默认浏览器 UA：部分站点无 UA 直接拒绝。
    let has_ua = headers.iter().any(|(k, _)| k.trim().eq_ignore_ascii_case("user-agent"));
    if !has_ua {
        b = b.user_agent(PROBE_UA);
    }
    if headers.iter().any(|(k, _)| k.trim().eq_ignore_ascii_case("referer")) {
        // 用户显式 Referer 优先，不注入 origin。
    } else if let Some(origin) = origin_referer(url) {
        b = b.default_headers({
            let mut m = simple_downloader::reqwest::header::HeaderMap::new();
            if let Ok(v) = simple_downloader::reqwest::header::HeaderValue::from_str(&origin) {
                m.insert(simple_downloader::reqwest::header::REFERER, v);
            }
            m
        });
    }
    {
        use simple_downloader::reqwest::header::{HeaderName, HeaderValue};
        let mut m = simple_downloader::reqwest::header::HeaderMap::new();
        for (k, v) in headers {
            if let (Ok(name), Ok(value)) =
                (HeaderName::from_bytes(k.trim().as_bytes()), HeaderValue::from_str(v.trim()))
            {
                m.insert(name, value);
            }
        }
        if !m.is_empty() {
            // default_headers 会与上面的 Referer 合并，同名时显式 headers 生效。
            b = b.default_headers(m);
        }
    }
    if let Some(px) = proxy.map(str::trim).filter(|s| !s.is_empty()) {
        if let Ok(proxy) = simple_downloader::reqwest::Proxy::all(px) {
            b = b.proxy(proxy);
        }
    }
    b.timeout(Duration::from_secs(8)).build().ok()
}

fn origin_referer(url: &str) -> Option<String> {
    let s = url.trim();
    let scheme_end = s.find("://")?;
    let scheme = &s[..scheme_end];
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return None;
    }
    let rest = &s[scheme_end + 3..];
    let end = rest.find(|c| c == '/' || c == '?' || c == '#').unwrap_or(rest.len());
    let authority = rest[..end].trim();
    if authority.is_empty() || authority.contains(char::is_whitespace) {
        return None;
    }
    Some(format!("{}://{authority}/", &s[..scheme_end]))
}

fn hit_from_response(resp: &simple_downloader::reqwest::Response) -> Option<ProbeFilename> {
    let final_url = resp.url().as_str().to_string();
    let (name, ctype) = suggest_from_headers(resp.headers(), &final_url);
    name.map(|n| {
        let is_header = resp
            .headers()
            .contains_key(simple_downloader::reqwest::header::CONTENT_DISPOSITION);
        ProbeFilename {
            name: n,
            source: if is_header { "header".to_string() } else { "url".to_string() },
            content_type: ctype,
            total_bytes: total_from_headers(resp.headers()),
        }
    })
}

async fn probe_filename_inner(
    url: &str,
    headers: &[(String, String)],
    proxy: Option<&str>,
) -> Result<ProbeFilename, String> {
    use simple_downloader::reqwest::header::RANGE;
    let client = probe_client(url, headers, proxy).ok_or_else(|| "无法创建探测请求".to_string())?;
    let mut status: Option<u16> = None;
    // HEAD 优先：不拉取 body；部分服务不支持 HEAD 时回退 Range 0-0。
    if let Ok(resp) = client.head(url).send().await {
        if resp.status().is_success() {
            if let Some(hit) = hit_from_response(&resp) {
                return Ok(hit);
            }
        } else {
            status = Some(resp.status().as_u16());
        }
    }
    if let Ok(resp) = client.get(url).header(RANGE, "bytes=0-0").send().await {
        let code = resp.status().as_u16();
        if resp.status().is_success() || code == 206 {
            if let Some(hit) = hit_from_response(&resp) {
                return Ok(hit);
            }
        } else {
            status = Some(code);
        }
    }
    if let Some(code) = status {
        return Err(probe_http_error(code));
    }
    match name_from_url(url) {
        Some(n) => Ok(ProbeFilename {
            name: n,
            source: "url".to_string(),
            content_type: None,
            total_bytes: None,
        }),
        None => Err("无法从链接推断文件名".to_string()),
    }
}

/// 从服务器获取文件名：前端建任务前调用，拿到真名后再 dl_enqueue。
/// headers/proxy 与下载链路一致（鉴权站探测同样需要 Cookie/Referer/代理）。
#[tauri::command]
pub async fn dl_probe_filename(
    url: String,
    headers: HashMap<String, String>,
    proxy: Option<String>,
) -> Result<ProbeFilename, String> {
    let header_vec: Vec<(String, String)> = headers.into_iter().collect();
    let proxy_str = proxy.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    // 探测客户端自带 8s 超时（probe_client 内置），无需额外 tokio 依赖。
    probe_filename_inner(&url, &header_vec, proxy_str.as_deref()).await
}
/// NexusMods Cookie 直连解析（GreasyFork Nexus No Wait 原理的后端版）。
/// 登录 Cookie 调站内 GenerateDownloadUrl 接口直接拿 CDN 直链，免 API 排队/倒计时。
/// 返回直链 URL；Cookie 失效/缺文件时返回中文错误，前端回退 API 模式或提示重填。
#[tauri::command]
pub async fn nexus_resolve_direct(
    game_domain: String,
    mod_id: String,
    file_id: String,
    cookie: String,
    is_nmm: Option<bool>,
    proxy: Option<String>,
) -> Result<String, String> {
    use simple_downloader::reqwest::header::{HeaderValue, COOKIE, ORIGIN, REFERER, USER_AGENT};
    let game_domain = game_domain.trim().to_string();
    let mod_id = mod_id.trim().to_string();
    let file_id = file_id.trim().to_string();
    let cookie = cookie.trim().to_string();
    if game_domain.is_empty() || mod_id.is_empty() || file_id.is_empty() {
        return Err("缺少游戏/Mod/文件参数。".to_string());
    }
    if cookie.is_empty() {
        return Err("未配置 NexusMods Cookie，请在设置页填写。".to_string());
    }
    let game_id = nexus_game_id(&game_domain, &cookie, proxy.as_deref()).await?;
    let mut builder = simple_downloader::reqwest::ClientBuilder::new()
        .user_agent(PROBE_UA)
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(20));
    if let Some(px) = proxy.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if let Ok(p) = simple_downloader::reqwest::Proxy::all(px) {
            builder = builder.proxy(p);
        }
    }
    let client = builder.build().map_err(|_| "无法创建下载请求。".to_string())?;
    // 站内直链接口：fid=文件 id，game_id=数字 id，nmm=1 走 Mod Manager 通道。
    let nmm_flag = if is_nmm.unwrap_or(false) { "1" } else { "0" };
    let body = format!("fid={}&game_id={}&nmm={}", file_id, game_id, nmm_flag);
    let page_url = format!(
        "https://www.nexusmods.com/{}/mods/{}?tab=files&file_id={}{}",
        game_domain,
        mod_id,
        file_id,
        if is_nmm.unwrap_or(false) { "&nmm=1" } else { "" }
    );
    let resp = client
        .post("https://www.nexusmods.com/Core/Libs/Common/Managers/Downloads?GenerateDownloadUrl")
        .header(COOKIE, HeaderValue::from_str(&cookie).map_err(|_| "Cookie 格式非法。".to_string())?)
        .header(USER_AGENT, PROBE_UA)
        .header(REFERER, HeaderValue::from_str(&page_url).unwrap_or(HeaderValue::from_static("https://www.nexusmods.com/")))
        .header(ORIGIN, "https://www.nexusmods.com")
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("请求 NexusMods 直链失败：{e}"))?;
    if resp.status().as_u16() == 403 || resp.status().as_u16() == 401 {
        return Err("Cookie 已失效，请重新登录 NexusMods 后更新 Cookie。".to_string());
    }
    if !resp.status().is_success() {
        return Err(format!("NexusMods 返回异常（{}），请稍后重试。", resp.status().as_u16()));
    }
    let text = resp.text().await.map_err(|e| format!("读取直链响应失败：{e}"))?;
    // 响应为 JSON 或 HTML 片段，统一正则提取可用直链（nxm/CDN/api/files 均可）。
    for pat in [
        "https://filedelivery.nexus-cdn.com",
        "https://files.nexus-cdn.com",
        "https://filedelivery-eu.nexus-cdn.com",
        "nxm://",
        "https://www.nexusmods.com/",
    ] {
        if let Some(url) = extract_url_with_prefix(&text, pat) {
            // file_id 兜底页不是直链，跳过继续找 CDN。
            if url.contains("file_id=") && !url.contains("nexus-cdn.com") {
                continue;
            }
            return Ok(url);
        }
    }
    // JSON 形态 {"url": "..."} 兜底。
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
        if let Some(u) = v.get("url").and_then(|x| x.as_str()).map(str::trim).filter(|s| !s.is_empty()) {
            return Ok(u.to_string());
        }
    }
    Err("未能解析出下载直链（可能需要登录或文件已归档）。".to_string())
}
/// 从响应文本中提取以指定前缀开头的 URL（到引号/空白/反斜杠处截断）。
fn extract_url_with_prefix(text: &str, prefix: &str) -> Option<String> {
    let start = text.find(prefix)?;
    let rest = &text[start..];
    let end = rest
        .find(|c| c == '"' || c == '\'' || c == '\\' || c == ' ' || c == '<' || c == '>')
        .unwrap_or(rest.len());
    let mut url = rest[..end].replace("\\/", "/").replace("&amp;", "&");
    // JSON 转义的 \u0026 等只处理最常见的 &。
    url = url.replace("\\u0026", "&");
    if url.len() > 12 {
        Some(url)
    } else {
        None
    }
}
/// game_domain -> 数字 game_id：抓 Mod 页解析 data-game-id，无 Cookie 时也可用匿名访问。
async fn nexus_game_id(
    game_domain: &str,
    cookie: &str,
    proxy: Option<&str>,
) -> Result<String, String> {
    use simple_downloader::reqwest::header::{HeaderValue, COOKIE};
    let mut builder = simple_downloader::reqwest::ClientBuilder::new()
        .user_agent(PROBE_UA)
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(20));
    if let Some(px) = proxy.map(str::trim).filter(|s| !s.is_empty()) {
        if let Ok(p) = simple_downloader::reqwest::Proxy::all(px) {
            builder = builder.proxy(p);
        }
    }
    let client = builder.build().map_err(|_| "无法创建下载请求。".to_string())?;
    let url = format!("https://www.nexusmods.com/{}/mods/1", game_domain);
    let mut req = client.get(&url);
    if let Ok(v) = HeaderValue::from_str(cookie) {
        req = req.header(COOKIE, v);
    }
    let text = req
        .send()
        .await
        .map_err(|e| format!("获取游戏信息失败：{e}"))?
        .text()
        .await
        .map_err(|e| format!("读取游戏页面失败：{e}"))?;
    // data-game-id="3333" / game_id: 3333 / "game_id":3333 多形态兜底。
    for marker in ["data-game-id=\"", "data-game-id='", "\"game_id\":", "game_id:"] {
        if let Some(pos) = text.find(marker) {
            let rest = text[pos + marker.len()..].trim_start_matches(['"', '\'', ' ', ':']);
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if !digits.is_empty() {
                return Ok(digits);
            }
        }
    }
    Err("未能解析游戏 ID，请检查网络或 Cookie。".to_string())
}
