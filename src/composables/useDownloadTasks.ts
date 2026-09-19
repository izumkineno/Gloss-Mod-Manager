// 下载任务共享状态 composable：下载页 + collection 页统一任务快照/订阅/meta/暂停继续/retry 清理。
// 两页只留模板 + 各自业务（下载页详情/导入、collection 页 pending 清单），任务层逻辑全部收口此处。
import { computed, onMounted, onUnmounted, ref, type ComputedRef, type Ref } from "vue";
import { ElMessage } from "element-plus-message";
import { Downloader } from "@/lib/native-downloader";
import { subscribeDownloadTaskEvents } from "@/lib/download-task-events";
import {
    isRestoredDownloadTask,
    mergeDownloadTaskSnapshots,
    removeDownloadTaskSnapshot,
} from "@/lib/download-task-cache";
import { getTaskPrimaryFile } from "@/lib/download-task-ui";
import { FileHandler } from "@/lib/FileHandler";
import { PersistentStore } from "@/lib/persistent-store";
import type { IDownloaderGlobalStat, IDownloaderTask } from "@/lib/download-task-types";
import type { IGlossDownloadTaskMeta } from "@/lib/gloss-download";
export const DOWNLOAD_TASK_META_KEY = "aria2TaskMetaMap";

function defaultGlobalStat(): IDownloaderGlobalStat {
    return { downloadSpeed: "0", numActive: "0", numWaiting: "0", numStopped: "0" };
}

export function useDownloadTasks(options?: {
    // 事件回调是否只刷任务快照（collection 页用，避免事件风暴写盘）。
    snapshotOnly?: boolean;
    // 新完成任务回调（下载页接自动导入）。
    onNewlyCompleted?: (gids: string[], tasks: IDownloaderTask[]) => void;
    // 是否监听窗口聚焦/可见性兜底刷新（下载页用）。
    focusRefresh?: boolean;
}) {
    const tasksLoading = ref(false);
    const tasksErrorMessage = ref("");
    const refreshingTasks = ref(false);
    const globalStat = ref<IDownloaderGlobalStat>(defaultGlobalStat());
    const activeTasks = ref<IDownloaderTask[]>([]);
    const waitingTasks = ref<IDownloaderTask[]>([]);
    const stoppedTasks = ref<IDownloaderTask[]>([]);
    const taskOperatingIds = ref<string[]>([]);
    const taskMetaMap = PersistentStore.useValue<Record<string, IGlossDownloadTaskMeta>>(DOWNLOAD_TASK_META_KEY, {});

    let refreshSequence = 0;
    let hasCompletedInitialTaskSync = false;
    let releaseTaskEvents: (() => void) | null = null;

    const allTasks = computed(() => [...activeTasks.value, ...waitingTasks.value, ...stoppedTasks.value]);
    const failedTasks = computed(() => stoppedTasks.value.filter((task) => task.status === "error"));
    const finishedTasks = computed(() => stoppedTasks.value.filter((task) => task.status !== "error"));

    // 快照对齐 meta：返回新完成 gid 供自动导入。
    function syncTaskMetaStatuses(tasks: IDownloaderTask[]) {
        const nextMap = { ...taskMetaMap.value };
        let changed = false;
        const newlyCompletedTaskGids: string[] = [];
        for (const task of tasks) {
            const currentMeta = nextMap[task.gid];
            if (!currentMeta) continue;
            const nextMeta: IGlossDownloadTaskMeta = {
                ...currentMeta,
                createdAt: currentMeta.createdAt || currentMeta.downloadedAt || currentMeta.importedAt || currentMeta.updatedAt || new Date().toISOString(),
                taskStatus: task.status as TaskStatus,
                updatedAt: new Date().toISOString(),
            };
            if (task.status === "complete" && currentMeta.taskStatus !== "complete") {
                newlyCompletedTaskGids.push(task.gid);
            }
            if (task.status === "complete" && !currentMeta.downloadedAt) {
                nextMeta.downloadedAt = new Date().toISOString();
            }
            if (nextMeta.createdAt !== currentMeta.createdAt || nextMeta.taskStatus !== currentMeta.taskStatus || nextMeta.downloadedAt !== currentMeta.downloadedAt) {
                nextMap[task.gid] = nextMeta;
                changed = true;
            }
        }
        if (changed) taskMetaMap.value = nextMap;
        return newlyCompletedTaskGids;
    }

    async function refreshTaskLists(silent = false) {
        const currentSequence = ++refreshSequence;
        if (!silent) refreshingTasks.value = true;
        try {
            const outputDirectory = await Downloader.resolveDownloadDirectory();
            await FileHandler.createDirectory(outputDirectory);
            const [stat, active, waiting, stopped] = await Promise.all([
                Downloader.getGlobalStat(),
                Downloader.tellActive(),
                Downloader.tellWaiting(0, 100),
                Downloader.tellStopped(0, 100),
            ]);
            if (currentSequence !== refreshSequence) return;
            const liveTasks = [...active, ...waiting, ...stopped];
            const mergedTasks = await mergeDownloadTaskSnapshots(liveTasks, taskMetaMap.value, outputDirectory);
            const liveGids = new Set(liveTasks.map((task) => task.gid));
            const restoredTasks = mergedTasks.filter((task) => !liveGids.has(task.gid));
            const displayedStoppedTasks = [
                ...stopped,
                ...restoredTasks.filter((task) => !["active", "waiting", "paused"].includes(task.status)),
            ];
            const allDisplayedTasks = [...active, ...waiting, ...displayedStoppedTasks];
            const newlyCompletedTaskGids = syncTaskMetaStatuses(allDisplayedTasks);
            globalStat.value = stat;
            activeTasks.value = active;
            waitingTasks.value = waiting;
            stoppedTasks.value = displayedStoppedTasks;
            tasksErrorMessage.value = "";
            if (!hasCompletedInitialTaskSync) {
                hasCompletedInitialTaskSync = true;
                return;
            }
            if (newlyCompletedTaskGids.length > 0) {
                options?.onNewlyCompleted?.(newlyCompletedTaskGids, allDisplayedTasks);
            }
        } catch (error: unknown) {
            if (currentSequence !== refreshSequence) return;
            tasksErrorMessage.value = error instanceof Error ? error.message : "操作失败，请稍后重试。";
        } finally {
            if (!silent && currentSequence === refreshSequence) refreshingTasks.value = false;
        }
    }

    // 轻量快照（collection 页用：无 globalStat、无 autoImport、无 focus 兜底）。
    async function refreshTaskSnapshot() {
        const [active, waiting, stopped] = await Promise.all([
            Downloader.tellActive(),
            Downloader.tellWaiting(0, 100),
            Downloader.tellStopped(0, 100),
        ]);
        activeTasks.value = active;
        waitingTasks.value = waiting;
        stoppedTasks.value = stopped;
    }

    function setTaskMeta(gid: string, metadata: IGlossDownloadTaskMeta) {
        const nextMeta: IGlossDownloadTaskMeta = { ...taskMetaMap.value[gid], ...metadata };
        if (!nextMeta.createdAt) nextMeta.createdAt = new Date().toISOString();
        if (!nextMeta.modTitle?.trim()) {
            nextMeta.modTitle = nextMeta.resourceName?.trim() || nextMeta.fileName?.trim() || nextMeta.modTitle;
        }
        taskMetaMap.value = { ...taskMetaMap.value, [gid]: nextMeta };
    }

    function removeTaskMeta(gid: string) {
        if (!taskMetaMap.value[gid]) return;
        const nextMap = { ...taskMetaMap.value };
        delete nextMap[gid];
        taskMetaMap.value = nextMap;
    }

    async function saveTaskMetaMap(nextMap: Record<string, IGlossDownloadTaskMeta>) {
        await PersistentStore.set(DOWNLOAD_TASK_META_KEY, nextMap, true);
    }

    // 重试成功三件套：forget 后端 + 清快照 + 删 meta 落盘（P0/P1 修过，收口此处）。
    async function forgetTaskRecord(gid: string) {
        try {
            await Downloader.removeDownloadResult(gid);
        } catch {
            // 旧任务已被清理属于正常竞态，忽略。
        }
        removeTaskMeta(gid);
        await removeDownloadTaskSnapshot(gid);
        await saveTaskMetaMap(taskMetaMap.value);
    }

    // 删任务四件套：后端记录 + 本地文件 + 快照 + meta 落盘。
    async function removeTaskRecord(task: IDownloaderTask) {
        if (!isRestoredDownloadTask(task) && ["active", "waiting", "paused"].includes(task.status)) {
            await Downloader.remove(task.gid, true);
            await waitForRemovedTask(task.gid);
        }
        const primaryFile = getTaskPrimaryFile(task);
        if (primaryFile?.path) {
            const deleted = await FileHandler.deleteFile(primaryFile.path);
            if (!deleted) throw new Error(`删除本地文件失败：${task.gid}`);
            await FileHandler.deleteFile(`${primaryFile.path}.download.bitcode`);
        }
        if (!isRestoredDownloadTask(task)) {
            let lastError: unknown = null;
            for (let index = 0; index < 6; index += 1) {
                try {
                    await Downloader.removeDownloadResult(task.gid);
                    lastError = null;
                    break;
                } catch (error: unknown) {
                    lastError = error;
                    // eslint-disable-next-line no-promise-executor-return
                    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 250));
                }
            }
            if (lastError) throw lastError;
        }
        await removeDownloadTaskSnapshot(task.gid);
        removeTaskMeta(task.gid);
        await saveTaskMetaMap(taskMetaMap.value);
    }

    async function waitForRemovedTask(gid: string) {
        for (let index = 0; index < 6; index += 1) {
            try {
                const task = await Downloader.tellStatus(gid);
                if (["removed", "complete", "error"].includes(task.status)) return;
            } catch {
                return;
            }
            // eslint-disable-next-line no-promise-executor-return
            await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 250));
        }
    }
    function startTaskOperation(gid: string) {
        if (taskOperatingIds.value.includes(gid)) return;
        taskOperatingIds.value = [...taskOperatingIds.value, gid];
    }

    function finishTaskOperation(gid: string) {
        taskOperatingIds.value = taskOperatingIds.value.filter((item) => item !== gid);
    }

    function handleWindowFocusRefresh() {
        void (options?.snapshotOnly ? refreshTaskSnapshot() : refreshTaskLists(true));
    }

    function handleVisibilityRefresh() {
        if (document.visibilityState === "visible") {
            void (options?.snapshotOnly ? refreshTaskSnapshot() : refreshTaskLists(true));
        }
    }

    onMounted(() => {
        void subscribeDownloadTaskEvents(() => {
            void (options?.snapshotOnly ? refreshTaskSnapshot() : refreshTaskLists(true));
        }).then((release) => {
            releaseTaskEvents = release;
        });
        if (options?.focusRefresh) {
            window.addEventListener("focus", handleWindowFocusRefresh);
            document.addEventListener("visibilitychange", handleVisibilityRefresh);
        }
    });

    onUnmounted(() => {
        releaseTaskEvents?.();
        releaseTaskEvents = null;
        if (options?.focusRefresh) {
            window.removeEventListener("focus", handleWindowFocusRefresh);
            document.removeEventListener("visibilitychange", handleVisibilityRefresh);
        }
    });

    return {
        tasksLoading,
        tasksErrorMessage,
        refreshingTasks,
        globalStat,
        activeTasks,
        waitingTasks,
        stoppedTasks,
        allTasks,
        failedTasks,
        finishedTasks,
        taskOperatingIds,
        taskMetaMap,
        refreshTaskLists,
        refreshTaskSnapshot,
        setTaskMeta,
        removeTaskMeta,
        saveTaskMetaMap,
        forgetTaskRecord,
        removeTaskRecord,
        startTaskOperation,
        finishTaskOperation,
        isTaskOperating: (gid: string) => taskOperatingIds.value.includes(gid),
        notifySuccess: (msg: string) => ElMessage.success(msg),
        notifyError: (msg: string) => ElMessage.error(msg),
    };
}

export interface DownloadTasksStore {
    tasksLoading: Ref<boolean>;
    tasksErrorMessage: Ref<string>;
    refreshingTasks: Ref<boolean>;
    globalStat: Ref<IDownloaderGlobalStat>;
    activeTasks: Ref<IDownloaderTask[]>;
    waitingTasks: Ref<IDownloaderTask[]>;
    stoppedTasks: Ref<IDownloaderTask[]>;
    allTasks: ComputedRef<IDownloaderTask[]>;
    failedTasks: ComputedRef<IDownloaderTask[]>;
    finishedTasks: ComputedRef<IDownloaderTask[]>;
    taskOperatingIds: Ref<string[]>;
    taskMetaMap: Ref<Record<string, IGlossDownloadTaskMeta>>;
    refreshTaskLists: (silent?: boolean) => Promise<void>;
    refreshTaskSnapshot: () => Promise<void>;
    setTaskMeta: (gid: string, metadata: IGlossDownloadTaskMeta) => void;
    removeTaskMeta: (gid: string) => void;
    saveTaskMetaMap: (nextMap: Record<string, IGlossDownloadTaskMeta>) => Promise<void>;
    forgetTaskRecord: (gid: string) => Promise<void>;
    removeTaskRecord: (task: IDownloaderTask) => Promise<void>;
    startTaskOperation: (gid: string) => void;
    finishTaskOperation: (gid: string) => void;
    isTaskOperating: (gid: string) => boolean;
    notifySuccess: (msg: string) => void;
    notifyError: (msg: string) => void;
}
