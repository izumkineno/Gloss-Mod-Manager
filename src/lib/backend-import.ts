// 后端导入桥：invoke 后端 mod_import_* 命令的类型定义与薄封装。
// 前端不再做解压/复制/walk/mod.json 读写，只做 FOMOD 弹窗 + download_meta 写回。
import { invoke } from "@tauri-apps/api/core";

export interface BackendImportSource {
    path: string;
    sourceType: string;
    fileName?: string;
}

export interface BackendImportMetadata {
    modName?: string;
    fileName?: string;
    modVersion?: string;
    modAuthor?: string;
    modWebsite?: string;
    modDesc?: string;
    cover?: string;
    from?: string;
    webId?: string | number;
    gameID?: unknown;
    modType?: unknown;
    tags?: unknown[];
    other?: unknown;
    externalId?: string | number;
    modId?: string | number;
}

export interface BackendImportPrepareResult {
    stagingDir: string;
    modId: number;
    targetDir: string;
    files: string[];
    fileCount: number;
    fomodXml: string | null;
    elapsedMs: number;
}

export interface BackendImportCommitResult {
    modId: number;
    modName: string;
    fileCount: number;
    elapsedMs: number;
}

export interface BackendImportTaskResult {
    modId: number;
    modName: string;
    fileCount: number;
    needFomod: boolean;
    stagingDir: string | null;
    targetDir: string | null;
    fomodXml: string | null;
    elapsedMs: number;
}

export interface BackendImportSyncEntry {
    gid: string;
    localModId?: number;
    sourceType?: string;
    externalId?: string | number;
    modId?: string | number;
    fileName?: string;
    modTitle?: string;
}

export interface BackendImportSyncResult {
    changes: Array<{ gid: string; action: string; hitModId?: number }>;
    fixedImported: number;
    fixedUnimported: number;
    elapsedMs: number;
}

// 准备阶段：清暂存→解压/复制→walk 清单→探 FOMOD。后端日志 tag=[导入]。
export function backendImportPrepare(
    managerRoot: string,
    source: BackendImportSource,
    overwriteModId?: number,
): Promise<BackendImportPrepareResult> {
    return invoke<BackendImportPrepareResult>("mod_import_prepare", {
        managerRoot,
        source: {
            path: source.path,
            sourceType: source.sourceType,
            fileName: source.fileName ?? null,
        },
        overwriteModId: overwriteModId ?? null,
    });
}

// 提交阶段：FOMOD 裁剪→落盘→写 mod.json。
export function backendImportCommit(
    stagingDir: string,
    modId: number,
    targetDir: string,
    managerRoot: string,
    metadata: BackendImportMetadata,
    overwrite: boolean,
    fomodSelected: string[],
): Promise<BackendImportCommitResult> {
    return invoke<BackendImportCommitResult>("mod_import_commit", {
        req: {
            stagingDir,
            modId,
            targetDir,
            managerRoot,
            metadata,
            overwrite,
            fomodSelected,
        },
    });
}
export interface BackendImportDuplicateMatch {
    modData: Record<string, unknown>;
    reason: string;
    score: number;
}

// 判重查询：后端读 mod.json 打分，前端弹窗用（替代前端 findGlossDuplicateLocalMods 全量循环）。
export function backendImportDuplicates(
    managerRoot: string,
    criteria: {
        sourceType?: string;
        externalId?: string | number;
        modId?: string | number;
        fileName?: string;
        modTitle?: string;
    },
): Promise<BackendImportDuplicateMatch[]> {
    return invoke<BackendImportDuplicateMatch[]>("mod_import_duplicates", {
        req: { managerRoot, ...criteria },
    });
}

// 下载任务一键导入：无 FOMOD 一次搞定，有则返回 needFomod 走弹窗。
export function backendImportTask(
    filePath: string,
    sourceType: string,
    managerRoot: string,
    metadata: BackendImportMetadata,
    overwriteModId?: number,
): Promise<BackendImportTaskResult> {
    return invoke<BackendImportTaskResult>("mod_import_task", {
        req: {
            filePath,
            sourceType,
            managerRoot,
            metadata,
            overwriteModId: overwriteModId ?? null,
        },
    });
}

export interface BackendImportBatchItem {
    gid: string;
    filePath: string;
    sourceType: string;
    metadata: BackendImportMetadata;
}

export interface BackendImportBatchItemResult {
    gid: string;
    ok: boolean;
    modId?: number | null;
    fileCount?: number | null;
    error?: string | null;
}

// 批量任务导入：一次 invoke，后端 ID 预分配 + 并行解压落盘 + 单次合并写 mod.json。
export function backendImportBatch(
    managerRoot: string,
    items: BackendImportBatchItem[],
    typeRules: unknown[] = [],
): Promise<BackendImportBatchItemResult[]> {
    return invoke<BackendImportBatchItemResult[]>("mod_import_batch", {
        req: { managerRoot, items, typeRules },
    });
}

// 导入态对账：后端读 mod.json 算 diff，前端按 changes 写回 download_meta。
export function backendImportSyncStatus(
    managerRoot: string,
    entries: BackendImportSyncEntry[],
): Promise<BackendImportSyncResult> {
    return invoke<BackendImportSyncResult>("mod_import_sync_status", {
        req: { managerRoot, entries },
    });
}
