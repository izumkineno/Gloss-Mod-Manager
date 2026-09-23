<script setup lang="ts">
// 下载中心页（Wave 3.6 瘦身后）：布局 + 事件转发 + 模板壳。
// 任务/导入/去重/重试/资源/引擎逻辑已迁入 features/download/view/，此处只做组装。
// 数据经 facade 单例快照直读（download-tasks 薄包装已消亡）；probe 链路调用位置不变。
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { ElMessage } from "element-plus-message";
import { FileHandler } from "@/lib/FileHandler";
import { autoImportCompletedDownloadTasks } from "@/lib/gloss-download-monitor";
import type { IGlossDownloadTaskMeta } from "@/lib/gloss-download";
import type { FomodConfig } from "@/lib/fomod-parser";
import { getDownloadFacade } from "@/features/download/facade";
import type {
    IDownloaderTask,
    TaskProjection,
} from "@/features/download/types";
import { listDownloadMeta, putDownloadMeta, removeDownloadMeta } from "@/lib/download-meta";
import {
    formatBytes,
    getTaskPrimaryFile,
    getTaskProgress,
} from "@/features/download/view/format";
import {
    formatDate,
    formatNumber,
    formatSpeed,
    getBaseName,
    getErrorMessage,
    getTaskDisplayName,
    getTaskStatusClass,
    getTaskStatusLabel,
} from "@/features/download/view/task-display";
import {
    TASK_PAGE_SIZE_OPTIONS,
    useQueueView,
} from "@/features/download/view/queue-view";
import {
    removeStaleSiblingRecords as removeStaleSiblingRecordsCore,
    useDedupeDialog,
} from "@/features/download/view/dedupe";
import {
    pauseAllTasks as pauseAllTasksCore,
    pauseTask as pauseTaskCore,
    removeTask as removeTaskCore,
    resumeAllTasks as resumeAllTasksCore,
    resumeTask as resumeTaskCore,
    purgeStoppedTasks as purgeStoppedTasksCore,
} from "@/features/download/view/task-ops";
import {
    importAllCompletedTasks as importAllCompletedTasksCore,
    importTaskToLocalManager as importTaskToLocalManagerCore,
    useTaskImportState,
    type ImportDeps,
} from "@/features/download/view/task-import";
import { refreshImportStatus as refreshImportStatusCore } from "@/features/download/view/task-import-sync";
import {
    retryAllFailedTasks as retryAllFailedTasksCore,
    retryTask as retryTaskCore,
    type RetryDeps,
} from "@/features/download/view/task-retry";
import {
    EMPTY_POSTER,
    addResourceTask as addResourceTaskCore,
    getResourceActionLabel as getResourceActionLabelCore,
    getResourcePresence as getResourcePresenceCore,
    resolveGlossAssetUrl,
    useResourceAdding,
    type IAddResourceTaskResult,
    type ResourceDeps,
} from "@/features/download/view/resource-task";
import {
    createManualDownloadTask as createManualDownloadTaskCore,
    useDownloaderSettingsDialog,
    useEngineSettings,
    useManualDownload,
} from "@/features/download/view/engine-settings";
import { extractModId, useModLookup } from "@/features/download/view/mod-lookup";

// facade 直连快照（薄包装消亡后页面自持，无 Pinia 中转）。
// 注：files 为空（进度/文件走后端事件投影，模板已有缺省展示）。
const facade = getDownloadFacade();
const tasksLoading = ref(false);
const tasksErrorMessage = ref("");
const refreshingTasks = ref(false);
const globalStat = ref({ downloadSpeed: "0", numActive: "0", numWaiting: "0", numStopped: "0" });
const taskList = ref<TaskProjection[]>([]);
const taskOperatingIds = ref<string[]>([]);
const showAddModDialog = ref(false);
const showTaskDetailDialog = ref(false);
// 兼容垫片（模板仍按旧桶消费 facade 快照，禁止自有状态机）。
// files 按单文件任务建模：dir + meta.fileName 拼绝对路径（open-file 链路与详情文件列表用）。
function toLegacyTask(task: TaskProjection, meta?: IGlossDownloadTaskMeta): IDownloaderTask {
    const dir = task.dir ?? "";
    const fileName = meta?.fileName ?? "";
    const filePath = dir && fileName ? `${dir.replace(/[\\/]+$/u, "")}/${fileName}` : "";
    return {
        gid: task.gid,
        status: task.status,
        totalLength: String(task.total ?? 0),
        completedLength: String(task.downloaded ?? 0),
        downloadSpeed: String(task.speed ?? 0),
        dir,
        errorMessage: task.error ?? "",
        files: filePath ? [{ path: filePath, uris: [{ status: "used", uri: meta?.downloadUrl ?? "" }] }] : [],
    };
}
const activeTasks = computed(() => taskList.value.filter((t) => t.status === "active").map((t) => toLegacyTask(t, taskMetaMap.value[t.gid])));
const waitingTasks = computed(() => taskList.value.filter((t) => t.status === "waiting" || t.status === "paused").map((t) => toLegacyTask(t, taskMetaMap.value[t.gid])));
const stoppedTasks = computed(() => taskList.value.filter((t) => t.status === "complete").map((t) => toLegacyTask(t, taskMetaMap.value[t.gid])));
const allTasks = computed(() => taskList.value.map((t) => toLegacyTask(t, taskMetaMap.value[t.gid])));
const failedTasks = computed(() => taskList.value.filter((t) => t.status === "error").map((t) => toLegacyTask(t, taskMetaMap.value[t.gid])));
const finishedTasks = computed(() => taskList.value.filter((t) => t.status === "complete").map((t) => toLegacyTask(t, taskMetaMap.value[t.gid])));
async function refreshTaskLists(silent = false): Promise<void> {
    if (!silent) refreshingTasks.value = true;
    try {
        taskList.value = facade.snapshot();
    } finally {
        if (!silent) refreshingTasks.value = false;
    }
}
function startTaskOperation(gid: string): void {
    if (!taskOperatingIds.value.includes(gid)) taskOperatingIds.value = [...taskOperatingIds.value, gid];
}
function finishTaskOperation(gid: string): void {
    taskOperatingIds.value = taskOperatingIds.value.filter((item) => item !== gid);
}
const isTaskOperating = (gid: string) => taskOperatingIds.value.includes(gid);
let releaseFacadeSubscribe: (() => void) | null = null;
// meta/投影/引擎设置真相源在后端（download_meta.json/download_store.json）；页面持本地 ref 展示，写操作直调后端桥。
const taskMetaMap = ref<Record<string, IGlossDownloadTaskMeta>>({});
async function reloadTaskMetaMap(): Promise<void> {
    const loaded = await listDownloadMeta();
    const entries = Object.entries(loaded);
    const orphans = entries.filter(([, m]) => !(m as { fileName?: string })?.fileName && !(m as { resourceName?: string })?.resourceName);
    if (orphans.length > 0) {
        console.warn(`[uuid-trace] reloadTaskMetaMap orphans=${orphans.length}/${entries.length} gids=${orphans.map(([gid]) => gid).join(",")}`);
        for (const [gid, meta] of orphans) {
            console.warn(`[uuid-trace] orphan meta gid=${gid} `, meta);
        }
    } else {
        console.debug(`[uuid-trace] reloadTaskMetaMap ok total=${entries.length}`);
    }
    taskMetaMap.value = loaded;
}
async function setTaskMeta(gid: string, metadata: IGlossDownloadTaskMeta): Promise<void> {
    await putDownloadMeta(gid, metadata);
    taskMetaMap.value = { ...taskMetaMap.value, [gid]: metadata };
}
async function removeTaskMeta(gid: string): Promise<void> {
    await removeDownloadMeta(gid);
    const next = { ...taskMetaMap.value };
    delete next[gid];
    taskMetaMap.value = next;
}
async function forgetTaskRecord(gid: string): Promise<void> {
    await facade.forget(gid);
    await removeTaskMeta(gid);
    await refreshTaskLists(true);
}
async function removeTaskRecord(task: IDownloaderTask): Promise<void> {
    await facade.cancel(task.gid);
    await removeTaskMeta(task.gid);
    await refreshTaskLists(true);
}

// 跨 store 依赖（自动全局导入不可用处显式引入）。
const manager = useManager();
const settings = useSettings();
const route = useRoute();
const { storagePath } = storeToRefs(settings);

// 引擎/目录/设置（持久化键与原页面一致）。
const engine = useEngineSettings();
const {
    disableSymlinkInstall,
    downloadProxy,
    downloaderSettings,
    normalizedDownloaderSettings,
    resolvedDownloadDirectory,
} = engine;

// 手动建任务 / 下载设置弹窗。
const manual = useManualDownload();
const settingsDialog = useDownloaderSettingsDialog();

// 队列筛选/分页/选中。
const queue = useQueueView({
    activeTasks,
    waitingTasks,
    allTasks,
    failedTasks,
    finishedTasks,
    taskMetaMap,
});
const {
    queueFilter,
    taskPage,
    taskPageSize,
    selectedTaskGid,
    filteredTasks,
    filteredTaskCount,
    paginatedTasks,
    taskTotalPages,
    visibleTaskRangeLabel,
    taskPaginationItems,
    selectedTask,
    selectedTaskMeta,
    queueFilterOptions,
    goToTaskPage,
    fixSelectedTask,
    fixTaskPage,
} = queue;

// 去重弹窗。
const dedupe = useDedupeDialog();
const { duplicateDialog, resolveDuplicateDialog } = dedupe;

// 导入进行态。
const importState = useTaskImportState();
const { isTaskImporting } = importState;

// 资源添加进行键。
const resourceAdding = useResourceAdding();
const { addingResourceKey } = resourceAdding;

// Mod 查找。
const modLookup = useModLookup({ glossModKey: settings.glossModKey });
const {
    modLookupInput,
    modLookupLoading,
    modLookupError,
    selectedMod,
    detailParagraphs,
    loadModDetail,
} = modLookup;

// 展示名需带 meta：模板 getTaskDisplayName(task) 单参调用保持兼容。
function getTaskDisplayNameBound(task: IDownloaderTask): string {
    return getTaskDisplayName(task, taskMetaMap.value[task.gid]);
}

// 任务操作转发（模板保持原调用形状）。
const taskOpsHooks = {
    startTaskOperation,
    finishTaskOperation,
    refreshTaskLists,
    removeTaskRecord,
};
function pauseTask(task: IDownloaderTask): Promise<void> {
    return pauseTaskCore(task, taskOpsHooks);
}
function resumeTask(task: IDownloaderTask): Promise<void> {
    return resumeTaskCore(task, taskOpsHooks);
}
function removeTask(task: IDownloaderTask): Promise<void> {
    return removeTaskCore(task, taskOpsHooks);
}
function pauseAllTasks(): Promise<void> {
    return pauseAllTasksCore(() => refreshTaskLists());
}
function resumeAllTasks(): Promise<void> {
    return resumeAllTasksCore(() => refreshTaskLists());
}
// 清理确认弹窗：下载中/已完成/下载失败三项共用，额外勾选是否删本地文件。
// 下载中任务后端 purge 会跳过（Active/Waiting/Retrying），确认时先逐个 cancel 再清记录。
const showPurgeConfirmDialog = ref(false);
const purgeDeleteFile = ref(false);
const purgeTarget = ref<"downloading" | "stopped" | "failed">("stopped");
const downloadingTasks = computed(() => [...activeTasks.value, ...waitingTasks.value]);
const purgeTargetTasks = computed(() =>
    purgeTarget.value === "downloading" ? downloadingTasks.value : purgeTarget.value === "failed" ? failedTasks.value : stoppedTasks.value,
);
const purgeTargetCount = computed(() => purgeTargetTasks.value.length);
const purgeTargetLabel = computed(() => (purgeTarget.value === "downloading" ? "下载中" : purgeTarget.value === "failed" ? "下载失败" : "已完成"));
function openPurgeConfirm(target: "downloading" | "stopped" | "failed"): void {
    const list = target === "downloading" ? downloadingTasks.value : target === "failed" ? failedTasks.value : stoppedTasks.value;
    if (list.length === 0) {
        ElMessage.info("当前没有可清理的任务。");
        return;
    }
    purgeTarget.value = target;
    purgeDeleteFile.value = false;
    showPurgeConfirmDialog.value = true;
}
async function confirmPurgeTasks(): Promise<void> {
    showPurgeConfirmDialog.value = false;
    if (purgeTarget.value === "downloading") {
        // 先取消下载中任务（deleteFile 透传），再按停止态清记录。
        for (const task of [...downloadingTasks.value]) {
            try {
                await facade.cancel(task.gid, purgeDeleteFile.value);
            } catch (error: unknown) {
                console.warn(`[purge] cancel downloading FAILED gid=${task.gid}`, error);
            }
        }
    }
    const tasks = purgeTarget.value === "downloading" ? [...downloadingTasks.value] : purgeTargetTasks.value;
    return purgeStoppedTasksCore(
        tasks,
        {
            ...taskOpsHooks,
            removeTaskMeta,
        },
        purgeDeleteFile.value,
    );
}

// 去重旧记录清理（同文件归一键）。
function getPrimaryFileName(task: IDownloaderTask): string {
    return getTaskPrimaryFile(task)?.path?.split(/[\\/]+/u).pop() || "";
}
function removeStaleSiblingRecords(gid: string): Promise<number> {
    return removeStaleSiblingRecordsCore(
        gid,
        { taskMetaMap, allTasks, getTaskDisplayName: getTaskDisplayNameBound, forgetTaskRecord },
        getPrimaryFileName,
    );
}

// 重试转发。
function buildRetryDeps(): RetryDeps {
    return {
        taskMetaMap: taskMetaMap.value,
        allTasks: allTasks.value,
        failedTasks: failedTasks.value,
        forgetTaskRecord,
        removeTaskRecord,
        refreshTaskLists,
        startTaskOperation,
        finishTaskOperation,
        removeStaleSiblingRecords,
        setTaskMeta,
        selectTask: (gid: string) => {
            selectedTaskGid.value = gid;
        },
        ensureEngineReady: () => engine.ensureEngineReady(),
        normalizedDownloaderSettings: normalizedDownloaderSettings.value,
    };
}
function retryTask(task: IDownloaderTask, quiet = false): Promise<string | null> {
    return retryTaskCore(task, buildRetryDeps(), quiet);
}
function retryAllFailedTasks(): Promise<void> {
    return retryAllFailedTasksCore(buildRetryDeps());
}

// 导入转发。
function buildImportDeps(): ImportDeps {
    return {
        manager: manager as unknown as ImportDeps["manager"],
        storagePath: storagePath.value,
        closeSoftLinks: disableSymlinkInstall.value,
        taskMetaMap: taskMetaMap.value,
        setTaskMeta,
        selectedTask: selectedTask.value,
        canImportToLocalManager: canImportToLocalManager.value,
        allTasks: allTasks.value,
        promptDuplicateDecision: dedupe.promptDuplicateDecision,
        startWizard: (config: FomodConfig) => useFomodWizardStore().startWizard(config),
    };
}
const canImportToLocalManager = computed(() =>
    Boolean(storagePath.value && manager.managerGame),
);
function importTaskToLocalManager(task?: IDownloaderTask | null): Promise<void> {
    return importTaskToLocalManagerCore(task, buildImportDeps(), importState);
}
function importAllCompletedTasks(): Promise<void> {
    return importAllCompletedTasksCore(buildImportDeps(), importState);
}
// 刷新导入状态：重读本地 mod 列表，与 meta.localModId 对账（管理器删 mod/别处导入后校准 imported/unimported）。
function refreshImportStatusView(): Promise<unknown> {
    return refreshImportStatusCore({
        allTasks: allTasks.value,
        taskMetaMap: taskMetaMap.value,
        setTaskMeta,
        refreshTaskLists,
        managerRoot: manager.managerRoot,
    });
}

// 资源建任务转发。
function buildResourceDeps(): ResourceDeps {
    return {
        selectedMod: selectedMod.value,
        taskMetaMap: taskMetaMap.value,
        allTasks: allTasks.value,
        resolvedDownloadDirectory: resolvedDownloadDirectory.value,
        downloadProxy: downloadProxy.value ?? "",
        managerModList: manager.managerModList,
        ensureEngineReady: () => engine.ensureEngineReady(),
        setTaskMeta,
        refreshTaskLists,
        removeTaskRecord,
        retryTask: (task: IDownloaderTask) => retryTask(task),
        resumeTask: (task: IDownloaderTask) => resumeTask(task),
        hideAddModDialog: () => {
            showAddModDialog.value = false;
        },
        showTaskDetail: (gid: string) => {
            selectedTaskGid.value = gid;
            showTaskDetailDialog.value = true;
        },
        promptDuplicateDecision: dedupe.promptDuplicateDecision,
    };
}
function addResourceTask(resource: IResource): Promise<IAddResourceTaskResult> {
    return addResourceTaskCore(resource, buildResourceDeps(), addingResourceKey, getTaskStatusLabel);
}
function getResourcePresence(resource: IResource): ReturnType<typeof getResourcePresenceCore> {
    return getResourcePresenceCore(resource, buildResourceDeps());
}
function getResourceActionLabel(resource: IResource): string {
    return getResourceActionLabelCore(resource, buildResourceDeps());
}
function isResourceAdding(resource: IResource): boolean {
    // 键格式与 resource-task.createResourceTask 的登记格式一致：`${modId}-${resource.id ?? 资源名}`。
    const modId = selectedMod.value?.id;
    return addingResourceKey.value === `${modId}-${resource.id ?? resource.mods_resource_name}`;
}

// 在网页打开 Mod 详情页。
async function openModResourcePage(modId: number | string): Promise<void> {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(`https://mod.3dmgame.com/mod/${modId}`);
}

// 弹窗开关（模板保持原调用形状）。
function openAddModDialog(): void {
    showAddModDialog.value = true;
}
function openManualDownloadDialog(): void {
    manual.openManualDownloadDialog();
}
function createManualDownloadTask(): Promise<void> {
    return createManualDownloadTaskCore(manual, engine, {
        storagePath: storagePath.value,
        setTaskMeta,
        refreshTaskLists,
        selectTask: (gid: string) => {
            selectedTaskGid.value = gid;
        },
    });
}
function openDownloaderSettingsDialog(): void {
    settingsDialog.openDownloaderSettingsDialog(downloaderSettings, downloadProxy);
}
function saveDownloaderSettings(): Promise<void> {
    return settingsDialog.saveDownloaderSettings(downloaderSettings, downloadProxy);
}
function openTaskDetail(task: IDownloaderTask): void {
    selectedTaskGid.value = task.gid;
    showTaskDetailDialog.value = true;
}
function selectDownloadDirectory(): Promise<void> {
    return engine.selectDownloadDirectory(() => refreshTaskLists());
}
function openDownloadDirectory(): Promise<void> {
    return engine.openDownloadDirectory();
}
const {
    showManualDownloadDialog,
    manualDownloadUrl,
    manualDownloadFileName,
    manualDownloadCreating,
} = manual;
const {
    showDownloaderSettingsDialog,
    downloaderSettingsDraft,
    downloadProxyDraft,
} = settingsDialog;

// 本地文件路径解析：legacy 合成 files → 后端真相源（dl_tell_status 真实落盘路径）→ meta 文件名拼接。
// 全部落空返回 null（文件确实不存在于已知位置）。
async function resolveTaskLocalPath(task: IDownloaderTask): Promise<{ path?: string } | null> {
    const primary = getTaskPrimaryFile(task);
    if (primary?.path) {
        return primary;
    }
    try {
        const backend = await facade.tellStatus(task.gid);
        const backendFile = backend.files?.find((file) => file.path);
        if (backendFile?.path) {
            return { path: backendFile.path };
        }
    } catch {
        // 后端无此任务（重启后的降级记录），走 meta 兜底。
    }
    const metadata = taskMetaMap.value[task.gid];
    if (metadata?.fileName && task.dir) {
        return { path: `${task.dir.replace(/[\\/]+$/u, "")}/${metadata.fileName}` };
    }
    return null;
}

// 打开文件位置：取主文件父目录调系统文件管理器。
async function openTaskFileLocation(task: IDownloaderTask): Promise<void> {
    const resolved = await resolveTaskLocalPath(task);
    const filePath = resolved?.path;

    if (!filePath) {
        ElMessage.error("未找到本地文件，可能已被移动或删除。");
        return;
    }

    const dirPath = filePath.replace(/[\\/][^\\/]*$/u, "");

    if (!dirPath) {
        ElMessage.error("未找到本地文件，可能已被移动或删除。");
        return;
    }

    const opened = await FileHandler.openFolder(dirPath);

    if (!opened) {
        ElMessage.error("打开文件位置失败。");
    }
}

async function openTaskFolder(task?: IDownloaderTask | null): Promise<void> {
    const target = task ?? selectedTask.value;

    if (!target?.dir) {
        ElMessage.warning("当前任务没有可用目录。");
        return;
    }

    await FileHandler.openFolder(target.dir);
}

async function openTaskFile(task?: IDownloaderTask | null): Promise<void> {
    const targetTask = task ?? selectedTask.value;
    const primaryFile = targetTask ? await resolveTaskLocalPath(targetTask) : null;

    if (!primaryFile?.path) {
        ElMessage.error("未找到本地文件，可能已被移动或删除。");
        return;
    }

    await FileHandler.openFile(primaryFile.path);
}

async function loadRelatedModDetail(task?: IDownloaderTask | null): Promise<void> {
    const targetTask = task ?? selectedTask.value;

    if (!targetTask) {
        return;
    }

    const relatedModId = taskMetaMap.value[targetTask.gid]?.modId;
    const relatedSourceType = taskMetaMap.value[targetTask.gid]?.sourceType;

    if (!relatedModId || relatedSourceType !== "GlossMod") {
        ElMessage.warning("当前任务没有关联的 Mod 详情。");
        return;
    }

    showTaskDetailDialog.value = false;
    showAddModDialog.value = true;
    modLookupInput.value = String(relatedModId);
    await loadModDetail(String(relatedModId));
}

// 自动导入已完成任务（facade 订阅回调）。
async function autoImportCompletedTasks(
    completedTaskGids: string[],
    tasks: IDownloaderTask[],
): Promise<void> {
    await autoImportCompletedDownloadTasks(
        {
            autoAddAfterDownload: settings.autoAddAfterDownload,
            storagePath: storagePath.value,
            closeSoftLinks: disableSymlinkInstall.value,
        },
        completedTaskGids,
        tasks,
    );
}

// 页面初始化：引擎就绪后拉快照。
async function initializeDownloadPage(): Promise<void> {
    try {
        tasksLoading.value = true;
        tasksErrorMessage.value = "";
        await engine.refreshDefaultDownloadDirectory(storagePath.value);
        await engine.ensureEngineReady();
        await reloadTaskMetaMap();
        await refreshTaskLists();
    } catch (error: unknown) {
        tasksErrorMessage.value = getErrorMessage(error);
    } finally {
        tasksLoading.value = false;
    }
}

watch(allTasks, () => {
    fixSelectedTask();
}, { immediate: true });

watch(queueFilter, () => {
    taskPage.value = 1;
});

watch(taskPageSize, () => {
    taskPage.value = 1;
});

watch(
    filteredTaskCount,
    () => {
        fixTaskPage();
    },
    { immediate: true },
);

watch(
    [storagePath, () => manager.managerGame?.gameName, disableSymlinkInstall],
    () => {
        void engine.refreshDefaultDownloadDirectory(storagePath.value);
        void manager.refreshRuntimeData({
            storagePath: storagePath.value,
            closeSoftLinks: disableSymlinkInstall.value,
        });
    },
    { immediate: true },
);

// 自动跳转建任务已关闭：外部不再带 modId/resourceId/autoDownload 跳下载页。
// 保留 modId 预填查找框（用户手动确认），resourceId/autoDownload 直接忽略。
watch(
    () => (typeof route.query.modId === "string" ? route.query.modId : ""),
    (modId) => {
        if (extractModId(modId)) {
            modLookupInput.value = extractModId(modId);
            void loadModDetail(extractModId(modId));
        }
    },
    { immediate: true },
);

watch(
    () => duplicateDialog.open,
    () => {
        dedupe.onDuplicateDialogClosed();
    },
);

let pendingMetaReload: ReturnType<typeof setTimeout> | null = null;
function scheduleMetaReload(): void {
    if (pendingMetaReload) return;
    pendingMetaReload = setTimeout(async () => {
        pendingMetaReload = null;
        try {
            const before = Object.keys(taskMetaMap.value).length;
            const loaded = await listDownloadMeta();
            // Only apply if changed to avoid noisy warn spam
            const after = Object.keys(loaded).length;
            if (after !== before) {
                console.debug(`[uuid-trace] scheduleMetaReload before=${before} after=${after}`);
            }
            // Detect newly arrived orphan fix? log if any gid still empty
            const orphans = Object.entries(loaded).filter(([, m]) => !(m as { fileName?: string })?.fileName && !(m as { resourceName?: string })?.resourceName);
            if (orphans.length > 0) console.warn(`[uuid-trace] scheduleMetaReload still orphans=${orphans.length} gids=${orphans.map(([gid])=>gid).join(",").slice(0,300)}`);
            taskMetaMap.value = loaded;
        } catch {}
    }, 350);
}

onMounted(() => {
    releaseFacadeSubscribe = facade.subscribe((tasks) => {
        taskList.value = tasks;
        // 下载页任务名回退 uuid 的真因：taskMetaMap 只在页面初始化时 load 一次，
        // 合集批量建任务时后端 download_meta.json 已有 fileName，但前端 map 仍是旧快照，
        // getTaskDisplayName(metaFileName empty) → 误判为孤儿回退 gid/uuid。
        // 这里按 facade 快照增量触发 meta 补全（去抖 350ms，避免每条入队都全量读）。
        const missing = tasks.some((t: TaskProjection) => !taskMetaMap.value[t.gid]);
        if (missing) scheduleMetaReload();
    });
    // 新完成任务自动导入（轮询快照差集，替代原 store 事件）。
    let knownComplete = new Set(
        facade.snapshot().filter((t) => (t as unknown as { status: string }).status === "complete").map((t) => t.gid),
    );
    const releasePoll = facade.subscribe((tasks) => {
        const fresh = tasks.filter((t) => (t as unknown as { status: string }).status === "complete").map((t) => t.gid);
        const added = fresh.filter((gid) => !knownComplete.has(gid));
        knownComplete = new Set(fresh);
        if (added.length > 0) void autoImportCompletedTasks(added, []);
    });
    const previousRelease = releaseFacadeSubscribe;
    releaseFacadeSubscribe = () => {
        previousRelease();
        releasePoll();
    };
    // 页面初始化。
    void initializeDownloadPage();
});

onUnmounted(() => {
    if (pendingMetaReload) { clearTimeout(pendingMetaReload); pendingMetaReload = null; }
    releaseFacadeSubscribe?.();
    releaseFacadeSubscribe = null;
});

</script>
<template>
    <div class="flex flex-col gap-6">
        <Card>
            <CardHeader>
                <div class="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                    <div class="space-y-2">
                        <CardTitle class="flex flex-wrap items-center gap-3">
                            <h1 class="text-2xl">下载中心</h1>
                            <Badge variant="outline" class="rounded-full">
                                内置引擎
                            </Badge>
                        </CardTitle>
                        <CardDescription>
                            总速 {{ formatSpeed(globalStat.downloadSpeed) }} ·
                            进行 {{ globalStat.numActive }} · 等待
                            {{ globalStat.numWaiting }} · 已结束
                            {{ globalStat.numStopped }}
                        </CardDescription>
                    </div>
                    <Button size="sm" @click="openManualDownloadDialog">
                        <IconPlus />
                        新建下载
                    </Button>
                </div>
            </CardHeader>
            <CardContent class="flex flex-col gap-4">
                <div class="flex flex-wrap items-center gap-2">
                    <Button size="sm" @click="openAddModDialog">
                        <IconPlus />
                        添加 Mod
                    </Button>
                    <DropdownMenu>
                        <DropdownMenuTrigger as-child>
                            <Button variant="outline" size="sm">
                                <IconMenu />
                                更多
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" class="w-56">
                            <DropdownMenuItem @click="openDownloaderSettingsDialog">
                                <IconSettings2 />
                                下载设置
                            </DropdownMenuItem>
                            <DropdownMenuItem @click="selectDownloadDirectory">
                                <IconFolderSearch />
                                选择下载目录
                            </DropdownMenuItem>
                            <DropdownMenuItem @click="openDownloadDirectory">
                                <IconFolderOpen />
                                打开目录
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem :disabled="refreshingTasks" @click="refreshTaskLists()">
                                <IconRefreshCw :class="refreshingTasks ? 'animate-spin' : ''" />
                                刷新任务
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>

                <div v-if="tasksErrorMessage"
                    class="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                    {{ tasksErrorMessage }}
                </div>
            </CardContent>
        </Card>

        <Card>
            <CardHeader>
                <CardTitle class="flex flex-wrap items-center justify-between gap-3">
                    <span>下载任务
                        <Badge variant="outline" class="rounded-full ml-4">
                            {{ formatSpeed(globalStat.downloadSpeed) }}
                        </Badge>
                    </span>
                    <div class="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" @click="pauseAllTasks">
                            <IconPause />
                            暂停全部
                        </Button>
                        <Button size="sm" variant="outline" @click="resumeAllTasks">
                            <IconPlay />
                            继续全部
                        </Button>
                        <Button v-if="queueFilter === 'failed'" size="sm" variant="outline"
                            @click="retryAllFailedTasks">
                            <IconRefreshCw />
                            全部重试
                        </Button>
                        <DropdownMenu>
                            <DropdownMenuTrigger as-child>
                                <Button size="sm" variant="outline">
                                    <IconTrash2 />
                                    清理
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" class="w-40">
                                <DropdownMenuItem @click="openPurgeConfirm('downloading')">
                                    清理下载中
                                </DropdownMenuItem>
                                <DropdownMenuItem @click="openPurgeConfirm('stopped')">
                                    清理已完成
                                </DropdownMenuItem>
                                <DropdownMenuItem @click="openPurgeConfirm('failed')">
                                    清理下载失败
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <Button
                            v-if="queueFilter === 'stopped' || queueFilter === 'unimported' || queueFilter === 'all'"
                            size="sm" variant="outline" :disabled="!canImportToLocalManager"
                            @click="importAllCompletedTasks">
                            <IconFileUp />
                            批量导入全部
                        </Button>
                        <Button
                            v-if="queueFilter === 'stopped' || queueFilter === 'imported' || queueFilter === 'unimported' || queueFilter === 'all'"
                            size="sm" variant="outline" :disabled="!canImportToLocalManager"
                            @click="refreshImportStatusView">
                            <IconRefreshCw />
                            刷新导入状态
                        </Button>
                    </div>
                    <!-- 批量导入进度：分片 batch 按片推进（20个一片），后端单次 invoke 无更细粒度 -->
                    <div v-if="importState.batchProgress.value.running || importState.batchProgress.value.done > 0" class="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                        <span class="shrink-0">导入 {{ importState.batchProgress.value.done }}/{{ importState.batchProgress.value.total }}</span>
                        <div class="h-1.5 min-w-24 flex-1 overflow-hidden rounded-full bg-muted">
                            <div class="h-full rounded-full bg-primary transition-all" :style="{ width: `${importState.batchProgress.value.total > 0 ? Math.round((importState.batchProgress.value.done / importState.batchProgress.value.total) * 100) : 0}%` }" />
                        </div>
                    </div>
                </CardTitle>
            </CardHeader>
            <CardContent class="flex flex-col gap-4">
                <div class="flex flex-wrap gap-2">
                    <Button v-for="item in queueFilterOptions" :key="item.value" size="sm" :variant="queueFilter === item.value ? 'default' : 'outline'
                        " @click="queueFilter = item.value">
                        {{ item.label }}
                        <span class="text-xs opacity-70">{{ item.count }}</span>
                    </Button>
                </div>

                <div v-if="filteredTasks.length"
                    class="flex flex-col gap-3 rounded-xl border px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
                    <div class="text-sm text-muted-foreground">
                        {{ visibleTaskRangeLabel }}，已按添加时间倒序排列。
                    </div>

                    <div class="flex flex-wrap items-center gap-2">
                        <span class="text-sm text-muted-foreground">每页数量</span>
                        <Select v-model="taskPageSize">
                            <SelectTrigger class="w-[140px]">
                                <SelectValue placeholder="选择每页数量" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem v-for="item in TASK_PAGE_SIZE_OPTIONS" :key="item" :value="item">
                                    每页 {{ item }} 条
                                </SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </div>

                <div v-if="!filteredTasks.length" class="rounded-xl border border-dashed px-6 py-12 text-center">
                    <div class="text-base font-medium">当前没有任务</div>
                    <p class="mt-2 text-sm leading-6 text-muted-foreground">
                        点顶部“新建下载”粘贴直链，或通过“添加
                        Mod”从 3DM 资源建任务，这里会实时显示进度。
                    </p>
                </div>

                <div v-else class="space-y-3">
                    <ContextMenu v-for="task in paginatedTasks" :key="task.gid">
                        <ContextMenuTrigger as-child>
                            <article
                                class="cursor-pointer rounded-xl border px-4 py-4 transition-colors hover:border-primary/40"
                                :class="selectedTaskGid === task.gid ? 'border-primary/50 bg-primary/5' : ''"
                                @click="openTaskDetail(task)">
                                <div class="flex gap-3 flex-row items-center justify-between">
                                    <div class="min-w-0 flex-1 space-y-2">
                                        <div class="flex flex-wrap items-center gap-2">
                                            <div v-if="taskMetaMap[task.gid]?.modTitle"
                                                class="truncate text-sm font-medium">
                                                {{ taskMetaMap[task.gid]?.modTitle }}
                                            </div>
                                            <Badge class="rounded-full" :class="getTaskStatusClass(task.status)"
                                                variant="outline">
                                                {{ getTaskStatusLabel(task.status) }}
                                            </Badge>
                                            <Badge class="rounded-full" variant="outline">
                                                {{ getTaskDisplayName(task) }}
                                            </Badge>
                                            <!-- <Badge v-if="taskMetaMap[task.gid]?.localModId" class="rounded-full"
                                        variant="secondary">
                                        已导入本地
                                    </Badge> -->
                                        </div>

                                        <div class="h-2 overflow-hidden rounded-full bg-muted">
                                            <div class="h-full rounded-full bg-primary transition-all" :style="{
                                                width: `${getTaskProgress(task)}%`,
                                            }"></div>
                                        </div>

                                        <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                                            <span>{{ formatBytes(task.completedLength) }}
                                                /
                                                {{
                                                    formatBytes(task.totalLength)
                                                }}</span>
                                            <span>速度：{{
                                                formatSpeed(task.downloadSpeed)
                                                }}</span>
                                            <span>分片：{{
                                                normalizedDownloaderSettings.split
                                                }}</span>
                                            <span v-if="task.errorMessage">错误：{{ task.errorMessage }}</span>
                                        </div>
                                    </div>

                                    <div class="flex flex-wrap gap-2" @click.stop>
                                        <Button v-if="task.status === 'complete'" size="sm" variant="outline" :disabled="!canImportToLocalManager ||
                                            isTaskImporting(task.gid)
                                            " @click="importTaskToLocalManager(task)">
                                            <IconFileUp />
                                            {{
                                                isTaskImporting(task.gid)
                                                    ? "导入中"
                                                    : taskMetaMap[task.gid]?.localModId
                                                        ? "重新导入"
                                                        : "一键导入"
                                            }}
                                        </Button>
                                        <Button v-if="task.status === 'complete'" size="sm" variant="outline"
                                            :disabled="isTaskOperating(task.gid)" @click="retryTask(task)">
                                            <IconRefreshCw />
                                            重新下载
                                        </Button>
                                        <Button v-if="task.status === 'error'" size="sm" variant="outline"
                                            :disabled="isTaskOperating(task.gid)" @click="retryTask(task)">
                                            <IconRefreshCw />
                                            重试
                                        </Button>
                                        <Button v-if="
                                            task.status === 'active' ||
                                            task.status === 'waiting'
                                        " size="sm" variant="outline" :disabled="isTaskOperating(task.gid)"
                                            @click="pauseTask(task)">
                                            <IconPause />
                                            暂停
                                        </Button>
                                        <Button v-else-if="task.status === 'paused'" size="sm" variant="outline"
                                            :disabled="isTaskOperating(task.gid)" @click="resumeTask(task)">
                                            <IconPlay />
                                            继续
                                        </Button>
                                        <Button size="sm" variant="outline" :disabled="isTaskOperating(task.gid)"
                                            @click="removeTask(task)">
                                            <IconTrash2 />
                                            删除
                                        </Button>
                                    </div>
                                </div>
                            </article>
                        </ContextMenuTrigger>
                        <ContextMenuContent class="w-48">
                            <ContextMenuItem @select="openTaskDetail(task)">
                                <IconEye class="mr-2 h-4 w-4" />查看详情
                            </ContextMenuItem>
                            <ContextMenuItem v-if="task.status === 'active' || task.status === 'waiting'"
                                :disabled="isTaskOperating(task.gid)" @select="pauseTask(task)">
                                <IconPause class="mr-2 h-4 w-4" />暂停
                            </ContextMenuItem>
                            <ContextMenuItem v-else-if="task.status === 'paused'" :disabled="isTaskOperating(task.gid)"
                                @select="resumeTask(task)">
                                <IconPlay class="mr-2 h-4 w-4" />继续
                            </ContextMenuItem>
                            <ContextMenuItem v-if="task.status === 'complete'" :disabled="isTaskOperating(task.gid)"
                                @select="retryTask(task)">
                                <IconRefreshCw class="mr-2 h-4 w-4" />重新下载
                            </ContextMenuItem>
                            <ContextMenuItem v-if="task.status === 'error'" :disabled="isTaskOperating(task.gid)"
                                @select="retryTask(task)">
                                <IconRefreshCw class="mr-2 h-4 w-4" />重试
                            </ContextMenuItem>
                            <ContextMenuItem v-if="task.status === 'complete'"
                                :disabled="!canImportToLocalManager || isTaskImporting(task.gid)"
                                @select="importTaskToLocalManager(task)">
                                <IconFileUp class="mr-2 h-4 w-4" />一键导入
                            </ContextMenuItem>
                            <ContextMenuItem @select="openTaskFileLocation(task)">
                                <IconFolderOpen class="mr-2 h-4 w-4" />打开文件位置
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem variant="destructive" :disabled="isTaskOperating(task.gid)"
                                @select="removeTask(task)">
                                <IconTrash2 class="mr-2 h-4 w-4" />删除
                            </ContextMenuItem>
                        </ContextMenuContent>
                    </ContextMenu>
                    <div v-if="taskTotalPages > 1"
                        class="flex flex-col gap-4 rounded-xl border px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
                        <div class="text-sm text-muted-foreground">
                            当前第 {{ taskPage }} 页，共
                            {{ taskTotalPages }} 页， 累计
                            {{ filteredTaskCount }} 条任务。
                        </div>

                        <div class="flex flex-wrap items-center gap-2">
                            <Button size="sm" variant="outline" :disabled="taskPage <= 1"
                                @click="goToTaskPage(taskPage - 1)">
                                <IconChevronLeft />
                                上一页
                            </Button>

                            <template v-for="item in taskPaginationItems" :key="item.key">
                                <span v-if="item.ellipsis" class="px-2 text-sm text-muted-foreground">
                                    {{ item.label }}
                                </span>
                                <Button v-else size="sm" :variant="item.page === taskPage
                                        ? 'default'
                                        : 'outline'
                                    " @click="goToTaskPage(item.page ?? 1)">
                                    {{ item.label }}
                                </Button>
                            </template>

                            <Button size="sm" variant="outline" :disabled="taskPage >= taskTotalPages"
                                @click="goToTaskPage(taskPage + 1)">
                                下一页
                                <IconChevronRight />
                            </Button>

                        </div>
                    </div>
                </div>
            </CardContent>
        </Card>
        <Dialog v-model:open="showAddModDialog" modal>
            <DialogScrollContent class="sm:max-w-6xl">
                <DialogHeader>
                    <DialogTitle>添加 Mod</DialogTitle>
                    <DialogDescription>
                        输入 3DM Mod ID
                        或详情链接后，直接在弹窗里查看详情并添加到下载队列。
                    </DialogDescription>
                </DialogHeader>

                <div class="flex gap-2">
                    <Input v-model="modLookupInput" placeholder="例如：252329 或 https://mod.3dmgame.com/mod/252329"
                        @keydown.enter="loadModDetail()" />
                    <Button :disabled="modLookupLoading" @click="loadModDetail()">
                        <IconSearch />
                        读取详情
                    </Button>
                </div>

                <div v-if="modLookupError"
                    class="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive">
                    {{ modLookupError }}
                </div>

                <div v-if="modLookupLoading" class="space-y-3 rounded-xl border p-4">
                    <div class="aspect-video animate-pulse rounded-xl bg-muted"></div>
                    <div class="h-6 w-2/3 animate-pulse rounded bg-muted"></div>
                    <div class="h-4 w-full animate-pulse rounded bg-muted"></div>
                    <div class="h-4 w-5/6 animate-pulse rounded bg-muted"></div>
                </div>

                <div v-else-if="!selectedMod"
                    class="flex min-h-80 flex-col items-center justify-center rounded-xl border border-dashed px-6 py-12 text-center">
                    <IconDownload class="size-8 text-muted-foreground" />
                    <div class="mt-3 text-base font-medium">
                        等待载入 Mod 详情
                    </div>
                    <p class="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                        读取成功后，这里会显示 Mod 简介、资源列表和下载按钮。
                    </p>
                </div>

                <div v-else class="grid gap-6 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
                    <div class="space-y-4">
                        <div class="overflow-hidden rounded-xl border">
                            <img :src="resolveGlossAssetUrl(
                                selectedMod.mods_image_url,
                            )
                                " :alt="selectedMod.mods_title" class="aspect-video w-full object-cover" @error="
                                    (event) =>
                                    ((
                                        event.target as HTMLImageElement
                                    ).src = EMPTY_POSTER)
                                " />
                        </div>

                        <div class="space-y-3 rounded-xl border px-4 py-4">
                            <div>
                                <h2 class="text-xl font-semibold leading-8">
                                    {{ selectedMod.mods_title }}
                                </h2>
                                <p class="mt-1 text-sm text-muted-foreground">
                                    {{ selectedMod.game_name }} ·
                                    {{
                                        (
                                            selectedMod.mods_type_name || ""
                                        ).trim() || "未分类"
                                    }}
                                </p>
                            </div>

                            <div class="flex flex-wrap gap-2">
                                <Badge class="rounded-full" variant="outline">
                                    作者：{{
                                        selectedMod.user_nickName ||
                                        selectedMod.mods_author ||
                                        "未知"
                                    }}
                                </Badge>
                                <Badge class="rounded-full" variant="outline">
                                    版本：{{
                                        selectedMod.mods_version || "未知"
                                    }}
                                </Badge>
                                <Badge class="rounded-full" variant="outline">
                                    更新时间：{{
                                        formatDate(selectedMod.mods_updateTime)
                                    }}
                                </Badge>
                                <Badge v-if="selectedMod.support_gmm" class="rounded-full" variant="secondary">
                                    支持 GMM
                                </Badge>
                            </div>

                            <div class="grid grid-cols-3 gap-2 text-center text-xs sm:gap-3">
                                <div class="rounded-xl bg-muted/40 px-3 py-3">
                                    <div class="text-muted-foreground">
                                        下载
                                    </div>
                                    <div class="mt-1 text-base font-semibold">
                                        {{
                                            formatNumber(
                                                selectedMod.mods_download_cnt,
                                            )
                                        }}
                                    </div>
                                </div>
                                <div class="rounded-xl bg-muted/40 px-3 py-3">
                                    <div class="text-muted-foreground">
                                        浏览
                                    </div>
                                    <div class="mt-1 text-base font-semibold">
                                        {{
                                            formatNumber(
                                                selectedMod.mods_click_cnt,
                                            )
                                        }}
                                    </div>
                                </div>
                                <div class="rounded-xl bg-muted/40 px-3 py-3">
                                    <div class="text-muted-foreground">
                                        收藏
                                    </div>
                                    <div class="mt-1 text-base font-semibold">
                                        {{
                                            formatNumber(
                                                selectedMod.mods_mark_cnt,
                                            )
                                        }}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="space-y-4">
                        <div class="rounded-xl border px-4 py-4 text-sm leading-7 text-muted-foreground">
                            <p v-if="selectedMod.mods_desc" class="whitespace-pre-wrap">
                                {{ selectedMod.mods_desc }}
                            </p>
                            <div v-if="detailParagraphs.length" class="mt-3 space-y-2">
                                <p v-for="(item, index) in detailParagraphs"
                                    :key="`${selectedMod.id}-paragraph-${index}`"
                                    class="rounded-lg bg-muted/35 px-3 py-2 text-foreground">
                                    {{ item }}
                                </p>
                            </div>
                        </div>

                        <div class="space-y-3">
                            <div class="flex items-center justify-between">
                                <div class="text-sm font-medium">资源列表</div>
                                <div class="text-xs text-muted-foreground">
                                    共
                                    {{ selectedMod.mods_resource.length }}
                                    个资源
                                </div>
                            </div>

                            <div class="max-h-[48vh] space-y-3 overflow-y-auto pr-1">
                                <div v-for="resource in selectedMod.mods_resource"
                                    :key="`${selectedMod.id}-${resource.id}`">
                                    <ContextMenu>
                                        <ContextMenuTrigger as-child>
                                            <div class="rounded-xl border px-4 py-4">
                                                <div
                                                    class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                                                    <div class="space-y-2">
                                                        <div class="flex flex-wrap items-center gap-2">
                                                            <div class="text-sm font-medium">
                                                                {{
                                                                    resource.mods_resource_name
                                                                }}
                                                            </div>
                                                            <Badge v-if="
                                                                resource.mods_resource_latest_version
                                                            " class="rounded-full" variant="secondary">
                                                                最新
                                                            </Badge>
                                                        </div>
                                                        <div class="flex flex-wrap gap-2 text-xs text-muted-foreground">
                                                            <span>大小：{{
                                                                resource.mods_resource_size ||
                                                                "未知"
                                                                }}</span>
                                                            <span>·</span>
                                                            <span>版本：{{
                                                                resource.mods_resource_version ||
                                                                selectedMod.mods_version ||
                                                                "未知"
                                                                }}</span>
                                                            <span v-if="
                                                                resource.mods_resource_formart
                                                            ">·</span>
                                                            <span v-if="
                                                                resource.mods_resource_formart
                                                            ">格式：{{
                                                        resource.mods_resource_formart
                                                                }}</span>
                                                        </div>
                                                        <div v-if="
                                                            getResourcePresence(
                                                                resource,
                                                            ).state !== 'none'
                                                        " class="flex flex-wrap gap-2 text-xs">
                                                            <Badge class="rounded-full" variant="outline">
                                                                {{
                                                                    getResourcePresence(
                                                                        resource,
                                                                    ).label
                                                                }}
                                                            </Badge>
                                                            <Badge v-if="
                                                                getResourcePresence(
                                                                    resource,
                                                                ).localCount > 0
                                                            " class="rounded-full" variant="secondary">
                                                                已在本地管理器
                                                            </Badge>
                                                        </div>
                                                        <p v-if="
                                                            resource.mods_resource_desc
                                                        " class="text-sm text-muted-foreground">
                                                            {{
                                                                resource.mods_resource_desc
                                                            }}
                                                        </p>
                                                    </div>

                                                    <Button size="sm" :disabled="addingResourceKey ===
                                                        `${selectedMod.id}-${resource.id ?? resource.mods_resource_name}`
                                                        " @click="addResourceTask(resource)">
                                                        <IconPlus />
                                                        {{
                                                            addingResourceKey ===
                                                                `${selectedMod.id}-${resource.id ??
                                                                resource.mods_resource_name
                                                                }`
                                                                ? "添加中"
                                                                : getResourceActionLabel(
                                                                    resource,
                                                                )
                                                        }}
                                                    </Button>
                                                </div>
                                            </div>
                                        </ContextMenuTrigger>
                                        <ContextMenuContent class="w-48">
                                            <ContextMenuItem :disabled="isResourceAdding(resource)"
                                                @select="addResourceTask(resource)">
                                                <IconDownload class="mr-2 h-4 w-4" />下载该资源
                                            </ContextMenuItem>
                                            <ContextMenuItem @select="openModResourcePage(selectedMod.id)">
                                                <IconExternalLink class="mr-2 h-4 w-4" />在网页打开 Mod
                                            </ContextMenuItem>
                                        </ContextMenuContent>
                                    </ContextMenu>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </DialogScrollContent>
        </Dialog>

        <Dialog v-model:open="showManualDownloadDialog" modal>
            <DialogContent class="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>新建下载</DialogTitle>
                    <DialogDescription>
                        粘贴直链即建任务；文件名留空时从服务器探测补全。
                    </DialogDescription>
                </DialogHeader>

                <div class="grid gap-4">
                    <div class="grid gap-2">
                        <Label for="manual-download-url">下载链接</Label>
                        <Input id="manual-download-url" v-model="manualDownloadUrl" placeholder="https://…" />
                    </div>
                    <div class="grid gap-2">
                        <Label for="manual-download-name">文件名（可选）</Label>
                        <Input id="manual-download-name" v-model="manualDownloadFileName" placeholder="留空则从服务器探测" />
                    </div>
                </div>

                <DialogFooter>
                    <Button variant="outline" @click="showManualDownloadDialog = false">
                        取消
                    </Button>
                    <Button :disabled="manualDownloadCreating" @click="createManualDownloadTask">
                        {{ manualDownloadCreating ? "添加中" : "开始下载" }}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>

        <Dialog v-model:open="showDownloaderSettingsDialog" modal>
            <DialogContent class="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>下载设置</DialogTitle>
                    <DialogDescription>
                        内置引擎常驻进程内，无需连接服务；保存后对后续新建任务生效。并发上限固定为
                        5。
                    </DialogDescription>
                </DialogHeader>

                <div class="grid gap-4 sm:grid-cols-2">
                    <div class="grid gap-2">
                        <Label for="download-split">单任务分片数</Label>
                        <Input id="download-split" v-model.number="downloaderSettingsDraft.split" type="number"
                            min="1" />
                    </div>

                    <div class="grid gap-2">
                        <Label for="download-max-connection">单服务器连接数</Label>
                        <Input id="download-max-connection" v-model.number="downloaderSettingsDraft.maxConnectionPerServer
                            " type="number" min="1" />
                    </div>

                    <div class="grid gap-2">
                        <Label for="download-min-split-size">最小分片大小</Label>
                        <Input id="download-min-split-size" v-model="downloaderSettingsDraft.minSplitSize"
                            placeholder="例如 1M" />
                    </div>

                    <div class="grid gap-2 sm:col-span-2">
                        <Label for="download-download-proxy">下载代理</Label>
                        <Input id="download-download-proxy" v-model="downloadProxyDraft"
                            placeholder="例如 http://127.0.0.1:7890，可留空" />
                    </div>
                </div>

                <DialogFooter>
                    <Button variant="outline" @click="showDownloaderSettingsDialog = false">
                        取消
                    </Button>
                    <Button @click="saveDownloaderSettings"> 保存 </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>

        <Dialog v-model:open="duplicateDialog.open" modal>
            <DialogContent class="sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>{{ duplicateDialog.title }}</DialogTitle>
                    <DialogDescription>
                        {{ duplicateDialog.description }}
                    </DialogDescription>
                </DialogHeader>

                <div class="space-y-4">
                    <div v-if="duplicateDialog.note"
                        class="rounded-xl border border-border/70 bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
                        {{ duplicateDialog.note }}
                    </div>

                    <div class="max-h-[40vh] space-y-3 overflow-y-auto pr-1">
                        <div v-for="(item, index) in duplicateDialog.items" :key="`${duplicateDialog.title}-${index}`"
                            class="rounded-xl border px-4 py-3">
                            <div class="flex flex-wrap items-center gap-2">
                                <div class="text-sm font-medium">
                                    {{ item.title }}
                                </div>
                                <Badge v-for="badge in item.badges" :key="`${item.title}-${badge}`" class="rounded-full"
                                    variant="outline">
                                    {{ badge }}
                                </Badge>
                            </div>
                            <p class="mt-2 text-sm leading-6 text-muted-foreground">
                                {{ item.description }}
                            </p>
                        </div>
                    </div>

                    <div class="grid gap-2 sm:grid-cols-2">
                        <Button v-for="option in duplicateDialog.options" :key="option.value"
                            :variant="option.variant ?? 'default'"
                            class="h-auto items-start justify-start px-4 py-3 text-left"
                            @click="resolveDuplicateDialog(option.value)">
                            <div>
                                <div class="text-sm font-medium">
                                    {{ option.label }}
                                </div>
                                <div class="mt-1 text-xs text-muted-foreground">
                                    {{ option.description }}
                                </div>
                            </div>
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>

        <Dialog v-model:open="showTaskDetailDialog" modal>
            <DialogScrollContent class="sm:max-w-5xl">
                <DialogHeader>
                    <DialogTitle>任务详情</DialogTitle>
                    <DialogDescription>
                        查看当前任务的进度、文件和关联 Mod 信息。
                    </DialogDescription>
                </DialogHeader>

                <div v-if="selectedTask" class="grid gap-6 lg:grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)]">
                    <div class="space-y-4">
                        <div class="overflow-hidden rounded-xl border bg-muted/30">
                            <img :src="selectedTaskMeta?.cover || EMPTY_POSTER" :alt="getTaskDisplayName(selectedTask)"
                                class="aspect-video w-full object-cover" @error="
                                    (event) =>
                                    ((
                                        event.target as HTMLImageElement
                                    ).src = EMPTY_POSTER)
                                " />
                        </div>

                        <div class="space-y-3 rounded-xl border px-4 py-4">
                            <div class="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                    <div class="text-lg font-semibold leading-7">
                                        {{ getTaskDisplayName(selectedTask) }}
                                    </div>
                                    <div class="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                                        <span>GID：{{ selectedTask.gid }}</span>
                                        <span>·</span>
                                        <span>{{
                                            getTaskStatusLabel(
                                                selectedTask.status,
                                            )
                                        }}</span>
                                    </div>
                                </div>
                                <Badge class="rounded-full" :class="getTaskStatusClass(selectedTask.status)
                                    " variant="outline">
                                    {{
                                        getTaskStatusLabel(selectedTask.status)
                                    }}
                                </Badge>
                            </div>

                            <div class="grid grid-cols-2 gap-3 text-center text-xs">
                                <div class="rounded-xl bg-muted/40 px-3 py-3">
                                    <div class="text-muted-foreground">
                                        进度
                                    </div>
                                    <div class="mt-1 text-base font-semibold">
                                        {{ getTaskProgress(selectedTask) }}%
                                    </div>
                                </div>
                                <div class="rounded-xl bg-muted/40 px-3 py-3">
                                    <div class="text-muted-foreground">
                                        速度
                                    </div>
                                    <div class="mt-1 text-base font-semibold">
                                        {{
                                            formatSpeed(
                                                selectedTask.downloadSpeed,
                                            )
                                        }}
                                    </div>
                                </div>
                                <div class="rounded-xl bg-muted/40 px-3 py-3">
                                    <div class="text-muted-foreground">
                                        已下载
                                    </div>
                                    <div class="mt-1 text-base font-semibold">
                                        {{
                                            formatBytes(
                                                selectedTask.completedLength,
                                            )
                                        }}
                                    </div>
                                </div>
                                <div class="rounded-xl bg-muted/40 px-3 py-3">
                                    <div class="text-muted-foreground">
                                        总大小
                                    </div>
                                    <div class="mt-1 text-base font-semibold">
                                        {{
                                            formatBytes(
                                                selectedTask.totalLength,
                                            )
                                        }}
                                    </div>
                                </div>
                            </div>

                            <div class="flex flex-wrap gap-2">
                                <Button size="sm" variant="outline" @click="openTaskFolder(selectedTask)">
                                    <IconFolderOpen />
                                    打开目录
                                </Button>
                                <Button v-if="selectedTask.status === 'complete'" size="sm" variant="outline" :disabled="isTaskOperating(selectedTask.gid)
                                    " @click="retryTask(selectedTask)">
                                    <IconRefreshCw />
                                    重新下载
                                </Button>
                                <Button v-if="selectedTask.status === 'error'" size="sm" variant="outline" :disabled="isTaskOperating(selectedTask.gid)
                                    " @click="retryTask(selectedTask)">
                                    <IconRefreshCw />
                                    重试下载
                                </Button>
                                <Button size="sm" variant="outline" :disabled="selectedTask.status !== 'complete'
                                    " @click="openTaskFile(selectedTask)">
                                    <IconFileUp />
                                    打开文件
                                </Button>
                                <Button size="sm" variant="outline" :disabled="selectedTask.status !== 'complete' ||
                                    !canImportToLocalManager ||
                                    isTaskImporting(selectedTask.gid)
                                    " @click="
                                        importTaskToLocalManager(selectedTask)
                                        ">
                                    <IconFileUp />
                                    {{
                                        isTaskImporting(selectedTask.gid)
                                            ? "导入中"
                                            : selectedTaskMeta?.localModId
                                                ? "重新导入本地"
                                                : "导入到本地管理器"
                                    }}
                                </Button>
                                <Button v-if="
                                    selectedTaskMeta?.sourceType ===
                                    'GlossMod' &&
                                    selectedTaskMeta?.modId
                                " size="sm" variant="outline" @click="loadRelatedModDetail(selectedTask)">
                                    <IconPanelRightOpen />
                                    查看关联 Mod
                                </Button>
                            </div>

                            <div v-if="selectedTask.errorMessage"
                                class="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                                {{ selectedTask.errorMessage }}
                            </div>
                        </div>
                    </div>

                    <div class="space-y-4">
                        <div class="rounded-xl border px-4 py-3 text-sm">
                            <div class="text-xs text-muted-foreground">
                                保存目录
                            </div>
                            <div class="mt-1 break-all leading-6">
                                {{ selectedTask.dir || "未知目录" }}
                            </div>
                        </div>

                        <div v-if="selectedTaskMeta" class="rounded-xl border px-4 py-3 text-sm">
                            <div class="text-xs text-muted-foreground">
                                关联 Mod
                            </div>
                            <div class="mt-1 font-medium">
                                {{ selectedTaskMeta.modTitle || "未知 Mod" }}
                            </div>
                            <div class="mt-1 text-xs text-muted-foreground leading-6">
                                {{ selectedTaskMeta.gameName || "未记录游戏" }}
                                <span v-if="selectedTaskMeta.version">· 版本 {{ selectedTaskMeta.version }}</span>
                                <span v-if="selectedTaskMeta.localModId">· 已导入本地 #{{
                                    selectedTaskMeta.localModId
                                }}</span>
                            </div>
                            <p v-if="selectedTaskMeta.content" class="mt-3 line-clamp-6 text-sm text-muted-foreground">
                                {{ selectedTaskMeta.content }}
                            </p>
                        </div>

                        <div class="space-y-3">
                            <div class="text-sm font-medium">文件列表</div>
                            <div class="max-h-[48vh] space-y-2 overflow-y-auto pr-1">
                                <div v-for="(file, index) in selectedTask.files" :key="`${selectedTask.gid}-${index}`"
                                    class="rounded-xl border px-3 py-3 text-sm">
                                    <div class="font-medium">
                                        {{
                                            getBaseName(file.path) ||
                                            `文件 ${index + 1}`
                                        }}
                                    </div>
                                    <div class="mt-1 text-xs text-muted-foreground">
                                        {{ formatBytes(file.completedLength) }}
                                        / {{ formatBytes(file.length) }}
                                    </div>
                                    <div class="mt-2 break-all text-xs text-muted-foreground">
                                        {{ file.path || "暂无文件路径" }}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div v-else
                    class="flex min-h-80 flex-col items-center justify-center rounded-xl border border-dashed px-6 py-12 text-center">
                    <IconListChecks class="size-8 text-muted-foreground" />
                    <div class="mt-3 text-base font-medium">先选择一个任务</div>
                    <p class="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                        关闭弹窗后从下载列表重新点开任务即可查看详情。
                    </p>
                </div>
            </DialogScrollContent>
        </Dialog>

        <Dialog v-model:open="showPurgeConfirmDialog" modal>
            <DialogContent class="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>清理{{ purgeTargetLabel }}</DialogTitle>
                    <DialogDescription>
                        将清理 {{ purgeTargetCount }} 条{{ purgeTargetLabel }}任务记录{{ purgeTarget === "downloading" ? "（先取消下载再清记录）" : "" }}。默认只清记录、保留本地文件。
                    </DialogDescription>
                </DialogHeader>

                <div class="flex items-center justify-between gap-3 rounded-xl border px-4 py-3">
                    <div class="text-sm">
                        <div class="font-medium">同时删除本地文件</div>
                        <div class="text-xs text-muted-foreground">含未下完的断点文件（.download.bitcode），操作不可撤销。</div>
                    </div>
                    <Switch v-model="purgeDeleteFile" />
                </div>

                <DialogFooter>
                    <Button variant="outline" @click="showPurgeConfirmDialog = false">
                        取消
                    </Button>
                    <Button variant="destructive" @click="confirmPurgeTasks">
                        确认清理
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    </div>
</template>
<style scoped></style>
