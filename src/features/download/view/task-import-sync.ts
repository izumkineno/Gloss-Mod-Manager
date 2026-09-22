// 导入态刷新（后端版）：条目一次传给后端 mod_import_sync_status，读本地 mod.json 算 diff，
// 前端只按 changes 写回 download_meta。esar以前逐个 findGlossDuplicateLocalMods + refreshRuntimeData，
// 现在 1 次 invoke + N 次 meta 写回（仅改动项），大列表从 O(N×M) 前端循环降为后端一次 scan。
import { ElMessage } from "element-plus-message";
import { backendImportSyncStatus } from "@/lib/backend-import";
import { saveDownloadMetaMap } from "@/lib/download-meta";
import type { IGlossDownloadTaskMeta } from "@/lib/gloss-download";
import type { IDownloaderTask } from "../types";

export interface ImportSyncDeps {
    allTasks: IDownloaderTask[];
    taskMetaMap: Record<string, IGlossDownloadTaskMeta>;
    setTaskMeta: (gid: string, metadata: IGlossDownloadTaskMeta) => unknown;
    refreshTaskLists: (silent?: boolean) => Promise<void>;
    managerRoot: string;
}

export interface ImportSyncResult {
    fixedImported: number;
    fixedUnimported: number;
}

// 刷新全部已完成任务的导入态：后端对账→前端按改动写回。
export async function refreshImportStatus(deps: ImportSyncDeps): Promise<ImportSyncResult> {
    const started = Date.now();
    // 只传 complete 任务：未完成任务的导入态无意义，减少传输。
    const entries = deps.allTasks
        .filter((task) => task.status === "complete")
        .map((task) => {
            const meta = deps.taskMetaMap[task.gid];
            return {
                gid: task.gid,
                localModId: meta?.localModId,
                sourceType: meta?.sourceType,
                externalId: meta?.externalId ?? meta?.modId,
                modId: meta?.modId,
                fileName: meta?.fileName,
                modTitle: meta?.modTitle,
            };
        })
        .filter((entry) => deps.taskMetaMap[entry.gid]);
    console.debug(`[导入] 对账请求：complete任务=${entries.length} 全部=${deps.allTasks.length}`);
    const result = await backendImportSyncStatus(deps.managerRoot, entries);
    // meta 写回攒一批一次落盘：逐个 dl_meta_put 是 N 次读写 + 全量对象展开，大列表直接卡十几秒。
    const merged: Record<string, IGlossDownloadTaskMeta> = { ...deps.taskMetaMap };
    for (const change of result.changes) {
        const meta = merged[change.gid];
        if (!meta) continue;
        if (change.action === "to-unimported") {
            merged[change.gid] = { ...meta, localModId: undefined, importedAt: undefined };
        } else if (change.action === "to-imported" && change.hitModId != null) {
            merged[change.gid] = { ...meta, localModId: change.hitModId, importedAt: new Date().toISOString() };
        }
    }
    if (result.changes.length > 0) {
        // 后端一次落盘；前端内存直接同步（不再走 async setTaskMeta，避免 N 次重复 put）。
        await saveDownloadMetaMap(merged);
        for (const change of result.changes) {
            const next = merged[change.gid];
            if (next) deps.taskMetaMap[change.gid] = next;
        }
    }
    await deps.refreshTaskLists(true);
    const parts: string[] = [];
    if (result.fixedImported > 0) parts.push(`标已导入 ${result.fixedImported} 个`);
    if (result.fixedUnimported > 0) parts.push(`打回未导入 ${result.fixedUnimported} 个`);
    console.debug(`[导入] 对账写回完成：改动=${result.changes.length} 后端耗时=${result.elapsedMs}ms 前端总耗时=${Date.now() - started}ms`);
    if (parts.length > 0) ElMessage.success(`导入状态已刷新：${parts.join("，")}（后端${result.elapsedMs}ms）。`);
    else ElMessage.info("导入状态已是最新，无需改动。");
    return { fixedImported: result.fixedImported, fixedUnimported: result.fixedUnimported };
}
