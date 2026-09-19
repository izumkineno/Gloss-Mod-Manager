<script setup lang="ts">
// Collection 待下载清单独立页：从下载页搬移，只做清单管理（全局暂停/继续仍在下载页）。
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { getTaskProgress, getTaskSpeedText } from "@/lib/download-task-ui";
import { storeToRefs } from "pinia";
import { useDownloadTasksStore } from "@/stores/download-tasks";
import { ElMessage } from "element-plus-message";
import { Downloader } from "@/lib/native-downloader";
import type { IDownloaderTask } from "@/lib/download-task-types";
import {
    clearFinishedCollectionPending,
    listCollectionPending,
    removeCollectionPending,
    type INexusCollectionPending,
    type INexusCollectionPendingItem,
} from "@/lib/nexus-collection-pending";
import { queueThirdPartyModDownload } from "@/lib/third-party-download-queue";
import { buildMinimalNexusModDetail } from "@/lib/third-party-mod-api";
import { useManager } from "@/stores/manager";
import { useSettings } from "@/stores/settings";

// 任务状态走 Pinia store（下载页 + collection 页共享同一份快照/订阅，禁止页级缓存）。
const downloadTasksStore = useDownloadTasksStore();
const { allTasks, taskMetaMap } = storeToRefs(downloadTasksStore);
const { refreshTaskSnapshot } = downloadTasksStore;
let releaseCollectionTaskEvents: (() => void) | null = null;

// 清单列表/加载态/展开态。
const collectionPendingList = ref<INexusCollectionPending[]>([]);
const collectionPendingLoading = ref(false);
const expandedPendingIds = ref<string[]>([]);
// 过滤器：all/undownloaded/pending/queued/failed/done（done = 任务完成或已安装）。
const collectionFilter = ref<CollectionFilter>("all");
watch(collectionFilter, () => {
    collectionPage.value = 1;
    collectionItemPages.value = {};
});

// 外层分页：collection 条目（每页 10 条）；内层分页：展开的文件明细（每页 20 条）。
interface IPageItem {
    key: string;
    label: string;
    page?: number;
    ellipsis?: boolean;
}
const COLLECTION_PAGE_SIZE = 10;
const COLLECTION_ITEM_PAGE_SIZE = 20;
const collectionPage = ref(1);
const collectionItemPages = ref<Record<string, number>>({});
// 重试进度：按条目 id 记录 { done, total, cancelled }，循环每建完一个 +1；取消即停。
const retryProgressMap = ref<Record<string, { done: number; total: number; cancelled: boolean }>>({});
function getRetryProgress(entryId: string) {
    return retryProgressMap.value[entryId] ?? null;
}
function cancelRetryEntry(entryId: string) {
    const prog = retryProgressMap.value[entryId];
    if (prog) prog.cancelled = true;
}
// 本地 mod 列表 + 设置（状态识别/建任务用）。
const manager = useManager();
const settings = useSettings();
// 刷新清单。
async function refreshCollectionPending() {
    collectionPendingLoading.value = true;
    try {
        collectionPendingList.value = await listCollectionPending();
        // 条目增删后夹紧外层页码，避免停在空页。
        const total = Math.max(1, Math.ceil(collectionPendingList.value.length / COLLECTION_PAGE_SIZE));
        if (collectionPage.value > total) collectionPage.value = total;
        // 对账：任务已完成/本地已装的行，其历史 reason 已过期，自动清除。
        await reconcileStaleReasons();
    } finally {
        collectionPendingLoading.value = false;
    }
}

// reason 是上次失败的快照；任务终态已完成或已安装时 reason 必过期，直接清掉。
async function reconcileStaleReasons() {
    const { updateCollectionPendingItem } = await import("@/lib/nexus-collection-pending");
    let changed = false;
    for (const entry of collectionPendingList.value) {
        for (const item of entry.items) {
            if (!item.reason) continue;
            if (getPendingTaskStatus(item) === "complete" || isPendingItemInstalled(item)) {
                await updateCollectionPendingItem(entry.id, item.modId, item.fileId, "queued", undefined);
                item.status = "queued";
                item.reason = undefined;
                changed = true;
            }
        }
    }
    if (changed) collectionPendingList.value = await listCollectionPending();
}


function togglePendingExpanded(id: string) {
    expandedPendingIds.value = expandedPendingIds.value.includes(id)
        ? expandedPendingIds.value.filter((item) => item !== id)
        : [...expandedPendingIds.value, id];
}

// 条目汇总进度：已完成（任务 complete/已安装）走实线，下载中（active/waiting/paused）走虚线。
function pendingProgress(entry: INexusCollectionPending): { done: number; downloading: number } {
    if (entry.items.length === 0) return { done: 0, downloading: 0 };
    const isDone = (item: INexusCollectionPendingItem) =>
        isPendingItemInstalled(item) || getPendingTaskStatus(item) === "complete";
    const isDownloading = (item: INexusCollectionPendingItem) =>
        !isDone(item) && ["active", "waiting", "paused"].includes(getPendingTaskStatus(item) ?? "");
    const pct = (n: number) => Math.round((n / entry.items.length) * 100);
    return { done: pct(entry.items.filter(isDone).length), downloading: pct(entry.items.filter(isDownloading).length) };
}
const filteredCollections = computed(() => {
    if (collectionFilter.value === "all") return collectionPendingList.value;
    if (collectionFilter.value === "undownloaded") {
        return collectionPendingList.value.filter((entry) => entry.items.some(isItemUndownloaded));
    }
    return collectionPendingList.value.filter((entry) => {
        if (getEntryFilterState(entry) === collectionFilter.value) return true;
        return entry.items.some((item) => getItemFilterState(item) === collectionFilter.value);
    });
});
// 明细行再过滤：只显示命中过滤器的文件。
const filteredItemsOf = (entry: INexusCollectionPending): INexusCollectionPendingItem[] => {
    if (collectionFilter.value === "all") return entry.items;
    if (collectionFilter.value === "undownloaded") return entry.items.filter(isItemUndownloaded);
    return entry.items.filter((item) => getItemFilterState(item) === collectionFilter.value);
};
const collectionTotalPages = computed(() =>
    Math.ceil(filteredCollections.value.length / COLLECTION_PAGE_SIZE),
);
const paginatedCollections = computed(() => {
    const start = (collectionPage.value - 1) * COLLECTION_PAGE_SIZE;
    return filteredCollections.value.slice(start, start + COLLECTION_PAGE_SIZE);
});
function buildPageItems(current: number, total: number): IPageItem[] {
    const pages = new Set<number>([1, total, current - 1, current, current + 1]);
    if (current <= 3) pages.add(2), pages.add(3), pages.add(4);
    if (current >= total - 2) pages.add(total - 1), pages.add(total - 2), pages.add(total - 3);
    const sorted = [...pages].filter((v) => v >= 1 && v <= total).sort((a, b) => a - b);
    const items: IPageItem[] = [];
    let prev = 0;
    for (const v of sorted) {
        if (v - prev > 1) items.push({ key: `ellipsis-${prev}-${v}`, label: "...", ellipsis: true });
        items.push({ key: `page-${v}`, label: String(v), page: v });
        prev = v;
    }
    return items;
}
const collectionPageItems = computed(() => buildPageItems(collectionPage.value, collectionTotalPages.value));
function goToCollectionPage(page: number) {
    collectionPage.value = Math.min(Math.max(1, page), Math.max(1, collectionTotalPages.value));
}
// 明细分页：按条目 id 独立页码。
function getItemPage(entryId: string): number {
    return collectionItemPages.value[entryId] ?? 1;
}
function getItemTotalPages(entry: INexusCollectionPending): number {
    return Math.ceil(filteredItemsOf(entry).length / COLLECTION_ITEM_PAGE_SIZE);
}
function getPaginatedItems(entry: INexusCollectionPending): INexusCollectionPendingItem[] {
    const start = (getItemPage(entry.id) - 1) * COLLECTION_ITEM_PAGE_SIZE;
    return filteredItemsOf(entry).slice(start, start + COLLECTION_ITEM_PAGE_SIZE);
}
function goToItemPage(entry: INexusCollectionPending, page: number) {
    const total = Math.max(1, getItemTotalPages(entry));
    collectionItemPages.value = { ...collectionItemPages.value, [entry.id]: Math.min(Math.max(1, page), total) };
}

// 下载列表识别：externalId:resourceId → 任务对象（无匹配返回 null）。
// 同键多命中时取最新鲜的，避免幽灵老记录遮挡 live task 导致重复建任务。
function getPendingTask(item: INexusCollectionPendingItem): IDownloaderTask | null {
    const key = `${item.modId}:${item.fileId}`;
    const statusPriority: Record<string, number> = { active: 5, waiting: 4, paused: 3, complete: 2, error: 1 };
    let best: IDownloaderTask | null = null;
    let bestScore = -1;
    let bestTime = "";
    for (const [gid, meta] of Object.entries(taskMetaMap.value)) {
        if (`${meta.externalId}:${meta.resourceId}` !== key) continue;
        const task = allTasks.value.find((t) => t.gid === gid);
        if (!task) continue;
        const time = meta.updatedAt || meta.createdAt || "";
        const score = statusPriority[task.status] ?? 0;
        if (score > bestScore || (score === bestScore && time > bestTime)) {
            best = task;
            bestScore = score;
            bestTime = time;
        }
    }
    return best;
}

// 下载列表识别：externalId:resourceId → 任务状态（无任务时回退 meta 快照）。
function getPendingTaskStatus(item: INexusCollectionPendingItem): string | null {
    const task = getPendingTask(item);
    if (task) return task.status;
    for (const meta of Object.values(taskMetaMap.value)) {
        if (`${meta.externalId}:${meta.resourceId}` !== `${item.modId}:${item.fileId}`) continue;
        return meta.taskStatus ?? null;
    }
    return null;
}
// 实时任务是否存在：以下载列表为准，持久化 status 可能是幽灵标记（任务已删但标记残留）。
function hasLiveTask(item: INexusCollectionPendingItem): boolean {
    return getPendingTask(item) !== null;
}

// Mod 列表识别：本地已装（webId 匹配外部 modId）。
function isPendingItemInstalled(item: INexusCollectionPendingItem): boolean {
    return manager.managerModList.some((mod) => String(mod.webId ?? "") === item.modId);
}
// 打开文件位置：优先关联下载任务的主文件目录，其次已安装 mod 的缓存目录。
async function openPendingItemLocation(item: INexusCollectionPendingItem) {
    const { FileHandler } = await import("@/lib/FileHandler");
    const key = `${item.modId}:${item.fileId}`;
    for (const [gid, meta] of Object.entries(taskMetaMap.value)) {
        if (`${meta.externalId}:${meta.resourceId}` !== key) continue;
        const task = allTasks.value.find((t) => t.gid === gid);
        const filePath = task?.files.find((f) => f.path)?.path ?? task?.files[0]?.path;
        if (filePath) {
            const dirPath = filePath.replace(/[\\/][^\\/]*$/u, "");
            if (dirPath && (await FileHandler.openFolder(dirPath))) return;
            break;
        }
    }
    const localMod = manager.managerModList.find((mod) => String(mod.webId ?? "") === item.modId);
    if (localMod) {
        const modPath = await manager.getModStoragePath(localMod.id);
        if (modPath && (await FileHandler.openFolder(modPath))) return;
    }
    ElMessage.warning("该文件暂无本地位置（未下载也未安装）。");
}
// 行级终态：done 优先（已安装/任务完成），其次失败，其次已建任务，其次待处理。
function getItemFilterState(item: INexusCollectionPendingItem): CollectionFilter {
    if (isPendingItemInstalled(item) || getPendingTaskStatus(item) === "complete") return "done";
    if (item.status === "failed" || getPendingTaskStatus(item) === "error") return "failed";
    if (item.status === "queued") return "queued";
    return "pending";
}
// 条目级状态：全部 done 才算 done，有 failed 算 failed，其次 queued/pending。
function getEntryFilterState(entry: INexusCollectionPending): CollectionFilter {
    const states = entry.items.map(getItemFilterState);
    if (states.length > 0 && states.every((s) => s === "done")) return "done";
    if (states.includes("failed")) return "failed";
    if (states.includes("queued")) return "queued";
    if (states.includes("pending")) return "pending";
    return "all";
}
type CollectionFilter = "all" | "pending" | "queued" | "failed" | "done" | "undownloaded";
const collectionFilterOptions: Array<{ value: CollectionFilter; label: string }> = [
    { value: "all", label: "全部" },
    { value: "undownloaded", label: "未下载" },
    { value: "pending", label: "待处理" },
    { value: "queued", label: "已建任务" },
    { value: "failed", label: "失败" },
];
// 未下载：非 done 即未下载（pending/queued/failed 统收）。条目/明细匹配时特殊处理。
function isItemUndownloaded(item: INexusCollectionPendingItem): boolean {
    return getItemFilterState(item) !== "done";
}
// 勾选：entryId → modId:fileId 集合。默认全选必装项（!optional），已导入（done）不可勾选。
const selectedPendingItems = ref<Record<string, string[]>>({});
function getItemKey(item: INexusCollectionPendingItem): string {
    return `${item.modId}:${item.fileId}`;
}
function isItemSelectable(item: INexusCollectionPendingItem): boolean {
    return getItemFilterState(item) !== "done";
}
function getSelectedKeys(entryId: string): string[] {
    return selectedPendingItems.value[entryId] ?? [];
}
function isItemSelected(entryId: string, item: INexusCollectionPendingItem): boolean {
    return getSelectedKeys(entryId).includes(getItemKey(item));
}
function setItemSelected(entryId: string, item: INexusCollectionPendingItem, checked: boolean) {
    if (!isItemSelectable(item)) return;
    const key = getItemKey(item);
    const current = new Set(getSelectedKeys(entryId));
    if (checked) current.add(key);
    else current.delete(key);
    selectedPendingItems.value = { ...selectedPendingItems.value, [entryId]: [...current] };
}
// 条目默认勾选：必装项全选（done 的本来就不可选，天然排除）。
function ensureEntryDefaults(entry: INexusCollectionPending) {
    if (selectedPendingItems.value[entry.id] !== undefined) return;
    selectedPendingItems.value = {
        ...selectedPendingItems.value,
        [entry.id]: entry.items.filter((item) => !item.optional && isItemSelectable(item)).map(getItemKey),
    };
}
// 条目 mod 计数：共 X · 必装 Y · 可选 Z · 已导入 W。
function getEntryCounts(entry: INexusCollectionPending): { total: number; required: number; optional: number; done: number } {
    const total = entry.items.length;
    const required = entry.items.filter((item) => !item.optional).length;
    const done = entry.items.filter((item) => getItemFilterState(item) === "done").length;
    return { total, required, optional: total - required, done };
}
// 跳 Nexus 网页：collection 主页 / 单文件 mod 页。
// collection 规范形带 /games（nexusmods.com/games/{game}/collections/{slug}），无段形会 404/误跳。
async function openCollectionPage(entry: INexusCollectionPending) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(`https://www.nexusmods.com/games/${entry.gameDomain}/collections/${entry.slug}`);
}
async function openModPage(entry: INexusCollectionPending, item: INexusCollectionPendingItem) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(`https://www.nexusmods.com/${entry.gameDomain}/mods/${item.modId}?tab=files&file_id=${item.fileId}`);
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string" && error.trim()) return error;
    return "操作失败。";
}

async function queueSinglePendingItem(entry: INexusCollectionPending, item: INexusCollectionPendingItem) {
    const { updateCollectionPendingItem } = await import("@/lib/nexus-collection-pending");
    console.debug(`[auth] queueSingle modId=${item.modId} userNull=${settings.nexusModsUser == null} keyLen=${settings.nexusModsUser?.key?.trim().length ?? 0} mode=${settings.nexusModsDownloadMode}`);
    const singleTag = `[single] modId=${item.modId} fileId=${item.fileId}`;
    console.debug(`${singleTag} stage=click`);
    try {
        // 已知 modId/fileId：构造最小 detail 直调，直跳 files 清单（API 不可见 mod 会 403）。
        const mod = buildMinimalNexusModDetail(entry.gameDomain, item.modId, item.fileId, item.name, item.version);
        const result = await queueThirdPartyModDownload({
            provider: "NexusMods",
            mod,
            fileId: item.fileId,
            gameName: entry.gameName,
            managerModList: manager.managerModList,
            nexusUser: settings.nexusModsUser,
            nexusDirect: {
                mode: settings.nexusModsDownloadMode === "cookie" ? "cookie" : "api",
                cookie: settings.nexusModsCookie,
            },
            collectionId: entry.id,
        });
    console.debug(`${singleTag} stage=queue-done status=${result.status} gid=${result.gid ?? "null"} msg=${result.message}`);
    // 免费 API key 拿不到直链时会回退网页地址走外部打开：不建任务，必须标失败而非幽灵 queued。
    if (result.status === "external") {
        const reason = "免费 API key 无直链权限，已用浏览器打开下载页。请切 Cookie 模式或用 NXM 链接导入。";
        await updateCollectionPendingItem(entry.id, item.modId, item.fileId, "failed", reason);
        await refreshCollectionPending();
        ElMessage.warning(reason);
        return;
    }
    // 已在本地管理列表：不建任务，无需标 queued（行级已按 installed 显示“已完成”），明示即可。
    if (result.status === "imported") {
        console.debug(`${singleTag} stage=already-installed`);
        await refreshCollectionPending();
        ElMessage.info(result.message);
        return;
    }
    // 复用存量任务（exists：已完成/已暂停/进行中）：不标 queued 造幽灵态，提示用户去向。
    if (result.status === "exists") {
        console.debug(`${singleTag} stage=reused gid=${result.gid ?? "null"}`);
        await refreshTaskSnapshot();
        ElMessage.info(result.message);
        return;
    }
    await updateCollectionPendingItem(entry.id, item.modId, item.fileId, "queued", undefined);
    console.debug(`${singleTag} stage=marked-queued`);
    await refreshCollectionPending();
    await refreshTaskSnapshot();
    ElMessage.success(result.message);
    } catch (error: unknown) {
        // B：授权错不标失败（凭据问题修好后可重试），提示去设置页授权。
        const rawReason = error instanceof Error ? error.message : typeof error === "string" && error.trim() ? error : "下载建任务失败。";
        console.debug(`${singleTag} stage=thrown err=${rawReason.slice(0, 120)}`);
        if (error instanceof Error && error.name === "NexusModsAuthorizationError") {
            ElMessage.warning("NexusMods 授权缺失或已过期，请到设置页重新授权后再重试。");
            return;
        }
        await updateCollectionPendingItem(entry.id, item.modId, item.fileId, "failed", rawReason);
        await refreshCollectionPending();
        ElMessage.error(rawReason);
    }
}

// 背压等待：等待中（active/waiting/paused 非完成态实时任务）达上限即每 5s 检查一次。
function getWaitingTaskCount(): number {
    return allTasks.value.filter((t) => ["active", "waiting", "paused"].includes(t.status)).length;
}
function waitForQueueSlot(entryId: string): Promise<void> {
    return new Promise((resolve) => {
        const limit = Math.max(1, Number(settings.collectionQueueLimit) || 10);
        const check = () => {
            if (retryProgressMap.value[entryId]?.cancelled) {
                resolve();
                return;
            }
            if (getWaitingTaskCount() < limit) {
                resolve();
                return;
            }
            setTimeout(check, 5000);
        };
        check();
    });
}

async function retryPendingEntry(entry: INexusCollectionPending) {
    // 只处理勾选项：无 live task、未安装、可勾选三者同时满足；未勾选过（首次）按默认必装全选。
    ensureEntryDefaults(entry);
    const selected = new Set(getSelectedKeys(entry.id));
    const todo = entry.items.filter((item) => selected.has(getItemKey(item)) && !hasLiveTask(item) && !isPendingItemInstalled(item) && isItemSelectable(item));
    if (todo.length === 0) {
        ElMessage.info("没有可重试的勾选文件（已导入的不可勾选）。");
        return;
    }
    // 先关暂停闸：后建的任务以 Paused 落库不启动，重试全程可暂停/继续。
    try {
        await Downloader.pauseCollection(entry.id);
    } catch {
        // 关闸失败不中断，继续建任务。
    }
    retryProgressMap.value = { ...retryProgressMap.value, [entry.id]: { done: 0, total: todo.length, cancelled: false } };
    for (const item of todo) {
        if (retryProgressMap.value[entry.id]?.cancelled) break;
        // 背压：等待中任务达上限即暂停塞入，setTimeout 隔 5s 检查一次，直到有空位或取消。
        await waitForQueueSlot(entry.id);
        if (retryProgressMap.value[entry.id]?.cancelled) break;
        await queueSinglePendingItem(entry, item);
        const prog = retryProgressMap.value[entry.id];
        if (prog) retryProgressMap.value = { ...retryProgressMap.value, [entry.id]: { ...prog, done: prog.done + 1 } };
    }
    const wasCancelled = retryProgressMap.value[entry.id]?.cancelled ?? false;
    const { [entry.id]: _dropped, ...rest } = retryProgressMap.value;
    retryProgressMap.value = rest;
    await refreshTaskSnapshot();
    const refreshed = (await listCollectionPending()).find((e) => e.id === entry.id);
    const success = refreshed?.items.filter((item) => item.status === "queued").length ?? 0;
    ElMessage.success(wasCancelled ? `已停止重试：已处理 ${success}/${entry.items.length} 个。` : `已加入待下载队列 ${success} 个，共 ${entry.items.length} 个，点继续下载开始。`);
}

async function deletePendingEntry(id: string) {
    await removeCollectionPending(id);
    await refreshCollectionPending();
}

async function clearFinishedPending() {
    await clearFinishedCollectionPending();
    await refreshCollectionPending();
}

// 暂停/继续指定 collection。
async function pauseCollectionEntry(entry: INexusCollectionPending) {
    try {
        const count = await Downloader.pauseCollection(entry.id);
        ElMessage.success(count > 0 ? `已暂停该 Collection：${count} 个任务。` : "该 Collection 暂无可暂停的任务。");
        await refreshTaskSnapshot();
    } catch (error: unknown) {
        ElMessage.error(getErrorMessage(error));
    }
}

async function resumeCollectionEntry(entry: INexusCollectionPending) {
    try {
        const count = await Downloader.resumeCollection(entry.id);
        ElMessage.success(count > 0 ? `已继续该 Collection：${count} 个任务。` : "该 Collection 暂无可继续的任务。");
        await refreshTaskSnapshot();
    } catch (error: unknown) {
        ElMessage.error(getErrorMessage(error));
    }
}
onMounted(async () => {
    releaseCollectionTaskEvents = downloadTasksStore.ensureEventSubscription();
    // 先拉任务快照（含 merge + meta 对齐），清单对账（清过期 reason）才有数据可用。
    await refreshTaskSnapshot();
    // 管理列表进页时为空则拉一次：先恢复游戏上下文再 refresh，否则 managerRoot 为空直接 return。
    if (manager.managerModList.length === 0) {
        try {
            manager.syncManagerGamesFromPersisted();
            await manager.refreshRuntimeData({
                storagePath: settings.storagePath,
                closeSoftLinks: settings.closeSoftLinks,
            });
        } catch {
            // 加载失败不中断，清单照常显示。
        }
    }
    await refreshCollectionPending();
});
onUnmounted(() => {
    releaseCollectionTaskEvents?.();
    releaseCollectionTaskEvents = null;
});
</script>

<template>
    <div class="flex flex-col gap-6">
        <Card>
            <CardHeader>
                <CardTitle class="flex flex-wrap items-center justify-between gap-3">
                    <span>
                        Collection 待下载
                        <Badge variant="outline" class="rounded-full ml-4">
                            {{ collectionPendingList.length }}
                        </Badge>
                    </span>
                    <div class="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" :disabled="collectionPendingLoading" @click="refreshCollectionPending()">
                            <IconRefreshCw :class="collectionPendingLoading ? 'animate-spin' : ''" />
                            刷新
                        </Button>
                        <Button size="sm" variant="outline" @click="clearFinishedPending()">
                            <IconTrash2 />
                            清理已处理
                        </Button>
                    </div>
                </CardTitle>
                <CardDescription>勾选后即持久化保存，中断或重启后可在此重试未建任务的文件。</CardDescription>
            </CardHeader>
            <CardContent class="flex flex-col gap-3">
                <div class="flex flex-wrap gap-2">
                    <Button
                        v-for="opt in collectionFilterOptions"
                        :key="opt.value"
                        size="sm"
                        :variant="collectionFilter === opt.value ? 'default' : 'outline'"
                        @click="collectionFilter = opt.value"
                    >
                        {{ opt.label }}
                    </Button>
                </div>
                <div v-if="collectionPendingLoading" class="text-sm text-muted-foreground">正在读取待下载清单…</div>
<ContextMenu v-for="entry in paginatedCollections" :key="entry.id">
<ContextMenuTrigger as-child>
<article class="cursor-pointer rounded-xl border px-4 py-4 transition-colors hover:border-primary/40">
                    <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div class="min-w-0 flex-1 space-y-2">
                            <div class="flex flex-wrap items-center gap-2">
                                <div class="truncate text-sm font-medium">{{ entry.name }} R{{ entry.revision }}</div>
                                <Badge class="rounded-full" variant="outline">{{ entry.gameDomain }}/{{ entry.slug }}</Badge>
                                <Badge class="rounded-full" variant="outline">
                                    共 {{ getEntryCounts(entry).total }} 个文件 · 必装 {{ getEntryCounts(entry).required }} · 可选 {{ getEntryCounts(entry).optional }} · 已导入 {{ getEntryCounts(entry).done }}
                                </Badge>
                            </div>
                            <div v-if="getRetryProgress(entry.id)" class="flex items-center gap-2 text-xs text-muted-foreground">
                                <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                                    <div class="h-full rounded-full bg-primary transition-all" :style="{ width: `${Math.round((getRetryProgress(entry.id)!.done / Math.max(1, getRetryProgress(entry.id)!.total)) * 100)}%` }"></div>
                                </div>
                                <span>重试中 {{ getRetryProgress(entry.id)!.done }}/{{ getRetryProgress(entry.id)!.total }}</span>
                            </div>
                            <div v-else class="h-2 overflow-hidden rounded-full bg-muted flex" :title="`已完成 ${pendingProgress(entry).done}% · 下载中 ${pendingProgress(entry).downloading}%`">
                                <div class="h-full bg-primary transition-all" :style="{ width: `${pendingProgress(entry).done}%` }"></div>
                                <div class="h-full transition-all opacity-70" :style="{ width: `${pendingProgress(entry).downloading}%`, backgroundImage: `repeating-linear-gradient(-55deg, var(--primary) 0 4px, transparent 4px 8px)` }"></div>
                            </div>
                        </div>
                        <div class="grid w-full grid-cols-3 gap-1.5 lg:w-auto lg:flex lg:flex-wrap lg:justify-end lg:gap-2">
                            <Button size="sm" variant="outline" class="min-w-0 px-2 sm:px-3" @click="togglePendingExpanded(entry.id)">
                                {{ expandedPendingIds.includes(entry.id) ? "收起" : "展开" }}
                            </Button>
                            <Button v-if="!getRetryProgress(entry.id)" size="sm" class="min-w-0 px-2 sm:px-3" @click="retryPendingEntry(entry)">重试未完成</Button>
                            <Button v-else size="sm" variant="destructive" class="min-w-0 px-2 sm:px-3" @click="cancelRetryEntry(entry.id)">停止重试</Button>
                            <Button size="sm" variant="outline" class="min-w-0 px-2 sm:px-3" @click="pauseCollectionEntry(entry)">
                                <IconPause />
                                <span class="hidden sm:inline">暂停下载</span>
                            </Button>
                            <Button size="sm" variant="outline" class="min-w-0 px-2 sm:px-3" @click="resumeCollectionEntry(entry)">
                                <IconPlay />
                                <span class="hidden sm:inline">继续下载</span>
                            </Button>
                            <Button size="sm" variant="outline" class="min-w-0 px-2 sm:px-3" @click="openCollectionPage(entry)">
                                <IconExternalLink />
                                <span class="hidden sm:inline">网页</span>
                            </Button>
                            <Button size="sm" variant="outline" class="min-w-0 px-2 sm:px-3" @click="deletePendingEntry(entry.id)">
                                <IconTrash2 />
                                <span class="hidden sm:inline">移除</span>
                            </Button>
                        </div>
                    </div>
                    <div v-if="expandedPendingIds.includes(entry.id)" class="mt-3 max-h-[48vh] space-y-2 overflow-y-auto pr-1">
                        <ContextMenu v-for="item in getPaginatedItems(entry)" :key="`${item.modId}:${item.fileId}`">
<ContextMenuTrigger as-child>
<div class="flex flex-col gap-2 rounded-xl border px-3 py-2 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                            <input type="checkbox" class="h-4 w-4 shrink-0 accent-primary" :checked="isItemSelected(entry.id, item)" :disabled="!isItemSelectable(item)" :title="isItemSelectable(item) ? (item.optional ? '可选：勾选后下载' : '必装：默认勾选') : '已导入：不可勾选'" @click.stop @change="setItemSelected(entry.id, item, ($event.target as HTMLInputElement).checked)" />
                            <div class="min-w-0 flex-1">
                                <div class="truncate font-medium">{{ item.name }}</div>
                                <div class="mt-1 text-xs text-muted-foreground">
                                    mod {{ item.modId }} · file {{ item.fileId }} · {{ item.version }}
                                    <span v-if="item.optional">· 可选</span>
                                </div>
                                <div v-if="getPendingTask(item) && ['active', 'waiting', 'paused'].includes(getPendingTask(item)?.status ?? '')" class="mt-1.5 flex items-center gap-2">
                                    <div v-if="getPendingTask(item)?.status === 'active'" class="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                                        <div class="h-full transition-all opacity-80" :style="{ width: `${getTaskProgress(getPendingTask(item)!)}%`, backgroundImage: `repeating-linear-gradient(-55deg, var(--primary) 0 4px, transparent 4px 8px)`, backgroundSize: `auto`, animation: `collection-stripes 1s linear infinite` }"></div>
                                    </div>
                                    <div v-else class="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                                        <div class="h-full transition-all opacity-60" :style="{ width: `${getTaskProgress(getPendingTask(item)!)}%`, backgroundImage: `repeating-linear-gradient(-55deg, var(--primary) 0 4px, transparent 4px 8px)` }"></div>
                                    </div>
                                    <span class="shrink-0 text-xs text-muted-foreground">{{ getTaskProgress(getPendingTask(item)!) }}%<template v-if="getTaskSpeedText(getPendingTask(item)!)"> · {{ getTaskSpeedText(getPendingTask(item)!) }}</template></span>
                                </div>
                            </div>
                            <div class="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                                <Badge class="rounded-full" variant="outline" :class="getPendingTaskStatus(item) === 'complete' || isPendingItemInstalled(item) ? 'border-green-500/40 text-green-600' : item.status === 'failed' || getPendingTaskStatus(item) === 'error' ? 'border-destructive/40 text-destructive' : hasLiveTask(item) ? 'border-blue-500/40 text-blue-600' : item.status === 'queued' ? 'border-destructive/40 text-destructive' : ''">
                                    {{ isPendingItemInstalled(item) ? "已完成" : getPendingTaskStatus(item) === "complete" ? "已完成" : getPendingTaskStatus(item) && hasLiveTask(item) ? `任务${getPendingTaskStatus(item) === "active" ? "下载中" : getPendingTaskStatus(item) === "paused" ? "已暂停" : getPendingTaskStatus(item) === "error" ? "失败" : "等待中"}` : hasLiveTask(item) ? "任务未知" : item.status === "queued" ? "任务丢失" : item.status === "failed" ? "失败" : "待处理" }}
                                </Badge>
                                <Button v-if="!hasLiveTask(item) && !isPendingItemInstalled(item)" size="sm" variant="outline" class="min-w-0 flex-1 sm:flex-none" @click="queueSinglePendingItem(entry, item)">{{ item.status === "queued" ? "重建任务" : item.status === "failed" || getPendingTaskStatus(item) === "error" ? "重试" : "添加任务" }}</Button>
                                <Button size="sm" variant="outline" class="min-w-0 flex-1 sm:flex-none" @click="openModPage(entry, item)">
                                    <IconExternalLink />
                                    <span class="hidden sm:inline">网页</span>
                                </Button>
                            </div>
                        </div>
                        </ContextMenuTrigger>
                        <ContextMenuContent class="w-40">
                            <ContextMenuItem v-if="!hasLiveTask(item) && !isPendingItemInstalled(item)" @select="queueSinglePendingItem(entry, item)"><IconDownload class="mr-2 h-4 w-4" />{{ item.status === "queued" ? "重建任务" : "添加任务" }}</ContextMenuItem>
                            <ContextMenuItem @select="openModPage(entry, item)"><IconExternalLink class="mr-2 h-4 w-4" />在网页打开</ContextMenuItem>
                            <ContextMenuItem @select="openPendingItemLocation(item)"><IconFolderOpen class="mr-2 h-4 w-4" />打开文件位置</ContextMenuItem>
                        </ContextMenuContent>
                        </ContextMenu>
                        <div v-if="getItemTotalPages(entry) > 1" class="flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2 text-sm">
                            <div class="text-xs text-muted-foreground">第 {{ getItemPage(entry.id) }} 页，共 {{ getItemTotalPages(entry) }} 页，累计 {{ filteredItemsOf(entry).length }} 个文件。</div>
                            <div class="flex flex-wrap items-center gap-2">
                                <Button size="sm" variant="outline" :disabled="getItemPage(entry.id) <= 1" @click="goToItemPage(entry, getItemPage(entry.id) - 1)">上一页</Button>
                                <Button size="sm" variant="outline" :disabled="getItemPage(entry.id) >= getItemTotalPages(entry)" @click="goToItemPage(entry, getItemPage(entry.id) + 1)">下一页</Button>
                            </div>
                        </div>
                    </div>
</article>
</ContextMenuTrigger>
<ContextMenuContent class="w-48">
<ContextMenuItem @select="togglePendingExpanded(entry.id)"><IconEye class="mr-2 h-4 w-4" />{{ expandedPendingIds.includes(entry.id) ? "收起" : "展开" }}</ContextMenuItem>
<ContextMenuItem @select="retryPendingEntry(entry)"><IconRefreshCw class="mr-2 h-4 w-4" />重试未完成</ContextMenuItem>
<ContextMenuItem @select="pauseCollectionEntry(entry)"><IconPause class="mr-2 h-4 w-4" />暂停下载</ContextMenuItem>
<ContextMenuItem @select="resumeCollectionEntry(entry)"><IconPlay class="mr-2 h-4 w-4" />继续下载</ContextMenuItem>
<ContextMenuItem @select="openCollectionPage(entry)"><IconExternalLink class="mr-2 h-4 w-4" />在网页打开</ContextMenuItem>
 <ContextMenuSeparator />
<ContextMenuItem variant="destructive" @select="deletePendingEntry(entry.id)"><IconTrash2 class="mr-2 h-4 w-4" />移除</ContextMenuItem>
</ContextMenuContent>
</ContextMenu>
                <div v-if="collectionTotalPages > 1" class="flex flex-col gap-3 rounded-xl border px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
                    <div class="text-sm text-muted-foreground">当前第 {{ collectionPage }} 页，共 {{ collectionTotalPages }} 页，累计 {{ filteredCollections.length }} 个合集。</div>
                    <div class="flex flex-wrap items-center gap-2">
                        <Button size="sm" variant="outline" :disabled="collectionPage <= 1" @click="goToCollectionPage(collectionPage - 1)">
                            <IconChevronLeft />
                            上一页
                        </Button>
                        <template v-for="item in collectionPageItems" :key="item.key">
                            <span v-if="item.ellipsis" class="px-2 text-sm text-muted-foreground">{{ item.label }}</span>
                            <Button v-else size="sm" :variant="item.page === collectionPage ? 'default' : 'outline'" @click="goToCollectionPage(item.page ?? 1)">{{ item.label }}</Button>
                        </template>
                        <Button size="sm" variant="outline" :disabled="collectionPage >= collectionTotalPages" @click="goToCollectionPage(collectionPage + 1)">
                            下一页
                            <IconChevronRight />
                        </Button>
                    </div>
                </div>
            </CardContent>
        </Card>
    </div>
</template>
<style scoped>
/* 下载中条纹滚动：虚线进度条的流动效果，paused/waiting 为静态虚线。 */
@keyframes collection-stripes {
    from { background-position: 0 0; }
    to { background-position: 16px 0; }
}
</style>
