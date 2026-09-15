import { subscribeDownloadTaskEvents } from "@/lib/download-task-events";
import { ElMessage } from "element-plus-message";
import { Downloader } from "@/lib/native-downloader";
import type { IDownloaderTask } from "@/lib/download-task-types";
import { FileHandler } from "@/lib/FileHandler";
import {
    findGlossDuplicateLocalMods,
    type IGlossDownloadTaskMeta,
} from "@/lib/gloss-download";
import { resolveGlossDownloadImportSourceType } from "@/lib/gloss-download-queue";
import {
    importLocalModSources,
    type ILocalModImportSource,
} from "@/lib/local-mod-import";
import { mergeDownloadTaskSnapshots } from "@/lib/download-task-cache";
import { PersistentStore } from "@/lib/persistent-store";
import { useManager } from "@/stores/manager";

interface IGlossDownloadMonitorSettings {
    autoAddAfterDownload: boolean;
    storagePath: string;
    closeSoftLinks: boolean;
}

interface ITaskMetaSyncResult {
    changed: boolean;
    nextTaskMetaMap: Record<string, IGlossDownloadTaskMeta>;
    newlyCompletedTaskGids: string[];
}

const DOWNLOAD_TASK_META_KEY = "aria2TaskMetaMap";
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
    return (
        (await PersistentStore.get<Record<string, IGlossDownloadTaskMeta>>(
            DOWNLOAD_TASK_META_KEY,
            {},
        )) ?? {}
    );
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

    await PersistentStore.set(DOWNLOAD_TASK_META_KEY, {
        ...taskMetaMap,
        [gid]: {
            ...currentMeta,
            ...metadata,
        },
    });
}

function syncTaskMetaStatuses(
    taskMetaMap: Record<string, IGlossDownloadTaskMeta>,
    tasks: IDownloaderTask[],
): ITaskMetaSyncResult {
    const nextTaskMetaMap = { ...taskMetaMap };
    const newlyCompletedTaskGids: string[] = [];
    let changed = false;

    for (const task of tasks) {
        const currentMeta = nextTaskMetaMap[task.gid];

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
            nextTaskMetaMap[task.gid] = nextMeta;
            changed = true;
        }
    }

    return {
        changed,
        nextTaskMetaMap,
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

        try {
            await manager.refreshRuntimeData({
                storagePath: settings.storagePath,
                closeSoftLinks: settings.closeSoftLinks,
            });

            if (!manager.managerGame || !manager.managerRoot) {
                continue;
            }

            const primaryFile = getTaskPrimaryFile(task);

            if (!primaryFile?.path) {
                continue;
            }

            if (!(await FileHandler.fileExists(primaryFile.path))) {
                continue;
            }

            const importMetadata = {
                modName:
                    metadata.modTitle ||
                    metadata.resourceName ||
                    getBaseName(primaryFile.path),
                fileName: metadata.fileName || getBaseName(primaryFile.path),
                modVersion: metadata.version || "1.0.0",
                modAuthor: metadata.author || "",
                modWebsite: metadata.sourceUrl || "",
                modDesc: metadata.content || "",
                cover: metadata.cover,
                from: getTaskSourceType(metadata),
                webId: getTaskExternalId(metadata),
                gameID: manager.managerGame.GlossGameId,
                other: {
                    downloadTaskGid: task.gid,
                    sourceUrl: metadata.sourceUrl || "",
                },
            };
            const duplicateLocalMods = findGlossDuplicateLocalMods(
                manager.managerModList,
                {
                    sourceType: getTaskSourceType(metadata),
                    externalId: getTaskExternalId(metadata),
                    modId: metadata.modId,
                    fileName: importMetadata.fileName,
                    modTitle: importMetadata.modName,
                },
            );
            const overwriteTargetMod =
                metadata.replaceLocalModId !== undefined
                    ? (duplicateLocalMods.find((item) => {
                          return (
                              Number(item.mod.id) ===
                              Number(metadata.replaceLocalModId)
                          );
                      })?.mod ?? null)
                    : null;

            const importSource: ILocalModImportSource = {
                path: primaryFile.path,
                sourceType: await resolveGlossDownloadImportSourceType(
                    primaryFile.path,
                    metadata,
                ),
                metadata: importMetadata,
            };

            if (duplicateLocalMods.length > 0) {
                if (overwriteTargetMod) {
                    importSource.duplicateStrategy = "overwrite";
                    importSource.targetMod = overwriteTargetMod;
                } else {
                    const targetLocalMod = duplicateLocalMods[0].mod;

                    await updateTaskMeta(gid, {
                        localModId: targetLocalMod.id,
                        importedAt: new Date().toISOString(),
                    });
                    continue;
                }
            }

            const result = await importLocalModSources([importSource]);
            const importedMod = result.importedMods[0];

            if (!importedMod) {
                continue;
            }

            await updateTaskMeta(gid, {
                localModId: importedMod.id,
                importedAt: new Date().toISOString(),
            });

            if (overwriteTargetMod) {
                ElMessage.success(`已自动更新本地 Mod：${importedMod.modName}`);
                continue;
            }

            ElMessage.success(`已自动导入到管理器：${importedMod.modName}`);
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
        // 先占位防并发重入，失败时回滚并释放已订阅的 listener。
        GlossDownloadMonitor.eventsSubscribed = true;
        // 事件只做触发器：收到后拉一次快照（数据源仍是快照，丢事件由慢轮询兜底）。
        try {
            GlossDownloadMonitor.eventRelease = await subscribeDownloadTaskEvents(
                () => {
                    void GlossDownloadMonitor.refresh();
                },
            );
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

            const [activeTasks, waitingTasks, stoppedTasks] = await Promise.all(
                [
                    Downloader.tellActive(),
                    Downloader.tellWaiting(0, 100),
                    Downloader.tellStopped(0, 100),
                ],
            );
            const liveTasks = [
                ...activeTasks,
                ...waitingTasks,
                ...stoppedTasks,
            ];
            const allTasks = await mergeDownloadTaskSnapshots(
                liveTasks,
                taskMetaMap,
                await Downloader.resolveDownloadDirectory(),
            );
            const syncResult = syncTaskMetaStatuses(taskMetaMap, allTasks);

            if (syncResult.changed) {
                await PersistentStore.set(
                    DOWNLOAD_TASK_META_KEY,
                    syncResult.nextTaskMetaMap,
                );
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
