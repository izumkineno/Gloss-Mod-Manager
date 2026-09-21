// NexusMods Collection 下载编排：revision 选择 → 文件清单 → 勾选 → 逐个建任务。
// 文件解析复用单文件下载链路（fetchThirdPartyModDetail + queueThirdPartyModDownload），
// 因此每个文件都会走已有的去重/直链/回退逻辑。
import {
    buildMinimalNexusModDetail,
    fetchNexusModsModMeta,
    type INexusModsDirectOptions,
} from "@/lib/third-party-mod-api";
import { queueThirdPartyModDownload } from "../queue/third-party-queue";
import {
    fetchNexusCollectionFiles,
    fetchNexusCollectionInfo,
    type INexusCollectionFile,
} from "@/lib/nexus-collection-api";
import { useDownloadFilePickerStore } from "@/stores/download-picker";
import { useGlobalLoadingStore } from "@/stores/global-loading";
import { useSettings } from "@/stores/settings";
import {
    saveCollectionPending,
    updateCollectionPendingItem,
} from "@/lib/nexus-collection-pending";
import { getDownloadFacade } from "../facade";

export interface IQueueNexusCollectionOptions {
    gameDomain: string;
    slug: string;
    revision?: number;
    game: ISupportedGames;
    gameName?: string;
    managerModList?: IModInfo[];
    // 任务已完成（complete）但未安装的 modId：仅标记“已下载”，不禁用。
    downloadedModIds?: Set<string>;
    nexusUser?: INexusModsUser | null;
    nexusDirect?: INexusModsDirectOptions | null;
}

export interface IQueueNexusCollectionResult {
    successCount: number;
    failedCount: number;
    failedFiles: Array<{ name: string; reason: string }>;
}

function buildRevisionItems(
    revisions: Array<{ revisionNumber: number; revisionStatus: string }>,
    latestRevisionNumber: number | null,
) {
    return revisions.map((item) => ({
        id: String(item.revisionNumber),
        title: `Revision ${item.revisionNumber}`,
        description: [
            item.revisionStatus || "未知状态",
            item.revisionNumber === latestRevisionNumber ? "最新版本" : "",
        ]
            .filter(Boolean)
            .join(" · "),
        badges:
            item.revisionNumber === latestRevisionNumber ? ["最新"] : [],
    }));
}

function buildFileItems(files: INexusCollectionFile[], installedModIds: Set<string>, downloadedModIds: Set<string>) {
    return files.map((item) => {
        const installed = installedModIds.has(item.modId);
        const downloaded = !installed && downloadedModIds.has(item.modId);
        return {
            id: `${item.modId}:${item.fileId}`,
            title: item.name,
            description: [
                `版本：${item.version || "未标注"}`,
                `modId ${item.modId} / fileId ${item.fileId}`,
            ].join(" · "),
            badges: [...(item.optional ? ["可选"] : ["必装"]), ...(installed ? ["已导入"] : downloaded ? ["已下载"] : [])],
            optional: item.optional,
            disabled: installed,
            disabledReason: installed ? "已导入" : undefined,
        };
    });
}
// 文件清单计数：共 X · 必装 Y · 可选 Z · 已导入 W · 已下载 V · 未下载 U。
function buildFileCounts(files: INexusCollectionFile[], installedModIds: Set<string>, downloadedModIds: Set<string>): string {
    const total = files.length;
    const required = files.filter((item) => !item.optional).length;
    const imported = files.filter((item) => installedModIds.has(item.modId)).length;
    const downloaded = files.filter((item) => !installedModIds.has(item.modId) && downloadedModIds.has(item.modId)).length;
    return `共 ${total} 个文件 · 必装 ${required} · 可选 ${total - required} · 已导入 ${imported} · 已下载 ${downloaded} · 未下载 ${total - imported - downloaded}`;
}

export async function queueNexusCollectionDownloadWithSelection(
    options: IQueueNexusCollectionOptions,
): Promise<IQueueNexusCollectionResult | null> {
    const picker = useDownloadFilePickerStore();
    const loading = useGlobalLoadingStore();
    // 点击链接 → revision 弹窗前的等待盖住。
    loading.show("正在读取 Collection 版本列表…");
    let info;
    try {
        info = await fetchNexusCollectionInfo(
            options.gameDomain,
            options.slug,
            options.nexusUser,
        );
    } finally {
        loading.hide();
    }

    if (info.revisions.length === 0) {
        throw new Error("该 Collection 暂无可用版本。");
    }

    let revision = options.revision ?? undefined;

    if (revision === undefined) {
        const defaultRevision =
            info.latestRevisionNumber ??
            info.revisions[0]?.revisionNumber ??
            null;

        if (defaultRevision === null) {
            throw new Error("该 Collection 暂无可用版本。");
        }

        const picked = await picker.promptSelection({
            title: `选择 ${info.name} 的版本`,
            description: `共 ${info.revisions.length} 个版本，默认选中最新版。`,
            items: buildRevisionItems(
                info.revisions,
                info.latestRevisionNumber,
            ),
            initialItemId: String(defaultRevision),
            confirmLabel: "查看文件清单",
        });

        if (!picked || Array.isArray(picked)) {
            return null;
        }

        revision = Number(picked);
    }

    // 选完 revision → 文件弹窗前的等待盖住。
    loading.show(`正在读取 R${revision} 文件清单…`);
    let files;
    try {
        files = await fetchNexusCollectionFiles(
            options.gameDomain,
            options.slug,
            revision as number,
            options.nexusUser,
        );
    } finally {
        loading.hide();
    }
    const installedModIds = new Set(
        (options.managerModList ?? []).map((mod) => String(mod.webId ?? "")).filter(Boolean),
    );
    const downloadedModIds = options.downloadedModIds ?? new Set<string>();
    const pickedFiles = await picker.promptSelection({
        title: `${info.name} R${revision}（${files.length} 个文件）`,
        description: `勾选要下载的文件，默认全选必装项（已导入自动禁用）。${buildFileCounts(files, installedModIds, downloadedModIds)}`,
        items: buildFileItems(files, installedModIds, downloadedModIds),
        initialItemIds: files
            .filter((item) => !item.optional && !installedModIds.has(item.modId))
            .map((item) => `${item.modId}:${item.fileId}`),
        multiple: true,
        confirmLabel: "下载选中文件",
    });

    if (!pickedFiles) {
        return null;
    }

    const pickedIds = new Set(
        Array.isArray(pickedFiles) ? pickedFiles : [pickedFiles],
    );
    const selected = files.filter((item) =>
        pickedIds.has(`${item.modId}:${item.fileId}`),
    );

    if (selected.length === 0) {
        throw new Error("未选中任何文件。");
    }

    // Wave 2：勾选结果先落盘为待下载清单（Collection 页据此渲染与重试），再按设置背压逐个建任务。
    // collectionId 与清单 id 同源：页面暂停/继续（dl_pause_collection）才能命中这批任务。
    const pending = await saveCollectionPending({
        gameDomain: options.gameDomain,
        slug: options.slug,
        revision: revision as number,
        name: info.name,
        game: options.game,
        gameName: options.gameName,
        items: selected.map((item) => ({ ...item, status: "pending" })),
    });
    const collectionId = pending.id;
    // 推送设置：排队上限（等待中任务达上限即停塞，5s 轮询）+ 单次并发批数 + 批间等待毫秒。
    const settings = useSettings();
    const queueLimit = Math.max(1, Number(settings.collectionQueueLimit) || 20);
    const batchSize = Math.max(1, Math.floor(Number(settings.collectionPushBatch) || 5));
    const batchInterval = Math.max(0, Number(settings.collectionPushInterval) || 0);
    // 逐文件走单文件链路：查详情拿真实 fileName，再建任务（自带去重/直链）。
    const result: IQueueNexusCollectionResult = {
        successCount: 0,
        failedCount: 0,
        failedFiles: [],
    };

    // 等待中（active/waiting/paused 非完成态）达上限即每 5s 检查一次，有空位再续。
    // tsconfig lib=ES2020，无 Promise.withResolvers，用执行器形式。
    const waitForQueueSlot = (): Promise<void> =>
        new Promise((resolve) => {
            const check = () => {
                const waiting = getDownloadFacade()
                    .snapshot()
                    .filter((task) => ["active", "waiting", "paused", "retrying"].includes(task.status)).length;
                if (waiting < queueLimit) {
                    resolve();
                    return;
                }
                setTimeout(check, 1000);
            };
            check();
        });

    for (let i = 0; i < selected.length; i += batchSize) {
        // 背压：塞批前等空位，避免一次性把 Collection 全量灌进队列。
        await waitForQueueSlot();
        const batch = selected.slice(i, i + batchSize);
        await Promise.all(batch.map(async (item) => {
            try {
                // collection 已知 modId/fileId：直调直链，跳过 files 清单接口。
                // files.json 对部分 mod 返回 403 Mod not available（API 不可见但网页可下），
                // 走详情链必死；构造最小 detail 直调 resolve（cookie 直连/免费 key 回退逻辑不变）。
                const mod = buildMinimalNexusModDetail(options.gameDomain, item.modId, item.fileId, item.name, item.version);
                // 介绍回填：只读 mods/{id}.json，失败静默（403/断网不阻塞建任务）。
                console.debug(`[collection-hydrate] modId=${item.modId} fileId=${item.fileId} name=${item.name} stage=meta-start`);
                const meta = await fetchNexusModsModMeta(options.gameDomain, item.modId, options.nexusUser);
                if (meta) {
                    if (meta.title) mod.title = meta.title;
                    if (meta.summary) mod.summary = meta.summary;
                    if (meta.description) mod.description = meta.description;
                    if (meta.author) mod.author = meta.author;
                    if (meta.cover) mod.cover = meta.cover;
                    console.debug(`[collection-hydrate] modId=${item.modId} stage=meta-applied title=${Boolean(meta.title)} descLen=${meta.description.length} summaryLen=${meta.summary.length} cover=${Boolean(meta.cover)}`);
                } else {
                    console.debug(`[collection-hydrate] modId=${item.modId} stage=meta-miss`);
                }
                console.debug(`[uuid-trace] collection queue start modId=${item.modId} fileId=${item.fileId} name=${item.name}`);
                await queueThirdPartyModDownload({
                    provider: "NexusMods",
                    mod,
                    fileId: item.fileId,
                    gameName: options.gameName,
                    managerModList: options.managerModList,
                    nexusUser: options.nexusUser,
                    nexusDirect: options.nexusDirect,
                    collectionId,
                });
                // 建任务成功：清单行标 queued，Collection 页据此显示“待处理→已建任务”。
                await updateCollectionPendingItem(pending.id, item.modId, item.fileId, "queued");
                result.successCount += 1;
            } catch (error: unknown) {
                const reason =
                    error instanceof Error ? error.message : "下载建任务失败。";
                // 建任务失败：清单行标 failed + 原因，页面可勾选重试。
                await updateCollectionPendingItem(pending.id, item.modId, item.fileId, "failed", reason);
                result.failedCount += 1;
                result.failedFiles.push({ name: item.name, reason });
            }
        }));
        // 批间间隔：给 Nexus API 限流留气口，最后一批不等。
        if (batchInterval > 0 && i + batchSize < selected.length) {
            await new Promise((resolve) => setTimeout(resolve, batchInterval));
        }
    }

    return result;
}
