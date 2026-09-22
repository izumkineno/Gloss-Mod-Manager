// 对外唯一门面：组件禁止直调 invoke，一律经 facade。
// 计时/计数归后端，前端是投影机；transition 唯一入口在 machine/states。
import { invoke } from "@tauri-apps/api/core";
import { createGates, type GateState } from "./machine/guards";
import { createMachine, enterMachine, restoreTask, settleTerminal, transition, type MachineStore } from "./machine/states";
import { pump } from "./queue/pump";
import { createMetaStore, purgeMeta, putMeta, type MetaStore } from "./meta/meta-store";
import { subscribeBackendEvents } from "./events";
import { getDownloadStore, setDownloadStore } from "@/lib/download-store";
import type { BackoffOptions, TaskMeta, TaskProjection } from "./types";

/** 投影快照后端存储键（跨重启恢复，语义对齐旧 download-task-cache 的 DOWNLOAD_TASK_SNAPSHOT_KEY）。 */
const PROJECTION_SNAPSHOT_KEY = "dlProjectionSnapshot";
/** 重启恢复降级文案（旧 GMM_RESTORED_TASK 语义：后端注册表不跨进程，重启后按本地快照降级为 error 记录）。 */
const RESTORED_ERROR_MESSAGE = "任务未能从后端引擎恢复（应用重启），可点击重试重新加入下载队列。";

/** 后端 dl_list/dl_tell_status 快照（serde camelCase；长度字段为 aria2 风格字符串）。 */
interface BackendTaskSnapshot {
    gid: string;
    status: string;
    retryCount?: number;
    nextRetryAtMs?: number;
    totalLength?: string;
    completedLength?: string;
    downloadSpeed?: string;
    dir?: string;
    errorMessage?: string | null;
    /** 真实落盘路径（打开文件动作的真相源）。 */
    files?: Array<{ path?: string; length?: string; completedLength?: string }>;
}

export interface EnqueueArgs {
    url: string;
    dir: string;
    fileName: string;
    collectionId?: string;
    headers?: Array<[string, string]>;
}

export interface DownloadFacade {
    store: MachineStore;
    metas: MetaStore;
    gates: GateState;
    enqueue(args: EnqueueArgs, options?: BackoffOptions): Promise<string>;
    cancel(gid: string, deleteFile?: boolean): Promise<void>;
    forget(gid: string): Promise<void>;
    purge(gids: string[], deleteFile?: boolean): Promise<Array<[string, string]>>;
    pause(gid: string): Promise<void>;
    pauseAll(): Promise<number>;
    pauseCollection(collectionId: string): Promise<number>;
    resume(gid: string): Promise<void>;
    resumeAll(): Promise<number>;
    resumeCollection(collectionId: string): Promise<void>;
    retry(gid: string): Promise<void>;
    /** 只读后端快照（打开文件等动作的真实路径解析用）。 */
    tellStatus(gid: string): Promise<BackendTaskSnapshot>;
    subscribe(cb: (tasks: TaskProjection[]) => void): () => void;
    snapshot(): TaskProjection[];
}
// 进程内单例：队列去重读同一快照，避免各自 tell 快照双源。
let sharedFacade: DownloadFacade | null = null;
export function getDownloadFacade(): DownloadFacade {
    if (!sharedFacade) {
        sharedFacade = createFacade();
    }
    return sharedFacade;
}

function snapshot(store: MachineStore): TaskProjection[] {
    // 机内 5 态任务 + 终局归档（complete 保留最后一帧供展示/重新下载）。
    return [...store.tasks.values(), ...store.archive.values()];
}

export function createFacade(): DownloadFacade {
    const store = createMachine();
    const metas = createMetaStore();
    const gates = createGates();
    const listeners = new Set<(tasks: TaskProjection[]) => void>();

    function emit(): void {
        const snap = snapshot(store);
        scheduleProjectionPersist(snap);
        for (const cb of listeners) {
            cb(snap);
        }
    }

    // 投影持久化（防抖 1.5s 尾沿合并）：emit 是唯一投影变更汇聚点，任何变更路径都经它。
    // 进度 tick 高频到达，防抖后只落最近一帧，避免 store 插件磁盘churn。
    let persistTimer: ReturnType<typeof setTimeout> | null = null;
    let lastPersistedAt = 0;
    function scheduleProjectionPersist(snap: TaskProjection[]): void {
        const now = Date.now();
        // 距上次落盘 ≥1.5s 直接写；否则挂尾沿定时器合并。
        if (now - lastPersistedAt >= 1500) {
            lastPersistedAt = now;
            if (persistTimer) {
                clearTimeout(persistTimer);
                persistTimer = null;
            }
            void setDownloadStore(PROJECTION_SNAPSHOT_KEY, snap).catch(() => undefined);
            return;
        }
        if (persistTimer) {
            return;
        }
        persistTimer = setTimeout(() => {
            persistTimer = null;
            lastPersistedAt = Date.now();
            void setDownloadStore(PROJECTION_SNAPSHOT_KEY, snapshot(store)).catch(() => undefined);
        }, 1500);
    }

    // 引导同步：两源恢复——① 持久化投影快照（应用重启场景，后端注册表不跨进程）；
    // ② dl_list 后端真相源（页面重载场景，后端进程还活着）。
    // ① 语义对齐旧 download-task-cache：非 complete 的机内任务按"未能恢复"降级为 error 记录，
    //   用户点重试走 forget+新 gid 入机（老 删建重试 语义的合规替代）；complete 保留可导入/重下。
    // ② 覆盖同 gid：后端活着时以真相源为准。
    async function bootstrap(): Promise<void> {
        const persisted = await getDownloadStore<TaskProjection[]>(PROJECTION_SNAPSHOT_KEY, []);
        if (Array.isArray(persisted)) {
            for (const item of persisted) {
                if (!item || typeof item.gid !== "string") {
                    continue;
                }
                if (item.status === "complete") {
                    { const hasFiles = Boolean((item as unknown as { files?: unknown[] })?.files?.length); console.debug(`[uuid-trace] bootstrap restore gid=${item.gid} status=${item.status} hasFiles=${hasFiles}`); restoreTask(store, item); }
                } else if (item.status !== "removed") {
                    restoreTask(store, {
                        ...item,
                        status: "error",
                        error: item.error ?? RESTORED_ERROR_MESSAGE,
                    });
                }
            }
        }
        const list = await invoke<Array<BackendTaskSnapshot>>("dl_list");
        for (const item of list) {
            // 后端仅回 5 态 + complete；removed 不会出现在注册表中（防御性跳过）。
            if (item.status === "removed") {
                continue;
            }
            restoreTask(store, {
                gid: item.gid,
                status: item.status as TaskProjection["status"],
                retryCount: item.retryCount ?? 0,
                nextRetryAtMs: item.nextRetryAtMs ?? 0,
                dir: item.dir,
                total: Number(item.totalLength) || 0,
                downloaded: Number(item.completedLength) || 0,
                speed: Number(item.downloadSpeed) || 0,
                error: item.errorMessage ?? undefined,
            });
        }
        emit();
    }
    void bootstrap();

    // 入机登记 meta：paused 闸命中则直入 paused 机内冻结占位（backoff 归后端写死，options 预留不接）。
    async function enqueue(args: EnqueueArgs, _options?: BackoffOptions): Promise<string> {
        // 后端 dl_enqueue 真签：url/dir/file_name/headers/workers/proxy/collection_id；
        // Tauri 命令参数默认 camelCase（rust file_name ← JS fileName）。
        const gid = await invoke<string>("dl_enqueue", {
            url: args.url,
            dir: args.dir,
            fileName: args.fileName,
            headers: Object.fromEntries(args.headers ?? []),
            workers: 4,
            proxy: null,
            collectionId: args.collectionId ?? null,
        });
        const meta: TaskMeta = {
            gid,
            fileName: args.fileName,
            downloadUrl: args.url,
            source: "facade",
            collectionId: args.collectionId,
        };
        putMeta(metas, meta);
        // [uuid-trace] 同文件幂等入队：后端 dl_enqueue 同 dir+file_name 去重会返回已有 gid（跨入口并发/重试
        // 再次入队）。状态机已有该 gid（机内或终局归档）即完全交给状态机，不再重复入机/迁移，
        // 也不因 enterMachine 断言抛"任务已在机内"中断调用方的 meta 落盘；meta 单条登记照常。
        const inMachine = store.tasks.has(gid);
        const inArchive = store.archive.has(gid);
        if (inMachine || inArchive) {
            console.info(`[uuid-trace] facade enqueue dedupe gid=${gid} fileName=${args.fileName} inMachine=${inMachine} inArchive=${inArchive} — skip enterMachine, keep meta`);
        }
        if (!inMachine && !inArchive) {
            enterMachine(store, {
                gid,
                status: "waiting",
                retryCount: 0,
                nextRetryAtMs: 0,
                collectionId: args.collectionId,
                dir: args.dir,
            });
            console.info(`[uuid-trace] facade enqueue new gid=${gid} fileName=${args.fileName} collection=${String(args.collectionId ?? "-")}`);
            // 闸命中直入 paused：经 transition 唯一入口，不直写 status。
            if (gates.pausedAll || (args.collectionId !== undefined && gates.pausedCollections.has(args.collectionId))) {
                transition(store, gid, "paused");
            } else {
                pump(store, gates);
            }
        }
        emit();
        return gid;
    }

    // cancel/forget：终局副作用，出机 + meta 清理；deleteFile 默认 false。
    // 后端"任务不存在"容忍：ghost 记录（应用重启后端注册表已清）删除时保证本地行一并消失。
    async function cancel(gid: string, deleteFile = false): Promise<void> {
        await invoke("dl_cancel", { gid, deleteFile }).catch((error: unknown) => {
            if (!/任务不存在/u.test(String(error))) {
                throw error;
            }
        });
        settleTerminal(store, gid, "removed");
        purgeMeta(metas, gid);
        emit();
    }

    async function forget(gid: string): Promise<void> {
        await invoke("dl_forget", { gid }).catch((error: unknown) => {
            if (!/任务不存在/u.test(String(error))) {
                throw error;
            }
        });
        settleTerminal(store, gid, "removed");
        purgeMeta(metas, gid);
        emit();
    }

    // purge：批量清已终局任务（后端 dl_purge_stopped + 前端终局归档），不碰机内态。
    // 返回后端失败明细（跳过/文件删失败），调用方展示。
    async function purge(gids: string[], deleteFile = false): Promise<Array<[string, string]>> {
        console.info(`[purge] facade invoke total=${gids.length} deleteFile=${deleteFile}`);
        const [count, failed] =
            await invoke<[number, Array<[string, string]>]>("dl_purge_stopped", { gids, deleteFile });
        console.info(`[purge] facade result count=${count} failed=${failed.length} deleteFile=${deleteFile}`);
        for (const gid of gids) {
            settleTerminal(store, gid, "removed");
        }
        emit();
        return failed;
    }

    // 自愈：后端是真相源；complete 等终局经 settleTerminal 出机入归档，机内变迁走 transition。
    async function reconcile(gid: string): Promise<void> {
        const item = await invoke<BackendTaskSnapshot>("dl_tell_status", { gid });
        const status = item.status as TaskProjection["status"];
        if (status === "removed") return;
        if (status === "complete") {
            settleTerminal(store, gid, "complete");
            const archived = store.archive.get(gid);
            if (archived) {
                store.archive.set(gid, {
                    ...archived,
                    total: Number(item.totalLength) || archived.total,
                    downloaded: Number(item.completedLength) || archived.downloaded,
                });
            }
        } else {
            restoreTask(store, {
                gid: item.gid,
                status,
                retryCount: item.retryCount ?? 0,
                nextRetryAtMs: item.nextRetryAtMs ?? 0,
                dir: item.dir,
                total: Number(item.totalLength) || 0,
                downloaded: Number(item.completedLength) || 0,
                speed: Number(item.downloadSpeed) || 0,
                error: item.errorMessage ?? undefined,
            });
        }
        emit();
    }

    async function pause(gid: string): Promise<void> {
        try {
            await invoke("dl_pause", { gid });
        } catch (error: unknown) {
            // 后端终局/变迁拒绝时拉真相自愈（修 complete 事件漏投卡 active 行点暂停报错）。
            if (/非法状态变迁|任务不存在/u.test(String(error))) await reconcile(gid);
            throw error;
        }
        emit();
    }
    async function pauseAll(): Promise<number> {
        const count = await invoke<number>("dl_pause_all");
        gates.pausedAll = true;
        emit();
        return count;
    }
    async function pauseCollection(collectionId: string): Promise<number> {
        const count = await invoke<number>("dl_pause_collection", { collectionId });
        gates.pausedCollections.add(collectionId);
        emit();
        return count;
    }
    async function resume(gid: string): Promise<void> {
        await invoke("dl_resume", { gid });
        emit();
    }
    async function resumeAll(): Promise<number> {
        const count = await invoke<number>("dl_resume_all");
        gates.pausedAll = false;
        gates.pausedCollections.clear();
        emit();
        return count;
    }

    async function resumeCollection(collectionId: string): Promise<void> {
        await invoke("dl_resume_collection", { collectionId });
        gates.pausedCollections.delete(collectionId);
        emit();
    }

    // 人工重试入口：error → retrying，保留 gid/sidecar 断点（后端 dl_retry）。
    async function retry(gid: string): Promise<void> {
        await invoke("dl_retry", { gid });
        emit();
    }

    // 只读查询：后端快照（含真实落盘 files[].path），打开文件/定位等动作的路径真相源。
    async function tellStatus(gid: string): Promise<BackendTaskSnapshot> {
        return invoke<BackendTaskSnapshot>("dl_tell_status", { gid });
    }

    function subscribe(cb: (tasks: TaskProjection[]) => void): () => void {
        listeners.add(cb);
        cb(snapshot(store));
        return () => {
            listeners.delete(cb);
        };
    }

    // 后端事件订阅：facade 创建即接通（dl-task-changed/dl-progress → 投影机 → 通知快照订阅者）。
    // 单例与应用同生命周期，不提供解除入口。
    void subscribeBackendEvents(store, emit);

    return { store, metas, gates, enqueue, cancel, forget, purge, pause, pauseAll, pauseCollection, resume, resumeAll, resumeCollection, retry, tellStatus, subscribe, snapshot: () => snapshot(store) };
}
