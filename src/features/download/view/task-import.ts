// 本地导入编排（Wave 3.6 机械抽取）：单任务导入/无弹窗导入/批量导入。
// 与 download.vue 原实现逐行一致，只挪位置；FOMOD 向导与导入源构造保持原样。
import { ref } from "vue";
import { ElMessage } from "element-plus-message";
import { FileHandler } from "@/lib/FileHandler";
import { findGlossDuplicateLocalMods } from "@/lib/gloss-download";
import type { IGlossDownloadTaskMeta } from "@/lib/gloss-download";
import { importLocalModSources } from "@/lib/local-mod-import";
import type { ILocalModImportSource } from "@/lib/local-mod-import";
import { getTaskPrimaryFile } from "./format";
import { getBaseName, getErrorMessage, getTaskDisplayName } from "./task-display";
import type { DuplicateDecisionAction } from "./dedupe";
import type { IDownloaderTask } from "../types";
import { resolveGlossDownloadImportSourceType } from "../meta/import-source";

// 任务来源类型：meta.sourceType 优先，有 modId 视为 GlossMod，其余为手动添加。
export function getTaskSourceType(
    metadata?: IGlossDownloadTaskMeta | null,
): sourceType {
    return metadata?.sourceType ?? (metadata?.modId ? "GlossMod" : "Customize");
}

// 外部 ID：externalId 优先，其次 modId。
export function getTaskExternalId(metadata?: IGlossDownloadTaskMeta | null): string | number | undefined {
    return metadata?.externalId ?? metadata?.modId;
}

export interface ImportDeps {
    manager: {
        managerGame: { GlossGameId: number } | null;
        managerRoot: string;
        managerModList: IModInfo[];
        refreshRuntimeData: (args: { storagePath: string; closeSoftLinks: boolean }) => Promise<void>;
    };
    storagePath: string;
    closeSoftLinks: boolean;
    taskMetaMap: Record<string, IGlossDownloadTaskMeta>;
    setTaskMeta: (gid: string, metadata: IGlossDownloadTaskMeta) => void;
    selectedTask: IDownloaderTask | null;
    canImportToLocalManager: boolean;
    allTasks: IDownloaderTask[];
    promptDuplicateDecision: (options: {
        title: string;
        description: string;
        note?: string;
        items: Array<{ title: string; description: string; badges: string[] }>;
        actions: Array<{ value: DuplicateDecisionAction; label: string; description: string; variant?: "default" | "outline" | "destructive" }>;
    }) => Promise<DuplicateDecisionAction>;
    startWizard: (config: never) => Promise<never>;
}

// 导入进行态（模板按钮 loading/disabled 用）。
export interface TaskImportState {
    taskImportingIds: { value: string[] };
    startTaskImport: (gid: string) => void;
    finishTaskImport: (gid: string) => void;
    isTaskImporting: (gid: string) => boolean;
}

// 导入进行态工厂（模板按钮 loading/disabled 用）。
export function useTaskImportState(): TaskImportState {
    const taskImportingIds = ref<string[]>([]);

    function startTaskImport(gid: string): void {
        if (taskImportingIds.value.includes(gid)) {
            return;
        }

        taskImportingIds.value = [...taskImportingIds.value, gid];
    }

    function finishTaskImport(gid: string): void {
        taskImportingIds.value = taskImportingIds.value.filter(
            (item) => item !== gid,
        );
    }

    function isTaskImporting(gid: string): boolean {
        return taskImportingIds.value.includes(gid);
    }

    return { taskImportingIds, startTaskImport, finishTaskImport, isTaskImporting };
}

// 无弹窗导入内核：命中本地重复（score>=100 身份重复）即自动跳过并回填 localModId；返回 skipped/imported 供批量汇总。
export async function importSingleTaskHeadless(
    targetTask: IDownloaderTask,
    deps: ImportDeps,
): Promise<"skipped" | "imported"> {
    await deps.manager.refreshRuntimeData({
        storagePath: deps.storagePath,
        closeSoftLinks: deps.closeSoftLinks,
    });
    if (!deps.manager.managerGame || !deps.manager.managerRoot) {
        throw new Error("请先选择游戏并配置储存路径。");
    }
    const primaryFile = getTaskPrimaryFile(targetTask);
    if (!primaryFile?.path) {
        throw new Error("当前任务没有可导入的文件。");
    }
    if (!(await FileHandler.fileExists(primaryFile.path))) {
        throw new Error("下载文件不存在，请先检查输出目录。");
    }
    const metadata = deps.taskMetaMap[targetTask.gid] ?? null;
    const importMetadata = {
        modName:
            metadata?.modTitle ||
            metadata?.resourceName ||
            getTaskDisplayName(targetTask, metadata),
        fileName: metadata?.fileName || getBaseName(primaryFile.path),
        modVersion: metadata?.version || "1.0.0",
        modAuthor: metadata?.author || "",
        modWebsite: metadata?.sourceUrl || "",
        modDesc: metadata?.content || "",
        cover: metadata?.cover,
        from: getTaskSourceType(metadata),
        webId: getTaskExternalId(metadata),
        gameID: deps.manager.managerGame.GlossGameId,
        other: {
            downloadTaskGid: targetTask.gid,
            sourceUrl: metadata?.sourceUrl || "",
        },
    };
    // 自动跳过：身份级重复（webId/外部 id 命中）直接沿用本地条目，不弹窗。
    const duplicateLocalMods = findGlossDuplicateLocalMods(
        deps.manager.managerModList,
        {
            sourceType: getTaskSourceType(metadata),
            externalId: getTaskExternalId(metadata),
            modId: metadata?.modId,
            fileName: importMetadata.fileName,
            modTitle: importMetadata.modName,
        },
    );
    const identityDuplicate = duplicateLocalMods.find((item) => item.score >= 100) ?? null;
    if (identityDuplicate) {
        deps.setTaskMeta(targetTask.gid, {
            ...(metadata ?? {}),
            localModId: identityDuplicate.mod.id,
            importedAt: new Date().toISOString(),
        });
        return "skipped";
    }
    const importSource: ILocalModImportSource = {
        path: primaryFile.path,
        sourceType: await resolveGlossDownloadImportSourceType(
            primaryFile.path,
            metadata,
        ),
        metadata: importMetadata,
        // FOMOD 压缩包走安装向导选分支。
        fomodSelection: (config) => deps.startWizard(config as never) as never,
    };
    const result = await importLocalModSources([importSource]);
    const importedMod = result.importedMods[0];
    if (!importedMod) {
        throw new Error("没有导入任何 Mod，请检查下载文件内容。");
    }
    deps.setTaskMeta(targetTask.gid, {
        ...(metadata ?? {}),
        localModId: importedMod.id,
        importedAt: new Date().toISOString(),
    });
    return "imported";
}

// 单任务导入（含重复弹窗决策：继续/覆盖/同时存在）。
export async function importTaskToLocalManager(
    task: IDownloaderTask | null | undefined,
    deps: ImportDeps,
    importState: ReturnType<typeof useTaskImportState>,
): Promise<void> {
    const targetTask = task ?? deps.selectedTask;

    if (!targetTask) {
        return;
    }

    if (targetTask.status !== "complete") {
        ElMessage.warning("请先等待任务下载完成。");
        return;
    }

    importState.startTaskImport(targetTask.gid);

    try {
        await deps.manager.refreshRuntimeData({
            storagePath: deps.storagePath,
            closeSoftLinks: deps.closeSoftLinks,
        });

        if (!deps.manager.managerGame || !deps.manager.managerRoot) {
            throw new Error("请先选择游戏并配置储存路径。");
        }

        const primaryFile = getTaskPrimaryFile(targetTask);

        if (!primaryFile?.path) {
            throw new Error("当前任务没有可导入的文件。");
        }

        if (!(await FileHandler.fileExists(primaryFile.path))) {
            throw new Error("下载文件不存在，请先检查输出目录。");
        }

        const metadata = deps.taskMetaMap[targetTask.gid] ?? null;
        const importMetadata = {
            modName:
                metadata?.modTitle ||
                metadata?.resourceName ||
                getTaskDisplayName(targetTask, metadata),
            fileName: metadata?.fileName || getBaseName(primaryFile.path),
            modVersion: metadata?.version || "1.0.0",
            modAuthor: metadata?.author || "",
            modWebsite: metadata?.sourceUrl || "",
            modDesc: metadata?.content || "",
            cover: metadata?.cover,
            from: getTaskSourceType(metadata),
            webId: getTaskExternalId(metadata),
            gameID: deps.manager.managerGame.GlossGameId,
            other: {
                downloadTaskGid: targetTask.gid,
                sourceUrl: metadata?.sourceUrl || "",
            },
        };
        const importSource: ILocalModImportSource = {
            path: primaryFile.path,
            sourceType: await resolveGlossDownloadImportSourceType(
                primaryFile.path,
                metadata,
            ),
            metadata: importMetadata,
            // FOMOD 压缩包走安装向导选分支。
            fomodSelection: (config) => deps.startWizard(config as never) as never,
        };
        const duplicateLocalMods = findGlossDuplicateLocalMods(
            deps.manager.managerModList,
            {
                sourceType: getTaskSourceType(metadata),
                externalId: getTaskExternalId(metadata),
                modId: metadata?.modId,
                fileName: importMetadata.fileName,
                modTitle: importMetadata.modName,
            },
        ).sort((left, right) => {
            if (
                metadata?.localModId &&
                Number(left.mod.id) === Number(metadata.localModId)
            ) {
                return -1;
            }

            if (
                metadata?.localModId &&
                Number(right.mod.id) === Number(metadata.localModId)
            ) {
                return 1;
            }

            return right.score - left.score;
        });

        if (duplicateLocalMods.length > 0) {
            const targetLocalMod = duplicateLocalMods[0].mod;
            const decision = await deps.promptDuplicateDecision({
                title: "发现重复的本地 Mod",
                description: `${importMetadata.modName} 已经存在于本地管理器中。`,
                note: `继续会保留当前本地条目 #${targetLocalMod.id}；覆盖会替换该条目的文件；同时存在会新建一个本地条目。`,
                items: duplicateLocalMods.map((item) => ({
                    title: `${item.mod.modName} #${item.mod.id}`,
                    description:
                        item.mod.modDesc ||
                        item.mod.fileName ||
                        "已有本地 Mod 记录",
                    badges: [
                        item.reason,
                        item.mod.modVersion || "未知版本",
                        item.mod.fileName,
                    ].filter(Boolean),
                })),
                actions: [
                    {
                        value: "cancel",
                        label: "取消",
                        description: "保持当前本地管理器不变。",
                        variant: "outline",
                    },
                    {
                        value: "continue",
                        label: "继续",
                        description: "沿用当前最接近的本地条目。",
                    },
                    {
                        value: "overwrite",
                        label: "覆盖",
                        description: "用新下载的内容替换现有本地条目。",
                        variant: "destructive",
                    },
                    {
                        value: "keep-both",
                        label: "同时存在",
                        description: "保留旧条目，同时新增一个本地条目。",
                        variant: "outline",
                    },
                ],
            });

            if (decision === "cancel") {
                ElMessage.info("已取消重复导入。");
                return;
            }

            if (decision === "continue") {
                deps.setTaskMeta(targetTask.gid, {
                    ...(metadata ?? {}),
                    localModId: targetLocalMod.id,
                    importedAt: new Date().toISOString(),
                });
                ElMessage.success(
                    `已保留现有本地 Mod：${targetLocalMod.modName}`,
                );
                return;
            }

            if (decision === "overwrite") {
                importSource.duplicateStrategy = "overwrite";
                importSource.targetMod = targetLocalMod;
            }
        }

        const result = await importLocalModSources([importSource]);
        const importedMod = result.importedMods[0];

        if (!importedMod) {
            throw new Error("没有导入任何 Mod，请检查下载文件内容。");
        }

        deps.setTaskMeta(targetTask.gid, {
            ...(metadata ?? {}),
            localModId: importedMod.id,
            importedAt: new Date().toISOString(),
        });
        ElMessage.success(`已导入到本地管理器：${importedMod.modName}`);
    } catch (error: unknown) {
        ElMessage.error(getErrorMessage(error));
    } finally {
        importState.finishTaskImport(targetTask.gid);
    }
}

// 批量导入全部：仅 complete 且未导入（无 localModId）的任务；身份重复自动跳过（回填 localModId），最后汇总。
export async function importAllCompletedTasks(
    deps: ImportDeps,
    importState: ReturnType<typeof useTaskImportState>,
): Promise<void> {
    if (!deps.canImportToLocalManager) {
        ElMessage.warning("请先选择游戏并配置储存路径。");
        return;
    }
    const todo = deps.allTasks.filter((task) => task.status === "complete" && deps.taskMetaMap[task.gid]?.localModId == null);
    if (todo.length === 0) {
        ElMessage.info("没有可导入的已完成任务（其余已导入或未完成）。");
        return;
    }
    let imported = 0;
    let skipped = 0;
    let failed = 0;
    for (const task of todo) {
        if (importState.isTaskImporting(task.gid)) continue;
        importState.startTaskImport(task.gid);
        try {
            const result = await importSingleTaskHeadless(task, deps);
            if (result === "skipped") skipped += 1;
            else imported += 1;
        } catch (error: unknown) {
            failed += 1;
            console.error(`批量导入失败 ${getTaskDisplayName(task, deps.taskMetaMap[task.gid])}：`, error);
        } finally {
            importState.finishTaskImport(task.gid);
        }
    }
    ElMessage.success(`批量导入完成：新增 ${imported} 个，跳过重复 ${skipped} 个，失败 ${failed} 个。`);
}
