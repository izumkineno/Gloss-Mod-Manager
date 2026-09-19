// 下载任务共享 Pinia store：下载页 + collection 页统一任务快照/订阅/meta。
// 之前是 composable，各页 ref 独立、互不相通；现收口一处，事件订阅引用计数，回调注册制。
import { computed, ref } from "vue";
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

type NewlyCompletedHandler = (gids: string[], tasks: IDownloaderTask[]) => void;

export const useDownloadTasksStore = defineStore("DownloadTasks", () => {
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
    let subscriberCount = 0;
    let focusListenerCount = 0;
    const completedHandlers = new Set<NewlyCompletedHandler>();

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
                for (const handler of completedHandlers) handler(newlyCompletedTaskGids, allDisplayedTasks);
            }
        } catch (error: unknown) {
            if (currentSequence !== refreshSequence) return;
            tasksErrorMessage.value = error instanceof Error ? error.message : "操作失败，请稍后重试。";
        } finally {
            if (!silent && currentSequence === refreshSequence) refreshingTasks.value = false;
        }
    }

    // 轻量快照：同样走 merge + meta 对齐（之前 snapshotOnly 偷工减料，重启任务/已导入全看不到）。
    async function refreshTaskSnapshot() {
        await refreshTaskLists(true);
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

    // 重试成功三件套：forget 后端 + 清快照 + 删 meta 落盘。
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
        void refreshTaskLists(true);
    }

    function handleVisibilityRefresh() {
        if (document.visibilityState === "visible") {
            void refreshTaskLists(true);
        }
    }

    function ensureEventSubscription() {
        subscriberCount += 1;
        if (!releaseTaskEvents) {
            void subscribeDownloadTaskEvents(() => {
                void refreshTaskLists(true);
            }).then((release) => {
                releaseTaskEvents = release;
            });
        }
        return () => {
            subscriberCount = Math.max(0, subscriberCount - 1);
            if (subscriberCount === 0) {
                releaseTaskEvents?.();
                releaseTaskEvents = null;
            }
        };
    }

    function ensureFocusRefresh() {
        focusListenerCount += 1;
        if (focusListenerCount === 1) {
            window.addEventListener("focus", handleWindowFocusRefresh);
            document.addEventListener("visibilitychange", handleVisibilityRefresh);
        }
        return () => {
            focusListenerCount = Math.max(0, focusListenerCount - 1);
            if (focusListenerCount === 0) {
                window.removeEventListener("focus", handleWindowFocusRefresh);
                document.removeEventListener("visibilitychange", handleVisibilityRefresh);
            }
        };
    }

    function onNewlyCompleted(handler: NewlyCompletedHandler) {
        completedHandlers.add(handler);
        return () => {
            completedHandlers.delete(handler);
        };
    }

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
        ensureEventSubscription,
        ensureFocusRefresh,
        onNewlyCompleted,
        isTaskOperating: (gid: string) => taskOperatingIds.value.includes(gid),
        notifySuccess: (msg: string) => ElMessage.success(msg),
        notifyError: (msg: string) => ElMessage.error(msg),
    };
});
