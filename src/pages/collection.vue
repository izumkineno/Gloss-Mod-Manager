<script setup lang="ts">
// Collection 待下载清单独立页：从下载页搬移，只做清单管理（全局暂停/继续仍在下载页）。
import { computed, onMounted, ref, watch } from "vue";
import { getTaskProgress, getTaskSpeedText } from "@/lib/download-task-ui";
import { useDownloadTasks } from "@/composables/useDownloadTasks";
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
import { fetchThirdPartyModDetail } from "@/lib/third-party-mod-api";
import { useManager } from "@/stores/manager";
import { useSettings } from "@/stores/settings";

// 任务快照/订阅/meta 统一收口 composable（snapshotOnly：事件只刷快照，不写盘）。
const { allTasks, taskMetaMap, refreshTaskSnapshot } = useDownloadTasks({ snapshotOnly: true });

// 清单列表/加载态/展开态。
const collectionPendingList = ref<INexusCollectionPending[]>([]);
const collectionPendingLoading = ref(false);
const expandedPendingIds = ref<string[]>([]);
// 过滤器：all/pending/queued/failed/done（done = 任务完成或已安装）。
type CollectionFilter = "all" | "pending" | "queued" | "failed" | "done";
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

function pendingProgress(entry: INexusCollectionPending): number {
    if (entry.items.length === 0) return 0;
    const done = entry.items.filter((item) => item.status !== "pending").length;
    return Math.round((done / entry.items.length) * 100);
}
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
function getPendingTask(item: INexusCollectionPendingItem): IDownloaderTask | null {
    const key = `${item.modId}:${item.fileId}`;
    for (const [gid, meta] of Object.entries(taskMetaMap.value)) {
        if (`${meta.externalId}:${meta.resourceId}` !== key) continue;
        return allTasks.value.find((t) => t.gid === gid) ?? null;
    }
    return null;
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
const collectionFilterOptions: Array<{ value: CollectionFilter; label: string }> = [
    { value: "all", label: "全部" },
    { value: "pending", label: "待处理" },
    { value: "queued", label: "已建任务" },
    { value: "failed", label: "失败" },
    { value: "done", label: "已完成" },
];
const filteredCollections = computed(() => {
    if (collectionFilter.value === "all") return collectionPendingList.value;
    return collectionPendingList.value.filter((entry) => {
        if (getEntryFilterState(entry) === collectionFilter.value) return true;
        return entry.items.some((item) => getItemFilterState(item) === collectionFilter.value);
    });
});
// 明细行再过滤：只显示命中过滤器的文件。
const filteredItemsOf = (entry: INexusCollectionPending): INexusCollectionPendingItem[] => {
    if (collectionFilter.value === "all") return entry.items;
    return entry.items.filter((item) => getItemFilterState(item) === collectionFilter.value);
};
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
    try {
        const mod = await fetchThirdPartyModDetail("NexusMods", entry.game, item.modId, { gameDomain: entry.gameDomain }, settings.nexusModsUser);
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
        // 免费 API key 拿不到直链时会回退网页地址走外部打开：不建任务，必须标失败而非幽灵 queued。
        if (result.status === "external") {
            const reason = "免费 API key 无直链权限，已用浏览器打开下载页。请切 Cookie 模式或用 NXM 链接导入。";
            await updateCollectionPendingItem(entry.id, item.modId, item.fileId, "failed", reason);
            await refreshCollectionPending();
            ElMessage.warning(reason);
            return;
        }
        await updateCollectionPendingItem(entry.id, item.modId, item.fileId, "queued", undefined);
        await refreshCollectionPending();
        await refreshTaskSnapshot();
    } catch (error: unknown) {
        // 后端 invoke 失败 reject 的是字符串而非 Error，直接保留原文。
        const reason = error instanceof Error ? error.message : typeof error === "string" && error.trim() ? error : "下载建任务失败。";
        await updateCollectionPendingItem(entry.id, item.modId, item.fileId, "failed", reason);
        await refreshCollectionPending();
        ElMessage.error(reason);
    }
}

async function retryPendingEntry(entry: INexusCollectionPending) {
    const todo = entry.items.filter((item) => item.status !== "queued");
    if (todo.length === 0) return;
    // 先关暂停闸：后建的任务以 Paused 落库不启动，重试全程可暂停/继续。
    try {
        await Downloader.pauseCollection(entry.id);
    } catch {
        // 关闸失败不中断，继续建任务。
    }
    for (const item of todo) await queueSinglePendingItem(entry, item);
    await refreshTaskSnapshot();
    const refreshed = (await listCollectionPending()).find((e) => e.id === entry.id);
    const success = refreshed?.items.filter((item) => item.status === "queued").length ?? 0;
    ElMessage.success(`已加入待下载队列 ${success} 个，共 ${entry.items.length} 个，点继续下载开始。`);
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
    // 订阅由 composable 统一注册；先拉任务快照，清单对账（清过期 reason）才有数据可用。
    await refreshTaskSnapshot();
    await refreshCollectionPending();
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
                    <div class="flex flex-wrap items-center justify-between gap-3">
                        <div class="min-w-0 flex-1 space-y-2">
                            <div class="flex flex-wrap items-center gap-2">
                                <div class="truncate text-sm font-medium">{{ entry.name }} R{{ entry.revision }}</div>
                                <Badge class="rounded-full" variant="outline">{{ entry.gameDomain }}/{{ entry.slug }}</Badge>
                                <Badge class="rounded-full" variant="outline">
                                    {{ entry.items.filter((item) => item.status === "queued").length }}/{{ entry.items.length }} 已建任务
                                </Badge>
                            </div>
                            <div class="h-2 overflow-hidden rounded-full bg-muted">
                                <div class="h-full rounded-full bg-primary transition-all" :style="{ width: `${pendingProgress(entry)}%` }"></div>
                            </div>
                        </div>
                        <div class="flex flex-wrap gap-2">
                            <Button size="sm" variant="outline" @click="togglePendingExpanded(entry.id)">
                                {{ expandedPendingIds.includes(entry.id) ? "收起" : "展开" }}
                            </Button>
                            <Button size="sm" @click="retryPendingEntry(entry)">重试未完成</Button>
                            <Button size="sm" variant="outline" @click="pauseCollectionEntry(entry)">
                                <IconPause />
                                暂停下载
                            </Button>
                            <Button size="sm" variant="outline" @click="resumeCollectionEntry(entry)">
                                <IconPlay />
                                继续下载
                            </Button>
                            <Button size="sm" variant="outline" @click="openCollectionPage(entry)">
                                <IconExternalLink />
                                网页
                            </Button>
                            <Button size="sm" variant="outline" @click="deletePendingEntry(entry.id)">
                                <IconTrash2 />
                                移除
                            </Button>
                        </div>
                    </div>
                    <div v-if="expandedPendingIds.includes(entry.id)" class="mt-3 max-h-[48vh] space-y-2 overflow-y-auto pr-1">
                        <ContextMenu v-for="item in getPaginatedItems(entry)" :key="`${item.modId}:${item.fileId}`">
<ContextMenuTrigger as-child>
<div class="flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2 text-sm">
                            <div class="min-w-0 flex-1">
                                <div class="truncate font-medium">{{ item.name }}</div>
                                <div class="mt-1 text-xs text-muted-foreground">
                                    mod {{ item.modId }} · file {{ item.fileId }} · {{ item.version }}
                                    <span v-if="item.optional">· 可选</span>
                                    <span v-if="item.reason && getPendingTaskStatus(item) !== 'complete' && !isPendingItemInstalled(item)">· {{ item.reason }}</span>
                                    <span v-if="getPendingTaskStatus(item)">
                                        · 任务{{ getPendingTaskStatus(item) === "complete" ? "已完成" : getPendingTaskStatus(item) === "active" ? "下载中" : getPendingTaskStatus(item) === "paused" ? "已暂停" : getPendingTaskStatus(item) === "error" ? "失败" : "等待中" }}
                                    </span>
                                    <span v-if="isPendingItemInstalled(item)">· 已安装</span>
                                </div>
                                <div v-if="getPendingTask(item) && ['active', 'waiting', 'paused'].includes(getPendingTask(item)?.status ?? '')" class="mt-1.5 flex items-center gap-2">
                                    <div class="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                                        <div class="h-full rounded-full bg-primary transition-all" :style="{ width: `${getTaskProgress(getPendingTask(item)!)}%` }"></div>
                                    </div>
                                    <span class="shrink-0 text-xs text-muted-foreground">{{ getTaskProgress(getPendingTask(item)!) }}%<template v-if="getTaskSpeedText(getPendingTask(item)!)"> · {{ getTaskSpeedText(getPendingTask(item)!) }}</template></span>
                                </div>
                            </div>
                            <div class="flex flex-wrap items-center gap-2">
                                <Badge class="rounded-full" variant="outline" :class="getPendingTaskStatus(item) === 'complete' || isPendingItemInstalled(item) ? 'border-green-500/40 text-green-600' : item.status === 'failed' || getPendingTaskStatus(item) === 'error' ? 'border-destructive/40 text-destructive' : item.status === 'queued' || getPendingTaskStatus(item) ? 'border-blue-500/40 text-blue-600' : ''">
                                    {{ isPendingItemInstalled(item) ? "已完成" : getPendingTaskStatus(item) === "complete" ? "已完成" : getPendingTaskStatus(item) ? `任务${getPendingTaskStatus(item) === "active" ? "下载中" : getPendingTaskStatus(item) === "paused" ? "已暂停" : getPendingTaskStatus(item) === "error" ? "失败" : "等待中"}` : item.status === "queued" ? "已建任务" : item.status === "failed" ? "失败" : "待处理" }}
                                </Badge>
                                <Button v-if="item.status !== 'queued' && !isPendingItemInstalled(item)" size="sm" variant="outline" @click="queueSinglePendingItem(entry, item)">添加任务</Button>
                                <Button v-if="item.status === 'failed' || getPendingTaskStatus(item) === 'error'" size="sm" variant="outline" @click="queueSinglePendingItem(entry, item)">重试</Button>
                                <Button size="sm" variant="outline" @click="openModPage(entry, item)">
                                    <IconExternalLink />
                                    网页
                                </Button>
                            </div>
                        </div>
                        </ContextMenuTrigger>
                        <ContextMenuContent class="w-40">
                            <ContextMenuItem v-if="item.status !== 'queued' && !isPendingItemInstalled(item)" @select="queueSinglePendingItem(entry, item)">添加任务</ContextMenuItem>
                            <ContextMenuItem v-if="item.status === 'failed' || getPendingTaskStatus(item) === 'error'" @select="queueSinglePendingItem(entry, item)">重试</ContextMenuItem>
                            <ContextMenuItem @select="openModPage(entry, item)">在网页打开</ContextMenuItem>
                            <ContextMenuItem @select="openPendingItemLocation(item)">打开文件位置</ContextMenuItem>
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
<ContextMenuItem @select="togglePendingExpanded(entry.id)">{{ expandedPendingIds.includes(entry.id) ? "收起" : "展开" }}</ContextMenuItem>
<ContextMenuItem @select="retryPendingEntry(entry)">重试未完成</ContextMenuItem>
<ContextMenuItem @select="pauseCollectionEntry(entry)">暂停下载</ContextMenuItem>
<ContextMenuItem @select="resumeCollectionEntry(entry)">继续下载</ContextMenuItem>
<ContextMenuItem @select="openCollectionPage(entry)">在网页打开</ContextMenuItem>
<ContextMenuSeparator />
<ContextMenuItem variant="destructive" @select="deletePendingEntry(entry.id)">移除</ContextMenuItem>
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
