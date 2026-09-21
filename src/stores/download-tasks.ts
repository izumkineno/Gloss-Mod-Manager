// 下载任务共享 Pinia store（Wave 3 薄包装）：状态一律走 facade 单例，禁止自有状态机。
// 数据经 facade.snapshot()/subscribe 读取；操作经 facade 方法透传；meta 真相源在后端 download_meta.json。
import { computed, ref } from "vue";
import { ElMessage } from "element-plus-message";
import { getDownloadFacade } from "@/features/download/facade";
import type { TaskProjection } from "@/features/download/types";
import { FileHandler } from "@/lib/FileHandler";
import { getTaskPrimaryFile } from "@/features/download/view/format";
import type { IDownloaderGlobalStat, IDownloaderTask } from "@/features/download/types";
import type { IGlossDownloadTaskMeta } from "@/lib/gloss-download";
import { listDownloadMeta, putDownloadMeta, removeDownloadMeta } from "@/lib/download-meta";

function defaultGlobalStat(): IDownloaderGlobalStat {
    return { downloadSpeed: "0", numActive: "0", numWaiting: "0", numStopped: "0" };
}

type NewlyCompletedHandler = (gids: string[], tasks: TaskProjection[]) => void;

// facade 快照（新 5 态）→ 页内旧 IDownloaderTask 形状适配：files 为空，进度字段缺省。
function toLegacyTask(task: TaskProjection): IDownloaderTask {
    return {
        gid: task.gid,
        status: task.status,
        files: [],
        dir: "",
        totalLength: String(task.total ?? 0),
        completedLength: String(task.downloaded ?? 0),
        downloadSpeed: String(task.speed ?? 0),
        errorMessage: task.error ?? "",
    };
}

export const useDownloadTasksStore = defineStore("DownloadTasks", () => {
    const facade = getDownloadFacade();
    const tasksLoading = ref(false);
    const tasksErrorMessage = ref("");
    const refreshingTasks = ref(false);
    const globalStat = ref<IDownloaderGlobalStat>(defaultGlobalStat());
    const taskList = ref<TaskProjection[]>([]);
    const taskOperatingIds = ref<string[]>([]);
    const taskMetaMap = ref<Record<string, IGlossDownloadTaskMeta>>({});

    const completedHandlers = new Set<NewlyCompletedHandler>();
    let releaseSubscribe: (() => void) | null = null;
    let subscriberCount = 0;

    // 页内仍消费 active/waiting/stopped 三桶：waiting 桶含 paused（模板 v-if 区分）。
    const activeTasks = computed(() => taskList.value.filter((t) => t.status === "active").map(toLegacyTask));
    const waitingTasks = computed(() => taskList.value.filter((t) => t.status === "waiting" || t.status === "paused").map(toLegacyTask));
    const stoppedTasks = computed(() => taskList.value.filter((t) => t.status === "complete").map(toLegacyTask));
    const allTasks = computed(() => taskList.value.map(toLegacyTask));
    const failedTasks = computed(() => taskList.value.filter((t) => t.status === "error").map(toLegacyTask));
    const finishedTasks = computed(() => taskList.value.filter((t) => t.status === "complete").map(toLegacyTask));

    function pullSnapshot(): void {
        taskList.value = facade.snapshot();
    }

    async function refreshTaskLists(silent = false): Promise<void> {
        try {
            taskMetaMap.value = await listDownloadMeta();
            pullSnapshot();
            tasksErrorMessage.value = "";
        } catch (error: unknown) {
            tasksErrorMessage.value = error instanceof Error ? error.message : "操作失败，请稍后重试。";
        } finally {
            if (!silent) {
                refreshingTasks.value = false;
            }
        }
    }

    async function refreshTaskSnapshot(): Promise<void> {
        await refreshTaskLists(true);
    }

    async function setTaskMeta(gid: string, metadata: IGlossDownloadTaskMeta): Promise<void> {
        const nextMeta: IGlossDownloadTaskMeta = { ...taskMetaMap.value[gid], ...metadata };
        if (!nextMeta.createdAt) {
            nextMeta.createdAt = new Date().toISOString();
        }
        await putDownloadMeta(gid, nextMeta);
        taskMetaMap.value = { ...taskMetaMap.value, [gid]: nextMeta };
    }

    async function removeTaskMeta(gid: string): Promise<void> {
        if (!taskMetaMap.value[gid]) {
            return;
        }
        await removeDownloadMeta(gid);
        const nextMap = { ...taskMetaMap.value };
        delete nextMap[gid];
        taskMetaMap.value = nextMap;
    }

    async function forgetTaskRecord(gid: string): Promise<void> {
        await facade.forget(gid);
        // meta 单键删除已在 removeTaskMeta 落盘；不再整表回写（旧快照会洗掉并发链路的新条目）。
        await removeTaskMeta(gid);
        pullSnapshot();
    }

    async function removeTaskRecord(task: IDownloaderTask): Promise<void> {
        const gid = task.gid;
        const primaryFile = getTaskPrimaryFile(task);
        const filePath = primaryFile?.path;
        if (filePath) {
            await FileHandler.deleteFile(filePath);
            await FileHandler.deleteFile(`${filePath}.download.bitcode`);
        }
        await facade.cancel(gid, false);
        // meta 单键删除已在 removeTaskMeta 落盘；不再整表回写（旧快照会洗掉并发链路的新条目）。
        await removeTaskMeta(gid);
        pullSnapshot();
    }

    function startTaskOperation(gid: string): void {
        if (!taskOperatingIds.value.includes(gid)) {
            taskOperatingIds.value = [...taskOperatingIds.value, gid];
        }
    }

    function finishTaskOperation(gid: string): void {
        taskOperatingIds.value = taskOperatingIds.value.filter((item) => item !== gid);
    }

    function ensureEventSubscription(): () => void {
        subscriberCount += 1;
        if (!releaseSubscribe) {
            pullSnapshot();
            releaseSubscribe = facade.subscribe(() => {
                pullSnapshot();
            });
        }
        return () => {
            subscriberCount = Math.max(0, subscriberCount - 1);
            if (subscriberCount === 0) {
                releaseSubscribe?.();
                releaseSubscribe = null;
            }
        };
    }

    function ensureFocusRefresh(): () => void {
        const onFocus = (): void => {
            void refreshTaskLists(true);
        };
        window.addEventListener("focus", onFocus);
        return () => {
            window.removeEventListener("focus", onFocus);
        };
    }

    function onNewlyCompleted(handler: NewlyCompletedHandler): () => void {
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
