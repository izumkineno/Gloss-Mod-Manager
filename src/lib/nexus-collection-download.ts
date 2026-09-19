// NexusMods Collection 下载编排：revision 选择 → 文件清单 → 勾选 → 逐个建任务。
// 文件解析复用单文件下载链路（fetchThirdPartyModDetail + queueThirdPartyModDownload），
// 因此每个文件都会走已有的去重/直链/回退逻辑。
import {
    buildMinimalNexusModDetail,
    type INexusModsDirectOptions,
} from "@/lib/third-party-mod-api";
import { queueThirdPartyModDownload } from "@/lib/third-party-download-queue";
import {
    fetchNexusCollectionFiles,
    fetchNexusCollectionInfo,
    type INexusCollectionFile,
} from "@/lib/nexus-collection-api";
import { useDownloadFilePickerStore } from "@/stores/download-picker";
import { useGlobalLoadingStore } from "@/stores/global-loading";
import {
    saveCollectionPending,
    updateCollectionPendingItem,
} from "@/lib/nexus-collection-pending";

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

    // 勾选结果先落盘为待下载清单，再逐个建任务；中断后可在下载页继续处理。
    const pending = await saveCollectionPending({
        gameDomain: options.gameDomain,
        slug: options.slug,
        revision: revision as number,
        name: info.name,
        game: options.game,
        gameName: options.gameName,
        items: selected.map((item) => ({ ...item, status: "pending" })),
    });
    // 逐文件走单文件链路：查详情拿真实 fileName，再建任务（自带去重/直链）。
    const result: IQueueNexusCollectionResult = {
        successCount: 0,
        failedCount: 0,
        failedFiles: [],
    };

    for (const item of selected) {
        try {
            // collection 已知 modId/fileId：直调直链，跳过 files 清单接口。
            // files.json 对部分 mod 返回 403 Mod not available（API 不可见但网页可下），
            // 走详情链必死；构造最小 detail 直调 resolve（cookie 直连/免费 key 回退逻辑不变）。
            const mod = buildMinimalNexusModDetail(options.gameDomain, item.modId, item.fileId, item.name, item.version);
            await queueThirdPartyModDownload({
                provider: "NexusMods",
                mod,
                fileId: item.fileId,
                gameName: options.gameName,
                managerModList: options.managerModList,
                nexusUser: options.nexusUser,
                nexusDirect: options.nexusDirect,
                collectionId: pending.id,
            });
            await updateCollectionPendingItem(
                pending.id,
                item.modId,
                item.fileId,
                "queued",
            );
            result.successCount += 1;
        } catch (error: unknown) {
            const reason =
                error instanceof Error ? error.message : "下载建任务失败。";
            await updateCollectionPendingItem(
                pending.id,
                item.modId,
                item.fileId,
                "failed",
                reason,
            );
            result.failedCount += 1;
            result.failedFiles.push({ name: item.name, reason });
        }
    }

    return result;
}
