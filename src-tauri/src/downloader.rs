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

// 自动重试退避（上限 3 次）；参数收敛进 options 预留，不接任何 UI/配置。
const RETRY_BACKOFF_MS: [u64; 3] = [1000, 2000, 4000];
const MAX_AUTO_RETRY: u32 = 3;

// 当前毫秒时间戳（可序列化计时，不用 Instant）。
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// 退避毫秒数：retry_count 从 1 起按 1s/2s/4s 取档，超档按末档。
fn backoff_ms(retry_count: u32) -> u64 {
    let idx = retry_count.saturating_sub(1).min(2) as usize;
    RETRY_BACKOFF_MS[idx]
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
enum TaskStatus {
    Active,
    Waiting,
    Paused,
    Error,
    Retrying,
    Complete,
}

impl TaskStatus {
    fn as_status_str(self) -> &'static str {
        match self {
            TaskStatus::Active => "active",
            TaskStatus::Waiting => "waiting",
            TaskStatus::Paused => "paused",
            TaskStatus::Error => "error",
            TaskStatus::Retrying => "retrying",
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
    /// 自动/人工重试计数（后端真相源，前端只投影）。
    retry_count: u32,
    /// 下次重试时刻毫秒时间戳；0 表示无待触发计时。
    next_retry_at_ms: u64,
    total: u64,
    downloaded: u64,
    speed: f64,
    error: Option<String>,
    handle: Option<tauri::async_runtime::JoinHandle<()>>,
    /// 上次 dl-progress 发送时刻（MonitorUpdate 节流，0.5s 一跳）。
    last_emit: Option<std::time::Instant>,
    /// 所属 collection 待下载清单 id（collection 建任务时透传，普通任务为 None）。
    collection_id: Option<String>,
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
    /// 全局暂停闸：开启后 pump 不再起新任务。
    paused_all: bool,
    /// collection 暂停闸：集合内的 id 不再被 pump 起任务。
    paused_collections: std::collections::HashSet<String>,
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
    retry_count: u32,
    next_retry_at_ms: u64,
    /// 注册表当前大小（终局对齐后的真相源）：快速完成时前端可能没收到任何
    /// dl-progress 帧（0.5s 节流），终局/错误行靠这两个字段兜底补齐，避免 0/0。
    total_length: u64,
    completed_length: u64,
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

    fn emit_changed(&self, gid: &str, status: &str, retry_count: u32, next_retry_at_ms: u64) {
        if let Some(app) = self.app.lock().expect("downloader app lock").as_ref() {
            // 事件顺带携带注册表当前大小（调用方均未持 inner 锁；任务已移除时读 0），
            // 前端终局归档/错误行用它兜底补齐，修"秒完成任务 0/0"。
            let (total_length, completed_length) = self
                .inner
                .lock()
                .ok()
                .and_then(|inner| inner.tasks.get(gid).map(|e| (e.total, e.downloaded)))
                .unwrap_or((0, 0));
            let _ = app.emit(
                "dl-task-changed",
                DlTaskChanged {
                    gid: gid.to_string(),
                    status: status.to_string(),
                    retry_count,
                    next_retry_at_ms,
                    total_length,
                    completed_length,
                },
            );
        }
    }

    /// 状态快照发射（字符串状态版，供终局 complete/error 复用）。
    fn emit_snapshot_str(&self, gid: &str, status: &str) {
        let (retry_count, next_retry_at_ms) = self
            .inner
            .lock()
            .ok()
            .and_then(|inner| inner.tasks.get(gid).map(|e| (e.retry_count, e.next_retry_at_ms)))
            .unwrap_or((0, 0));
        self.emit_changed(gid, status, retry_count, next_retry_at_ms);
    }

    /// 状态快照发射：锁内读出 retry 字段后发射（调用方已持有数据时用 emit_changed 直接传值）。
    fn emit_snapshot(&self, gid: &str, status: TaskStatus) {
        let (retry_count, next_retry_at_ms) = self
            .inner
            .lock()
            .ok()
            .and_then(|inner| inner.tasks.get(gid).map(|e| (e.retry_count, e.next_retry_at_ms)))
            .unwrap_or((0, 0));
        self.emit_changed(gid, status.as_status_str(), retry_count, next_retry_at_ms);
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
    retry_count: u32,
    next_retry_at_ms: u64,
    total_length: String,
    completed_length: String,
    download_speed: String,
    dir: String,
    files: Vec<TaskFileSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_message: Option<String>,
}

fn snapshot_of(entry: &TaskEntry) -> TaskSnapshot {
    let path = entry.output_path();
    TaskSnapshot {
        gid: entry.gid.clone(),
        status: entry.status.as_status_str().to_string(),
        retry_count: entry.retry_count,
        next_retry_at_ms: entry.next_retry_at_ms,
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
                            // 单调钳：MonitorUpdate 与块级累加两条路打架时，小值不覆盖大值（进度条倒流根因）。
                            entry.downloaded = entry.downloaded.max(total_downloaded);
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

        // 终局判定（锁内只读结果，状态变更走 set_status）。
        enum Terminal {
            Complete,
            AutoRetry { retry_count: u32, next_retry_at_ms: u64 },
            ErrorFinal,
            None,
        }
        let terminal = {
            let mut inner = state.inner.lock().expect("downloader lock");
            let outcome = if let Some(entry) = inner.tasks.get_mut(&gid) {
                entry.handle = None;
                entry.speed = 0.0;
                // 中止（pause/cancel）时状态已被调用方改写，不覆盖。
                if entry.status != TaskStatus::Active {
                    Terminal::None
                } else {
                    match result {
                        Ok(()) => {
                            let _ = set_status(&mut inner, &gid, TaskStatus::Complete);
                            // 终局对齐：成功即全量（零 Tick/流式场景 downloaded 可能滞后）。
                            if let Some(done) = inner.tasks.get_mut(&gid) {
                                if done.total > 0 {
                                    done.downloaded = done.total;
                                } else {
                                    done.total = done.downloaded;
                                }
                            }
                            Terminal::Complete
                        }
                        Err(error) => {
                            let msg = error.to_string();
                            if let Some(entry) = inner.tasks.get_mut(&gid) {
                                entry.error = Some(msg);
                            }
                            // 自动重试：retry_count+1，按 1s/2s/4s 退避；3 次耗尽停留 error。
                            let next_count = inner
                                .tasks
                                .get(&gid)
                                .map(|e| e.retry_count + 1)
                                .unwrap_or(1);
                            if next_count <= MAX_AUTO_RETRY {
                                let wait = backoff_ms(next_count);
                                let at = now_ms().saturating_add(wait);
                                if let Some(entry) = inner.tasks.get_mut(&gid) {
                                    entry.retry_count = next_count;
                                    entry.next_retry_at_ms = at;
                                }
                                let _ = set_status(&mut inner, &gid, TaskStatus::Retrying);
                                Terminal::AutoRetry {
                                    retry_count: next_count,
                                    next_retry_at_ms: at,
                                }
                            } else {
                                let _ = set_status(&mut inner, &gid, TaskStatus::Error);
                                if let Some(entry) = inner.tasks.get_mut(&gid) {
                                    entry.next_retry_at_ms = 0;
                                }
                                Terminal::ErrorFinal
                            }
                        }
                    }
                }
            } else {
                Terminal::None
            };
            drop(inner);
            outcome
        };
        match terminal {
            // 完成：终局副作用（保留条目供查询/导入，标 complete）。
            Terminal::Complete => {
                state.emit_snapshot_str(&gid, "complete");
            }
            // 自动重试：发射 retrying 事件 + 后端 tick 到期回 waiting。
            Terminal::AutoRetry {
                retry_count,
                next_retry_at_ms,
            } => {
                state.emit_changed(&gid, "retrying", retry_count, next_retry_at_ms);
                schedule_retry_tick(state.clone(), gid.clone(), next_retry_at_ms);
            }
            // 耗尽：停留 error 待人工 retry。
            Terminal::ErrorFinal => {
                state.emit_snapshot_str(&gid, "error");
            }
            Terminal::None => {}
        }
        pump(state.clone());
    });

    let mut inner = worker_state.inner.lock().expect("downloader lock");
    if let Some(entry) = inner.tasks.get_mut(&worker_gid) {
        entry.handle = Some(handle);
    }
}

/// 后端 retry tick：sleep 到 next_retry_at 再回 waiting 同一 gid。
/// pause 闸优先：到期时若任务已 paused/error 外状态则不回 waiting；paused 保持占位。
fn schedule_retry_tick(state: DownloaderState, gid: String, next_retry_at_ms: u64) {
    // 独立线程 sleep（不占 async 运行时），到期后回 waiting 同一 gid。
    std::thread::spawn(move || {
        let now = now_ms();
        let wait = next_retry_at_ms.saturating_sub(now);
        if wait > 0 {
            std::thread::sleep(std::time::Duration::from_millis(wait));
        }
        let should_pump = {
            let mut inner = state.inner.lock().expect("downloader lock");
            let Some(entry) = inner.tasks.get(&gid) else {
                return;
            };
            // 仅 retrying 到期回 waiting；pause 闸冻结（保持 paused 占位，不续接退避）。
            if entry.status != TaskStatus::Retrying {
                return;
            }
            if inner.paused_all
                || entry
                    .collection_id
                    .clone()
                    .is_some_and(|id| inner.paused_collections.contains(&id))
            {
                // 闸开着：转 paused 冻结，retry 计时作废，resume 后重排。
                let _ = set_status(&mut inner, &gid, TaskStatus::Paused);
                if let Some(entry) = inner.tasks.get_mut(&gid) {
                    entry.next_retry_at_ms = 0;
                }
                false
            } else {
                if let Some(entry) = inner.tasks.get_mut(&gid) {
                    entry.next_retry_at_ms = 0;
                }
                let _ = set_status(&mut inner, &gid, TaskStatus::Waiting);
                true
            }
        };
        if should_pump {
            state.emit_snapshot(&gid, TaskStatus::Waiting);
            // 闸冻结路径不 pump（paused 占位保留）。
            pump(state.clone());
        } else {
            state.emit_snapshot(&gid, TaskStatus::Paused);
        }
    });
}

/// 泵出等待队列：临界区只做标记，spawn 在锁外，避免与 worker 回调的锁嵌套。
/// 暂停闸：paused_all 开启，或任务所属 collection 被暂停，均不启动，只留在 pending。
fn pump(state: DownloaderState) {
    let starters: Vec<String> = {
        let mut inner = state.inner.lock().expect("downloader lock");
        if inner.paused_all {
            return;
        }
        let active = inner
            .tasks
            .values()
            .filter(|entry| entry.status == TaskStatus::Active)
            .count();
        let mut slots = MAX_ACTIVE.saturating_sub(active);
        let mut starters = Vec::new();
        let mut deferred = Vec::new();
        while slots > 0 {
            let Some(next) = inner.pending.pop_front() else {
                break;
            };
            // pause 闸 > retry 计时：Paused 占位直接跳过；Retrying 未到期跳过（到期由 tick 回 waiting）。
            let now = now_ms();
            let gated = inner.tasks.get(&next).is_some_and(|entry| {
                entry.status != TaskStatus::Waiting
                    || entry.next_retry_at_ms > now && entry.retry_count > 0
                    || entry
                        .collection_id
                        .as_ref()
                        .is_some_and(|id| inner.paused_collections.contains(id))
            });
            if gated {
                deferred.push(next);
                continue;
            }
            slots -= 1;
            let _ = set_status(&mut inner, &next, TaskStatus::Active);
            starters.push(next);
        }
        // 被闸住的任务放回队列头部，下次 pump 到闸解除时再起。
        for next in deferred.into_iter().rev() {
            inner.pending.push_front(next);
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
    collection_id: Option<String>,
) -> Result<String, String> {
    if url.trim().is_empty() {
        return Err("下载地址为空".to_string());
    }
    if file_name.trim().is_empty() {
        return Err("输出文件名为空".to_string());
    }
    let gid = uuid::Uuid::new_v4().to_string();
    let header_vec: Vec<(String, String)> = headers.into_iter().collect();
    let gated = {
        let mut inner = state.inner.lock().map_err(|_| "下载注册表锁异常".to_string())?;
        let gated = inner.paused_all
            || collection_id
                .as_ref()
                .is_some_and(|id| inner.paused_collections.contains(id));
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
                // 被闸住的任务直接 Paused，不进 pending；闸解除后由 resume 显式恢复。
                status: if gated { TaskStatus::Paused } else { TaskStatus::Waiting },
                retry_count: 0,
                next_retry_at_ms: 0,
                total: 0,
                downloaded: 0,
                speed: 0.0,
                error: None,
                handle: None,
                last_emit: None,
                collection_id: collection_id.clone(),
            },
        );
        if !gated {
            inner.pending.push_back(gid.clone());
        }
        gated
    };
    if gated {
        state.emit_snapshot(&gid, TaskStatus::Paused);
        return Ok(gid);
    }
    pump((*state).clone());
    // 入队即事件：前端纯事件驱动需要此触发器，否则新任务要等下一次刷新才出现。
    state.emit_snapshot(&gid, TaskStatus::Waiting);
    Ok(gid)
}

/// 全局暂停闸：开启后 pump 不起新任务；已 active 的逐个中止。
#[tauri::command]
pub fn dl_pause_all(state: tauri::State<DownloaderState>) -> Result<usize, String> {
    let gids: Vec<String> = {
        let mut inner = state.inner.lock().map_err(|_| "下载注册表锁异常".to_string())?;
        inner.paused_all = true;
        let ids: Vec<String> = inner
            .tasks
            .iter()
            .filter(|(_, entry)| {
                matches!(
                    entry.status,
                    TaskStatus::Active
                        | TaskStatus::Waiting
                        | TaskStatus::Error
                        | TaskStatus::Retrying
                )
            })
            .map(|(gid, _)| gid.clone())
            .collect();
        let mut gids = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(entry) = inner.tasks.get_mut(&id) {
                if entry.status == TaskStatus::Active {
                    abort_entry(entry);
                }
            }
            // retry 计时作废：pause 闸 > retry 计时。
            if let Some(entry) = inner.tasks.get_mut(&id) {
                entry.next_retry_at_ms = 0;
            }
            if set_status(&mut inner, &id, TaskStatus::Paused).is_ok() {
                gids.push(id);
            }
        }
        gids
    };
    // paused 保持后端 pending 槽位（不摘除），pump 侧跳过。
    let count = gids.len();
    for gid in &gids {
        state.emit_snapshot(gid, TaskStatus::Paused);
    }
    Ok(count)
}

/// 全局暂停闸解除：paused 的任务全部回 waiting，不受 collection 闸限制。

/// 下载页“继续全部”是最高优先级恢复入口，一并清空 paused_collections。
#[tauri::command]
pub fn dl_resume_all(state: tauri::State<DownloaderState>) -> Result<usize, String> {
    let gids: Vec<String> = {
        let mut inner = state.inner.lock().map_err(|_| "下载注册表锁异常".to_string())?;
        inner.paused_all = false;
        inner.paused_collections.clear();
        let ids: Vec<String> = inner
            .tasks
            .iter()
            .filter(|(_, entry)| entry.status == TaskStatus::Paused)
            .map(|(gid, _)| gid.clone())
            .collect();
        let mut gids = Vec::with_capacity(ids.len());
        for id in ids {
            // resume 回 waiting 重排，不续接剩余退避；人工语义由 dl_retry 重置计数。
            if let Some(entry) = inner.tasks.get_mut(&id) {
                entry.next_retry_at_ms = 0;
            }
            if set_status(&mut inner, &id, TaskStatus::Waiting).is_ok() {
                gids.push(id);
            }
        }
        gids
    };
    let count = gids.len();
    for gid in &gids {
        state.emit_snapshot(gid, TaskStatus::Waiting);
    }
    pump((*state).clone());
    Ok(count)
}

/// collection 暂停闸：该清单已建任务全部暂停，后续入队直接 Paused。
#[tauri::command]
pub fn dl_pause_collection(
    state: tauri::State<DownloaderState>,
    collection_id: String,
) -> Result<usize, String> {
    let gids: Vec<String> = {
        let mut inner = state.inner.lock().map_err(|_| "下载注册表锁异常".to_string())?;
        inner.paused_collections.insert(collection_id.clone());
        let ids: Vec<String> = inner
            .tasks
            .iter()
            .filter(|(_, entry)| {
                entry.collection_id.as_deref() == Some(collection_id.as_str())
                    && matches!(
                        entry.status,
                        TaskStatus::Active
                            | TaskStatus::Waiting
                            | TaskStatus::Error
                            | TaskStatus::Retrying
                    )
            })
            .map(|(gid, _)| gid.clone())
            .collect();
        let mut gids = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(entry) = inner.tasks.get_mut(&id) {
                if entry.status == TaskStatus::Active {
                    abort_entry(entry);
                }
                entry.next_retry_at_ms = 0;
            }
            if set_status(&mut inner, &id, TaskStatus::Paused).is_ok() {
                gids.push(id);
            }
        }
        gids
    };
    // paused 保持后端 pending 槽位（不摘除），pump 侧跳过。
    let count = gids.len();
    for gid in &gids {
        state.emit_snapshot(gid, TaskStatus::Paused);
    }
    pump((*state).clone());
    Ok(count)
}

/// collection 暂停闸解除：该清单 paused 任务回 waiting。
#[tauri::command]
pub fn dl_resume_collection(
    state: tauri::State<DownloaderState>,
    collection_id: String,
) -> Result<usize, String> {
    let gids: Vec<String> = {
        let mut inner = state.inner.lock().map_err(|_| "下载注册表锁异常".to_string())?;
        inner.paused_collections.remove(&collection_id);
        if inner.paused_all {
            return Ok(0);
        }
        let target = collection_id.clone();
        let ids: Vec<String> = inner
            .tasks
            .iter()
            .filter(|(_, entry)| {
                entry.collection_id.as_deref() == Some(target.as_str())
                    && entry.status == TaskStatus::Paused
            })
            .map(|(gid, _)| gid.clone())
            .collect();
        let mut gids = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(entry) = inner.tasks.get_mut(&id) {
                entry.next_retry_at_ms = 0;
            }
            if set_status(&mut inner, &id, TaskStatus::Waiting).is_ok() {
                gids.push(id);
            }
        }
        gids
    };
    let count = gids.len();
    for gid in &gids {
        state.emit_snapshot(gid, TaskStatus::Waiting);
    }
    pump((*state).clone());
    Ok(count)
}

/// 唯一状态入口：任何状态变更必须经此函数（transition 合法性断言见变迁表 §2）。
/// 非法变迁返回 Err 且不改状态；合法变迁改状态并处理 pending 占位副作用。
/// pause 闸语义：paused 保持后端 pending 槽位（不摘除），pump 侧跳过。
fn set_status(inner: &mut Inner, gid: &str, to: TaskStatus) -> Result<TaskStatus, String> {
    let entry = inner
        .tasks
        .get_mut(gid)
        .ok_or_else(|| format!("任务不存在：{gid}"))?;
    let from = entry.status;
    // 合法变迁表（与计划 §2 一一对应；complete 经终局副作用出机，不经此表）。
    let allowed = matches!(
        (from, to),
        (TaskStatus::Waiting, TaskStatus::Active)
            | (TaskStatus::Waiting, TaskStatus::Paused)
            | (TaskStatus::Active, TaskStatus::Paused)
            | (TaskStatus::Active, TaskStatus::Error)
            | (TaskStatus::Active, TaskStatus::Waiting)
            | (TaskStatus::Active, TaskStatus::Complete)
            | (TaskStatus::Error, TaskStatus::Paused)
            | (TaskStatus::Error, TaskStatus::Retrying)
            | (TaskStatus::Retrying, TaskStatus::Paused)
            | (TaskStatus::Retrying, TaskStatus::Waiting)
            | (TaskStatus::Retrying, TaskStatus::Error)
            | (TaskStatus::Paused, TaskStatus::Waiting)
            | (TaskStatus::Error, TaskStatus::Waiting)
    ) || from == to;
    if !allowed {
        return Err(format!(
            "非法状态变迁：{} → {}",
            from.as_status_str(),
            to.as_status_str()
        ));
    }
    let _ = std::mem::replace(&mut entry.status, to);
    match to {
        // Active：清 error，pending 由 pump 侧消费（此处不重复入队，由调用方决定）。
        TaskStatus::Active => {
            entry.error = None;
        }
        // Waiting：回等待清 error；paused 保持占位不摘除（pause 闸 > retry 计时）。
        TaskStatus::Waiting => {
            entry.error = None;
            if !inner.pending.contains(&gid.to_string()) {
                inner.pending.push_back(gid.to_string());
            }
        }
        // Retrying：pending 摘除，等待 tick 到期再回 waiting。
        TaskStatus::Retrying => {
            inner.pending.retain(|pending| pending != gid);
        }
        // Complete：终局副作用占位（正常路径走 spawn 终局，此分支仅断言用）。
        TaskStatus::Complete => {
            inner.pending.retain(|pending| pending != gid);
        }
        // Paused：保持后端 pending 槽位（不摘除），pump 跳过；Error：保留现场不动。
        TaskStatus::Paused | TaskStatus::Error => {}
    }
    Ok(from)
}

fn abort_entry(entry: &mut TaskEntry) {
    if let Some(handle) = entry.handle.take() {
        handle.abort();
    }
    entry.speed = 0.0;
}

#[tauri::command]
pub fn dl_pause(state: tauri::State<DownloaderState>, gid: String) -> Result<(), String> {
    // Active 先中止传输（保留 sidecar 断点），再经唯一入口冻结。
    {
        let mut inner = state.inner.lock().map_err(|_| "下载注册表锁异常".to_string())?;
        let Some(entry) = inner.tasks.get_mut(&gid) else {
            return Err(format!("任务不存在：{gid}"));
        };
        if entry.status == TaskStatus::Active {
            abort_entry(entry);
        }
        // retry 计时作废；paused 保持 pending 槽位（set_status 内不摘除）。
        entry.next_retry_at_ms = 0;
    }
    {
        let mut inner = state.inner.lock().map_err(|_| "下载注册表锁异常".to_string())?;
        set_status(&mut inner, &gid, TaskStatus::Paused)?;
    }
    // 腾出槽位后泵出等待队列。
    state.emit_snapshot(&gid, TaskStatus::Paused);
    pump((*state).clone());
    Ok(())
}

/// 人工重试入口：error → retrying（同一 gid，保留 sidecar 断点），后端 tick 退避后回 waiting。
/// 人工 retry 重置自动计数，按首次退避 1s 触发；同一 gid 全程不变。
#[tauri::command]
pub fn dl_retry(state: tauri::State<DownloaderState>, gid: String) -> Result<(), String> {
    let (retry_count, next_retry_at_ms) = {
        let mut inner = state.inner.lock().map_err(|_| "下载注册表锁异常".to_string())?;
        {
            let Some(entry) = inner.tasks.get(&gid) else {
                return Err(format!("任务不存在：{gid}"));
            };
            if entry.status != TaskStatus::Error {
                return Err(format!(
                    "仅 error 任务可重试，当前：{}",
                    entry.status.as_status_str()
                ));
            }
        }
        // 人工重试重置计数，按首次退避触发。
        if let Some(entry) = inner.tasks.get_mut(&gid) {
            entry.retry_count = 1;
            entry.next_retry_at_ms = now_ms().saturating_add(backoff_ms(1));
        }
        set_status(&mut inner, &gid, TaskStatus::Retrying)?;
        let entry = inner.tasks.get(&gid).expect("retry entry");
        (entry.retry_count, entry.next_retry_at_ms)
    };
    state.emit_changed(&gid, "retrying", retry_count, next_retry_at_ms);
    schedule_retry_tick((*state).clone(), gid, next_retry_at_ms);
    Ok(())
}

#[tauri::command]
pub fn dl_resume(state: tauri::State<DownloaderState>, gid: String) -> Result<(), String> {
    // 先快照闸状态，再拿 entry 可变借用，避免双重借用 inner。
    let (paused_all, paused_collections): (bool, std::collections::HashSet<String>) = {
        let inner = state.inner.lock().map_err(|_| "下载注册表锁异常".to_string())?;
        (inner.paused_all, inner.paused_collections.iter().cloned().collect())
    };
    {
        let mut inner = state.inner.lock().map_err(|_| "下载注册表锁异常".to_string())?;
        let Some(entry) = inner.tasks.get_mut(&gid) else {
            return Err(format!("任务不存在：{gid}"));
        };
        if entry.status == TaskStatus::Active
            || entry.status == TaskStatus::Complete
            || entry.status == TaskStatus::Retrying
        {
            return Ok(());
        }
        // 闸开着时 resume 直接拒绝，避免前端自动恢复把暂停顶掉。
        if paused_all
            || entry.collection_id.as_ref().is_some_and(|id| paused_collections.contains(id))
        {
            return Err("已暂停全部/该 Collection，无法继续任务。".to_string());
        }
        // resume 回 waiting 重排，不续接剩余退避。
        if let Some(entry) = inner.tasks.get_mut(&gid) {
            entry.next_retry_at_ms = 0;
        }
        set_status(&mut inner, &gid, TaskStatus::Waiting)?;
    }
    state.emit_snapshot(&gid, TaskStatus::Waiting);
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
    state.emit_changed(&gid, "removed", 0, 0);
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
/// 批量清理已终局任务：一次锁内定名单，锁外删文件、发事件。返回 (已清理数, 失败明细)。
/// active/waiting 跳过并记入失败；不存在的 gid 直接忽略。
#[tauri::command]
pub fn dl_purge_stopped(
    state: tauri::State<DownloaderState>,
    gids: Vec<String>,
    delete_file: bool,
) -> Result<(usize, Vec<(String, String)>), String> {
    let (targets, failed): (Vec<(String, String)>, Vec<(String, String)>) = {
        let mut inner = state.inner.lock().map_err(|_| "下载注册表锁异常".to_string())?;
        let mut targets = Vec::with_capacity(gids.len());
        let mut failed = Vec::new();
        for gid in gids {
            let Some(mut entry) = inner.tasks.remove(&gid) else {
                continue;
            };
            if matches!(
                entry.status,
                TaskStatus::Active | TaskStatus::Waiting | TaskStatus::Retrying
            ) {
                let status = entry.status.as_status_str().to_string();
                inner.tasks.insert(gid.clone(), entry);
                failed.push((gid, format!("任务{status}，跳过")));
                continue;
            }
            abort_entry(&mut entry);
            targets.push((gid, entry.output_path()));
        }
        inner.pending.retain(|pending| !targets.iter().any(|(gid, _)| gid == pending));
        (targets, failed)
    };
    let mut failed = failed;
    for (gid, output) in &targets {
        if delete_file {
            // 文件/目录都尝试删（单文件任务也可能落成目录）；失败记入明细，不静默吞错。
            let file_err = std::fs::remove_file(output).err();
            let dir_err = if file_err.is_some() { std::fs::remove_dir_all(output).err() } else { None };
            if let Some(err) = dir_err.or(file_err) {
                // 文件本就不存在不算失败（用户手动删过）。
                if err.kind() != std::io::ErrorKind::NotFound {
                    failed.push((gid.clone(), format!("文件删除失败：{err}")));
                }
            }
            let _ = std::fs::remove_file(format!("{output}.download.bitcode"));
        }
        state.emit_changed(gid, "removed", 0, 0);
    }
    pump((*state).clone());
    Ok((targets.len(), failed))
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

/// 全量任务快照：前端投影机引导同步用（应用重启/页面重载后拉取后端真相源）。
/// 含机内 5 态任务与终局归档（complete 保留在后端注册表中，语义与 aria2 stopped 一致）。
#[tauri::command]
pub fn dl_list(state: tauri::State<DownloaderState>) -> Result<Vec<TaskSnapshot>, String> {
    let inner = state.inner.lock().map_err(|_| "下载注册表锁异常".to_string())?;
    Ok(inner.tasks.values().map(snapshot_of).collect())
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

// 首字节魔数 → 后缀：只认压缩包魔数，不猜测、不编造。
fn ext_for_magic(head: &[u8]) -> Option<&'static str> {
    if head.len() >= 4 && head[0] == b'P' && head[1] == b'K' && head[2] == 0x03 && head[3] == 0x04 {
        return Some("zip");
    }
    if head.len() >= 6 && head[0] == b'7' && head[1] == b'z' && head[2] == 0xBC && head[3] == 0xAF && head[4] == 0x27 && head[5] == 0x1C {
        return Some("7z");
    }
    if head.len() >= 4 && head[0] == b'R' && head[1] == b'a' && head[2] == b'r' && head[3] == b'!' {
        return Some("rar");
    }
    None
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

// 无后缀名按魔数补后缀：HEAD 无 body 无法嗅探时返回 None，由调用方发 Range 0-0 再定。
fn ensure_extension_by_magic(name: &str, head: &[u8]) -> Option<String> {
    if let Some(dot) = name.rfind('.') {
        if dot + 1 < name.len() && name.len() - dot - 1 <= 10 {
            return None;
        }
    }
    ext_for_magic(head).map(|ext| format!("{name}.{ext}"))
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
            let final_url = resp.url().as_str().to_string();
            let (name, ctype) = suggest_from_headers(resp.headers(), &final_url);
            if let Some(n) = name {
                let is_header = resp.headers().contains_key(simple_downloader::reqwest::header::CONTENT_DISPOSITION);
                return Ok(ProbeFilename {
                    name: n,
                    source: if is_header { "header".to_string() } else { "url".to_string() },
                    content_type: ctype,
                    total_bytes: total_from_headers(resp.headers()),
                });
            }
        } else {
            status = Some(resp.status().as_u16());
        }
    }
    // Range 0-0：首字节 body 既定总量又定魔数后缀；无后缀名按魔数补，不编造。
    if let Ok(resp) = client.get(url).header(RANGE, "bytes=0-0").send().await {
        let code = resp.status().as_u16();
        if resp.status().is_success() || code == 206 {
            let total = total_from_headers(resp.headers());
            let headers = resp.headers().clone();
            let final_url = resp.url().as_str().to_string();
            let head: Vec<u8> = resp.bytes().await.unwrap_or_default().into_iter().collect();
            let (name, ctype) = suggest_from_headers(&headers, &final_url);
            if let Some(n) = name {
                let is_header = headers.contains_key(simple_downloader::reqwest::header::CONTENT_DISPOSITION);
                let fixed = ensure_extension_by_magic(&n, &head).unwrap_or(n);
                return Ok(ProbeFilename {
                    name: fixed,
                    source: if is_header { "header".to_string() } else { "url".to_string() },
                    content_type: ctype,
                    total_bytes: total,
                });
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
    api_key: Option<String>,
) -> Result<String, String> {
    use simple_downloader::reqwest::header::{HeaderValue, COOKIE, ORIGIN, REFERER, USER_AGENT};
    let game_domain = game_domain.trim().to_string();
    let mod_id = mod_id.trim().to_string();
    let file_id = file_id.trim().to_string();
    let cookie = cookie.trim().to_string();
    tracing::debug!(target: "nexus", "resolve-start game={} mod={} file={} proxy={}", game_domain, mod_id, file_id, proxy.as_deref().unwrap_or("none"));
    if game_domain.is_empty() || mod_id.is_empty() || file_id.is_empty() {
        return Err("缺少游戏/Mod/文件参数。".to_string());
    }
    if cookie.is_empty() {
        return Err("未配置 NexusMods Cookie，请在设置页填写。".to_string());
    }
    let api_key = api_key.as_deref().unwrap_or("").trim().to_string();
    let game_id = nexus_game_id(&game_domain, &cookie, proxy.as_deref(), &api_key).await?;
    tracing::debug!(target: "nexus", "resolve-game-id game={} mod={} file={}", game_domain, mod_id, file_id);
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
    tracing::debug!(target: "nexus", "resolve-post status={} mod={} file={}", resp.status().as_u16(), mod_id, file_id);
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
    tracing::debug!(target: "nexus", "resolve-no-url len={} head={} mod={} file={}", text.len(), &text[..text.len().min(120)], mod_id, file_id);
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
/// game_domain -> 数字 game_id：优先走官方 REST API（api.nexusmods.com，不吃 Cloudflare 验证），
/// 无 key/失败时回退抓 www 页解析 data-game-id。Cookie 直链主体逻辑不动。
async fn nexus_game_id(
    game_domain: &str,
    cookie: &str,
    proxy: Option<&str>,
    api_key: &str,
) -> Result<String, String> {
    if let Some(id) = nexus_game_id_via_api(game_domain, api_key, proxy).await {
        return Ok(id);
    }
    nexus_game_id_via_page(game_domain, cookie, proxy).await
}

/// API 路径：GET /v1/games/{domain}.json 取数字 id；可选 apikey 鉴权（匿名也可查公开游戏）。
async fn nexus_game_id_via_api(
    game_domain: &str,
    api_key: &str,
    proxy: Option<&str>,
) -> Option<String> {
    use simple_downloader::reqwest::header::HeaderValue;
    let domain = game_domain.trim();
    if domain.is_empty() {
        return None;
    }
    let mut builder = simple_downloader::reqwest::ClientBuilder::new()
        .user_agent(PROBE_UA)
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(20));
    if let Some(px) = proxy.map(str::trim).filter(|s| !s.is_empty()) {
        if let Ok(p) = simple_downloader::reqwest::Proxy::all(px) {
            builder = builder.proxy(p);
        }
    }
    let client = builder.build().ok()?;
    let mut req = client.get(format!("https://api.nexusmods.com/v1/games/{}.json", domain));
    let key = api_key.trim();
    if !key.is_empty() {
        if let Ok(v) = HeaderValue::from_str(key) {
            req = req.header("apikey", v);
        }
    }
    let resp = req.send().await.ok()?;
    if !resp.status().is_success() {
        ::tracing::debug!(domain, status = resp.status().as_u16(), "nexus game id api miss, fallback to page");
        return None;
    }
    let value: serde_json::Value = resp.json().await.ok()?;
    value.get("id").and_then(|id| id.as_u64()).map(|id| id.to_string())
}

/// 回退路径：抓 www Mod 页解析 data-game-id（可能撞 Cloudflare 验证，失败即报错）。
async fn nexus_game_id_via_page(
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
    let resp = req
        .send()
        .await
        .map_err(|e| format!("获取游戏信息失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("游戏页面返回异常（{}），请稍后重试。", resp.status().as_u16()));
    }
    let text = resp
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

#[cfg(test)]
mod tests {
    use super::*;

    // 构造带 AppHandle=None 的内存态（不发射事件，只测变迁）。
    fn mem_state() -> DownloaderState {
        DownloaderState::default()
    }

    fn insert_task(inner: &mut Inner, gid: &str, status: TaskStatus) {
        inner.tasks.insert(
            gid.to_string(),
            TaskEntry {
                gid: gid.to_string(),
                url: "http://example.invalid/f.zip".to_string(),
                dir: "C:/tmp".to_string(),
                file_name: "f.zip".to_string(),
                headers: Vec::new(),
                workers: 1,
                proxy: None,
                status,
                retry_count: 0,
                next_retry_at_ms: 0,
                total: 0,
                downloaded: 0,
                speed: 0.0,
                error: None,
                handle: None,
                last_emit: None,
                collection_id: None,
            },
        );
    }

    #[test]
    fn retry_same_gid() {
        // error → retrying 同一 gid，retry_count 递增，next_retry_at 按退避 1s 落点。
        let state = mem_state();
        let mut inner = state.inner.lock().unwrap();
        insert_task(&mut inner, "g1", TaskStatus::Error);
        // 模拟 dl_retry 核心段：计数重置为 1 + 变迁。
        let entry = inner.tasks.get_mut("g1").unwrap();
        entry.retry_count = 1;
        entry.next_retry_at_ms = now_ms() + backoff_ms(1);
        set_status(&mut inner, "g1", TaskStatus::Retrying).unwrap();
        let entry = inner.tasks.get("g1").unwrap();
        assert_eq!(entry.gid, "g1");
        assert_eq!(entry.status, TaskStatus::Retrying);
        assert_eq!(entry.retry_count, 1);
        assert!(entry.next_retry_at_ms > 0);
        // tick 到期回 waiting，同一 gid 不变。
        let entry = inner.tasks.get_mut("g1").unwrap();
        entry.next_retry_at_ms = 0;
        set_status(&mut inner, "g1", TaskStatus::Waiting).unwrap();
        let entry = inner.tasks.get("g1").unwrap();
        assert_eq!(entry.gid, "g1");
        assert_eq!(entry.status, TaskStatus::Waiting);
        // 退避档位断言：1s/2s/4s。
        assert_eq!(backoff_ms(1), 1000);
        assert_eq!(backoff_ms(2), 2000);
        assert_eq!(backoff_ms(3), 4000);
    }

    #[test]
    fn transition_legality() {
        let state = mem_state();
        let mut inner = state.inner.lock().unwrap();
        // 合法：waiting→active→error→retrying→waiting→paused→waiting。
        insert_task(&mut inner, "g2", TaskStatus::Waiting);
        set_status(&mut inner, "g2", TaskStatus::Active).unwrap();
        set_status(&mut inner, "g2", TaskStatus::Error).unwrap();
        set_status(&mut inner, "g2", TaskStatus::Retrying).unwrap();
        set_status(&mut inner, "g2", TaskStatus::Waiting).unwrap();
        set_status(&mut inner, "g2", TaskStatus::Paused).unwrap();
        set_status(&mut inner, "g2", TaskStatus::Waiting).unwrap();
        // 非法：waiting→error、waiting→retrying、paused→error、active→retrying。
        insert_task(&mut inner, "g3", TaskStatus::Waiting);
        assert!(set_status(&mut inner, "g3", TaskStatus::Error).is_err());
        assert!(set_status(&mut inner, "g3", TaskStatus::Retrying).is_err());
        insert_task(&mut inner, "g4", TaskStatus::Paused);
        assert!(set_status(&mut inner, "g4", TaskStatus::Error).is_err());
        assert!(set_status(&mut inner, "g4", TaskStatus::Retrying).is_err());
        insert_task(&mut inner, "g5", TaskStatus::Active);
        assert!(set_status(&mut inner, "g5", TaskStatus::Retrying).is_err());
        // 非法变迁不改状态。
        assert_eq!(inner.tasks.get("g3").unwrap().status, TaskStatus::Waiting);
    }
}
