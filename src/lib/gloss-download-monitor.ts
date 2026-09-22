import { ElMessage } from "element-plus-message";

import type { IDownloaderTask } from "@/features/download/types";
import { FileHandler } from "@/lib/FileHandler";
import type { IGlossDownloadTaskMeta } from "@/lib/gloss-download";
import { backendImportCommit, backendImportDuplicates, backendImportTask } from "@/lib/backend-import";
import { resolveGlossDownloadImportSourceType } from "@/features/download/meta/import-source";
import { useManager } from "@/stores/manager";
import { listDownloadMeta, putDownloadMeta } from "@/lib/download-meta";

interface IGlossDownloadMonitorSettings {
    autoAddAfterDownload: boolean;
    storagePath: string;
    closeSoftLinks: boolean;
}

interface ITaskMetaSyncResult {
    changedEntries: Array<{ gid: string; meta: IGlossDownloadTaskMeta }>;
    newlyCompletedTaskGids: string[];
}

// 事件驱动为主（dl-progress/dl-task-changed 触发 refresh）；60s 兜底只防“完成事件丢失导致永不导入”。
const POLL_INTERVAL_MS = 60000;
const importingTaskGids = new Set<string>();

function getTaskSourceType(metadata?: IGlossDownloadTaskMeta): sourceType {
    return metadata?.sourceType ?? (metadata?.modId ? "GlossMod" : "Customize");
}

function getTaskExternalId(metadata?: IGlossDownloadTaskMeta) {
    return metadata?.externalId ?? metadata?.modId;
}

function getTaskPrimaryFile(task: IDownloaderTask) {
    return task.files.find((item) => item.path) ?? task.files[0] ?? null;
}

function getBaseName(filePath?: string) {
    if (!filePath) {
        return "";
    }

    return filePath.split(/[\\/]+/u).pop() ?? filePath;
}

async function readTaskMetaMap() {
    return listDownloadMeta();
}

async function updateTaskMeta(
    gid: string,
    metadata: Partial<IGlossDownloadTaskMeta>,
) {
    const taskMetaMap = await readTaskMetaMap();
    const currentMeta = taskMetaMap[gid];

    if (!currentMeta) {
        return;
    }

    await putDownloadMeta(gid, {
        ...currentMeta,
        ...metadata,
    });
}

function syncTaskMetaStatuses(
    taskMetaMap: Record<string, IGlossDownloadTaskMeta>,
    tasks: IDownloaderTask[],
): ITaskMetaSyncResult {
    // 只收集真正变化的条目，由调用方逐键 putDownloadMeta 落盘：
    // 整表覆盖在并发建任务窗口会用旧快照洗掉新写入的 meta（任务名回退 uuid 的根因之一）。
    const changedEntries: Array<{ gid: string; meta: IGlossDownloadTaskMeta }> = [];
    const newlyCompletedTaskGids: string[] = [];

    for (const task of tasks) {
        const currentMeta = taskMetaMap[task.gid];

        if (!currentMeta) {
            continue;
        }

        const nextMeta: IGlossDownloadTaskMeta = {
            ...currentMeta,
            createdAt:
                currentMeta.createdAt ||
                currentMeta.downloadedAt ||
                currentMeta.importedAt ||
                currentMeta.updatedAt ||
                new Date().toISOString(),
            taskStatus: task.status as TaskStatus,
            updatedAt: new Date().toISOString(),
        };

        if (
            task.status === "complete" &&
            currentMeta.taskStatus !== "complete"
        ) {
            newlyCompletedTaskGids.push(task.gid);
        }

        if (task.status === "complete" && !currentMeta.downloadedAt) {
            nextMeta.downloadedAt = new Date().toISOString();
        }

        if (
            nextMeta.createdAt !== currentMeta.createdAt ||
            nextMeta.taskStatus !== currentMeta.taskStatus ||
            nextMeta.downloadedAt !== currentMeta.downloadedAt
        ) {
            changedEntries.push({ gid: task.gid, meta: nextMeta });
        }
    }

    return {
        changedEntries,
        newlyCompletedTaskGids,
    };
}

export async function autoImportCompletedDownloadTasks(
    settings: IGlossDownloadMonitorSettings,
    completedTaskGids: string[],
    tasks: IDownloaderTask[],
) {
    const manager = useManager();

    if (!settings.autoAddAfterDownload || completedTaskGids.length === 0) {
        return;
    }

    if (!settings.storagePath || !manager.managerGame) {
        return;
    }

    for (const gid of completedTaskGids) {
        if (importingTaskGids.has(gid)) {
            continue;
        }

        const task = tasks.find((item) => item.gid === gid);
        const taskMetaMap = await readTaskMetaMap();
        const metadata = taskMetaMap[gid];

        if (
            !task ||
            !metadata ||
            metadata.localModId ||
            task.status !== "complete"
        ) {
            continue;
        }

        importingTaskGids.add(gid);

        const started = Date.now();
        try {
            if (!manager.managerGame || !manager.managerRoot) {
                continue;
            }
            const primaryFile = getTaskPrimaryFile(task);
            if (!primaryFile?.path) continue;
            if (!(await FileHandler.fileExists(primaryFile.path))) continue;
            const modName = metadata.modTitle || metadata.resourceName || getBaseName(primaryFile.path);
            const fileName = metadata.fileName || getBaseName(primaryFile.path);
            const backendMeta = {
                modName,
                fileName,
                modVersion: metadata.version || "1.0.0",
                modAuthor: metadata.author || "",
                modWebsite: metadata.sourceUrl || "",
                modDesc: metadata.content || "",
                cover: metadata.cover,
                from: getTaskSourceType(metadata),
                webId: getTaskExternalId(metadata),
                gameID: manager.managerGame.GlossGameId,
                other: { downloadTaskGid: task.gid, sourceUrl: metadata.sourceUrl || "" },
            };
            // 判重走后端：命中身份重复直接回填跳过；replaceLocalModId 指定覆盖目标。
            const duplicates = await backendImportDuplicates(manager.managerRoot, {
                sourceType: getTaskSourceType(metadata),
                externalId: getTaskExternalId(metadata),
                modId: metadata.modId,
                fileName,
                modTitle: modName,
            });
            if (metadata.replaceLocalModId === undefined) {
                const hit = duplicates.find((item) => item.score >= 100) ?? null;
                if (hit && "id" in hit.modData && typeof hit.modData.id === "number") {
                    await updateTaskMeta(gid, { localModId: hit.modData.id, importedAt: new Date().toISOString() });
                    continue;
                }
            }
            const overwriteModId = metadata.replaceLocalModId !== undefined ? Number(metadata.replaceLocalModId) : undefined;
            const sourceType = await resolveGlossDownloadImportSourceType(primaryFile.path, metadata);
            const result = await backendImportTask(primaryFile.path, sourceType, manager.managerRoot, backendMeta, Number.isFinite(overwriteModId) ? overwriteModId : undefined);
            // 自动导入不弹窗：FOMOD 包按全量提交（prepare 已解压，直接 commit 全量）。
            let modId = result.modId;
            let modNameFinal = result.modName;
            if (result.needFomod && result.stagingDir && result.targetDir) {
                const committed = await backendImportCommit(result.stagingDir, result.modId, result.targetDir, manager.managerRoot, backendMeta, overwriteModId != null, []);
                modId = committed.modId;
                modNameFinal = committed.modName;
            }
            console.debug(`[导入] 自动导入完成：gid=${gid} modId=${modId} 后端耗时=${result.elapsedMs}ms 前端总耗时=${Date.now() - started}ms`);
            await updateTaskMeta(gid, { localModId: modId, importedAt: new Date().toISOString() });
            if (overwriteModId != null) {
                ElMessage.success(`已自动更新本地 Mod：${modNameFinal}`);
                continue;
            }
        } catch (error: unknown) {
            console.error("自动导入下载任务失败");
            console.error(error);
        } finally {
            importingTaskGids.delete(gid);
        }
    }
}

export class GlossDownloadMonitor {
    private static initialized = false;
    private static intervalId: ReturnType<
        typeof globalThis.setInterval
    > | null = null;
    private static refreshing = false;
    private static settings: IGlossDownloadMonitorSettings | null = null;
    private static eventRelease: (() => void) | null = null;
    private static eventsSubscribed = false;

    public static start(settings: IGlossDownloadMonitorSettings) {
        GlossDownloadMonitor.settings = settings;
        if (GlossDownloadMonitor.intervalId !== null) {
            return;
        }
        void GlossDownloadMonitor.subscribeEvents();
        void GlossDownloadMonitor.refresh();
        GlossDownloadMonitor.intervalId = globalThis.setInterval(() => {
            void GlossDownloadMonitor.refresh();
        }, POLL_INTERVAL_MS);
    }

    public static stop() {
        if (GlossDownloadMonitor.intervalId !== null) {
            globalThis.clearInterval(GlossDownloadMonitor.intervalId);
            GlossDownloadMonitor.intervalId = null;
        }
        GlossDownloadMonitor.eventRelease?.();
        GlossDownloadMonitor.eventRelease = null;
        GlossDownloadMonitor.eventsSubscribed = false;
    }

    private static async subscribeEvents() {
        if (GlossDownloadMonitor.eventsSubscribed) {
            return;
        }
        // Wave 3：订阅走 facade.subscribe（后端事件→投影机→快照推送）。
        GlossDownloadMonitor.eventsSubscribed = true;
        try {
            const { getDownloadFacade } = await import("@/features/download/facade");
            GlossDownloadMonitor.eventRelease = getDownloadFacade().subscribe(() => {
                void GlossDownloadMonitor.refresh();
            });
        } catch {
            GlossDownloadMonitor.eventsSubscribed = false;
        }
    }

    private static async refresh() {
        if (GlossDownloadMonitor.refreshing || !GlossDownloadMonitor.settings) {
            return;
        }

        GlossDownloadMonitor.refreshing = true;

        try {
            const taskMetaMap = await readTaskMetaMap();

            if (Object.keys(taskMetaMap).length === 0) {
                GlossDownloadMonitor.initialized = true;
                return;
            }

            // Wave 3：快照读 facade（单例投影），不再 tell/merge。
            const { getDownloadFacade } = await import("@/features/download/facade");
            const allTasks: IDownloaderTask[] = getDownloadFacade().snapshot().map((task) => ({
                gid: task.gid,
                status: task.status,
                files: [],
            }));
            const syncResult = syncTaskMetaStatuses(taskMetaMap, allTasks);
            // 逐键落盘：整表覆盖会洗掉并发链路（批量建任务/导入标记）刚写入的 meta。
            for (const entry of syncResult.changedEntries) {
                try {
                    await putDownloadMeta(entry.gid, entry.meta);
                } catch (error: unknown) {
                    console.error(`下载任务 meta 单键更新失败 gid=${entry.gid}`);
                    console.error(error);
                }
            }
            if (!GlossDownloadMonitor.initialized) {
                GlossDownloadMonitor.initialized = true;
            }
            await autoImportCompletedDownloadTasks(
                GlossDownloadMonitor.settings,
                syncResult.newlyCompletedTaskGids,
                allTasks,
            );
        } catch (error: unknown) {
            console.error("后台下载监控刷新失败");
            console.error(error);
        } finally {
            GlossDownloadMonitor.refreshing = false;
        }
    }
}

export function initializeGlossDownloadMonitor(
    settings: IGlossDownloadMonitorSettings,
) {
    GlossDownloadMonitor.start(settings);
}

export const autoImportCompletedGlossTasks = autoImportCompletedDownloadTasks;
