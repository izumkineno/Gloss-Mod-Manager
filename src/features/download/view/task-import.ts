// 本地导入编排（Wave 3.6 机械抽取）：单任务导入/无弹窗导入/批量导入。
// 与 download.vue 原实现逐行一致，只挪位置；FOMOD 向导与导入源构造保持原样。
import { ref } from "vue";
import { ElMessage } from "element-plus-message";
import { backendImportBatch, backendImportCommit, backendImportDuplicates, backendImportTask } from "@/lib/backend-import";
import type { BackendImportBatchItem } from "@/lib/backend-import";
import { saveDownloadMetaMap } from "@/lib/download-meta";
import { parseFomodConfig, resolveFomodInstallFiles } from "@/lib/fomod-parser";
import type { FomodConfig } from "@/lib/fomod-parser";
import { FileHandler } from "@/lib/FileHandler";
import type { IGlossDownloadTaskMeta } from "@/lib/gloss-download";
import { getTaskPrimaryFile } from "./format";
import { getBaseName, getErrorMessage, getTaskDisplayName } from "./task-display";
import type { DuplicateDecisionAction } from "./dedupe";
import type { IDownloaderTask } from "../types";
import { resolveGlossDownloadImportSourceType } from "../meta/import-source";
import { useManager } from "@/stores/manager";

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
    startWizard: (config: FomodConfig) => Promise<Set<string> | null>;
}

// 批量导入进度（按钮旁进度条用）：total/done/当前片。
export interface BatchImportProgress {
    total: number;
    done: number;
    running: boolean;
}

// 导入进行态（模板按钮 loading/disabled 用）。
export interface TaskImportState {
    taskImportingIds: { value: string[] };
    startTaskImport: (gid: string) => void;
    finishTaskImport: (gid: string) => void;
    isTaskImporting: (gid: string) => boolean;
    batchProgress: { value: BatchImportProgress };
}

// 导入进行态工厂（模板按钮 loading/disabled 用）。
export function useTaskImportState(): TaskImportState {
    const taskImportingIds = ref<string[]>([]);
    const batchProgress = ref<BatchImportProgress>({ total: 0, done: 0, running: false });

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

    return { taskImportingIds, startTaskImport, finishTaskImport, isTaskImporting, batchProgress };
}

// 无弹窗导入内核（后端版）：判重→导入全走后端命令；命中身份重复（score>=100）自动跳过回填 localModId。
// 返回 skipped/imported 供批量汇总。FOMOD 包在批量场景按默认全量文件导入（不弹窗）。
export async function importSingleTaskHeadless(
    targetTask: IDownloaderTask,
    deps: ImportDeps,
    options: { skipRefresh?: boolean } = {},
): Promise<"skipped" | "imported"> {
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
    const modName = metadata?.modTitle || metadata?.resourceName || getTaskDisplayName(targetTask, metadata);
    const fileName = metadata?.fileName || getBaseName(primaryFile.path);
    // 身份判重走后端（读 mod.json 打分），命中即跳过回填。
    const duplicates = await backendImportDuplicates(deps.manager.managerRoot, {
        sourceType: getTaskSourceType(metadata),
        externalId: getTaskExternalId(metadata),
        modId: metadata?.modId,
        fileName,
        modTitle: modName,
    });
    const identityDuplicate = duplicates.find((item) => item.score >= 100) ?? null;
    if (identityDuplicate) {
        const rawId = "id" in identityDuplicate.modData ? identityDuplicate.modData.id : undefined;
        const hitId = typeof rawId === "number" ? rawId : Number(rawId);
        if (!Number.isFinite(hitId)) throw new Error("判重命中但本地 Mod ID 非法。");
        const skipMeta = {
            ...(metadata ?? {}),
            localModId: hitId,
            importedAt: new Date().toISOString(),
        };
        if (options.skipRefresh) {
            deps.taskMetaMap[targetTask.gid] = skipMeta;
            return "skipped";
        }
        await deps.setTaskMeta(targetTask.gid, skipMeta);
        return "skipped";
    }
    // 一键导入：后端解压/落盘/写 mod.json；FOMOD 包后端返回 needFomod，批量场景按全量提交。
    const sourceType = await resolveGlossDownloadImportSourceType(primaryFile.path, metadata);
    const backendMeta = {
        modName,
        fileName,
        modVersion: metadata?.version || "1.0.0",
        modAuthor: metadata?.author || "",
        modWebsite: metadata?.sourceUrl || "",
        modDesc: metadata?.content || "",
        cover: metadata?.cover,
        from: getTaskSourceType(metadata),
        webId: getTaskExternalId(metadata),
        gameID: deps.manager.managerGame.GlossGameId,
        other: { downloadTaskGid: targetTask.gid, sourceUrl: metadata?.sourceUrl || "" },
    };
    const started = Date.now();
    let result = await backendImportTask(primaryFile.path, sourceType, deps.manager.managerRoot, backendMeta);
    if (result.needFomod && result.stagingDir && result.targetDir && result.fomodXml) {
        // 批量无弹窗：FOMOD 按全量文件提交（等价前端不裁剪）。
        console.debug(`[导入] 批量命中 FOMOD 包，按全量提交：gid=${targetTask.gid} files=${result.fileCount}`);
        const committed = await backendImportCommit(result.stagingDir, result.modId, result.targetDir, deps.manager.managerRoot, backendMeta, false, []);
        result = { ...result, modId: committed.modId, modName: committed.modName, fileCount: committed.fileCount, needFomod: false, elapsedMs: Date.now() - started };
    }
    console.debug(`[导入] 后端导入完成：gid=${targetTask.gid} modId=${result.modId} files=${result.fileCount} 后端耗时=${result.elapsedMs}ms 前端总耗时=${Date.now() - started}ms`);
    const nextMeta: IGlossDownloadTaskMeta = {
        ...(metadata ?? {}),
        localModId: result.modId,
        importedAt: new Date().toISOString(),
    };
    if (options.skipRefresh) {
        // 批量场景：只改内存，meta 落盘 + 管理器刷新由调用方最后统一做一次。
        deps.taskMetaMap[targetTask.gid] = nextMeta;
        return "imported";
    }
    await deps.setTaskMeta(targetTask.gid, nextMeta);
    await deps.manager.refreshRuntimeData({ storagePath: deps.storagePath, closeSoftLinks: deps.closeSoftLinks });
    return "imported";
}

// 单任务导入（后端版，含重复弹窗决策：继续/覆盖/同时存在；FOMOD 弹窗保留）。
// 流程：后端判重→（有重复则弹窗）→后端 prepare→（FOMOD 则前端 parse+向导）→后端 commit→写 meta。
export async function importTaskToLocalManager(
    task: IDownloaderTask | null | undefined,
    deps: ImportDeps,
    importState: ReturnType<typeof useTaskImportState>,
): Promise<void> {
    const targetTask = task ?? deps.selectedTask;
    if (!targetTask) return;
    if (targetTask.status !== "complete") {
        ElMessage.warning("请先等待任务下载完成。");
        return;
    }
    importState.startTaskImport(targetTask.gid);
    const started = Date.now();
    try {
        if (!deps.manager.managerGame || !deps.manager.managerRoot) {
            throw new Error("请先选择游戏并配置储存路径。");
        }
        const primaryFile = getTaskPrimaryFile(targetTask);
        if (!primaryFile?.path) throw new Error("当前任务没有可导入的文件。");
        if (!(await FileHandler.fileExists(primaryFile.path))) throw new Error("下载文件不存在，请先检查输出目录。");
        const metadata = deps.taskMetaMap[targetTask.gid] ?? null;
        const modName = metadata?.modTitle || metadata?.resourceName || getTaskDisplayName(targetTask, metadata);
        const fileName = metadata?.fileName || getBaseName(primaryFile.path);
        const backendMeta = {
            modName,
            fileName,
            modVersion: metadata?.version || "1.0.0",
            modAuthor: metadata?.author || "",
            modWebsite: metadata?.sourceUrl || "",
            modDesc: metadata?.content || "",
            cover: metadata?.cover,
            from: getTaskSourceType(metadata),
            webId: getTaskExternalId(metadata),
            gameID: deps.manager.managerGame.GlossGameId,
            other: { downloadTaskGid: targetTask.gid, sourceUrl: metadata?.sourceUrl || "" },
        };
        // 后端判重（读 mod.json 打分排序），有命中则弹窗让用户决策。
        const duplicates = await backendImportDuplicates(deps.manager.managerRoot, {
            sourceType: getTaskSourceType(metadata),
            externalId: getTaskExternalId(metadata),
            modId: metadata?.modId,
            fileName,
            modTitle: modName,
        });
        // localModId 指向的排第一（沿用旧行为：优先沿用已关联条目）。
        const ranked = [...duplicates].sort((left, right) => {
            const leftPinned = metadata?.localModId != null && "id" in left.modData && left.modData.id === metadata.localModId;
            const rightPinned = metadata?.localModId != null && "id" in right.modData && right.modData.id === metadata.localModId;
            if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
            return right.score - left.score;
        });
        let overwriteModId: number | undefined;
        if (ranked.length > 0) {
            const top = ranked[0].modData;
            const topId = "id" in top ? top.id : undefined;
            const topName = "modName" in top && typeof top.modName === "string" ? top.modName : modName;
            const decision = await deps.promptDuplicateDecision({
                title: "发现重复的本地 Mod",
                description: `${modName} 已经存在于本地管理器中。`,
                note: `继续会保留当前本地条目 #${String(topId ?? "?")}；覆盖会替换该条目的文件；同时存在会新建一个本地条目。`,
                items: ranked.map((item) => {
                    const data = item.modData;
                    const name = "modName" in data && typeof data.modName === "string" ? data.modName : modName;
                    const desc = "modDesc" in data && typeof data.modDesc === "string" && data.modDesc ? data.modDesc : ("fileName" in data && typeof data.fileName === "string" ? data.fileName : "已有本地 Mod 记录");
                    const version = "modVersion" in data && typeof data.modVersion === "string" ? data.modVersion : "未知版本";
                    const fname = "fileName" in data && typeof data.fileName === "string" ? data.fileName : "";
                    return { title: `${name} #${String("id" in data ? data.id : "?")}`, description: desc, badges: [item.reason, version, fname].filter(Boolean) };
                }),
                actions: [
                    { value: "cancel", label: "取消", description: "保持当前本地管理器不变。", variant: "outline" },
                    { value: "continue", label: "继续", description: "沿用当前最接近的本地条目。" },
                    { value: "overwrite", label: "覆盖", description: "用新下载的内容替换现有本地条目。", variant: "destructive" },
                    { value: "keep-both", label: "同时存在", description: "保留旧条目，同时新增一个本地条目。", variant: "outline" },
                ],
            });
            if (decision === "cancel") {
                ElMessage.info("已取消重复导入。");
                return;
            }
            if (decision === "continue") {
                if (typeof topId !== "number" || !Number.isFinite(topId)) throw new Error("重复条目 ID 非法。");
                deps.setTaskMeta(targetTask.gid, { ...(metadata ?? {}), localModId: topId, importedAt: new Date().toISOString() });
                ElMessage.success(`已保留现有本地 Mod：${topName}`);
                return;
            }
            if (decision === "overwrite") {
                if (typeof topId !== "number" || !Number.isFinite(topId)) throw new Error("重复条目 ID 非法。");
                overwriteModId = topId;
            }
        }
        // 后端一键导入：无 FOMOD 直接落盘；有则返回 xml 走前端向导。
        const sourceType = await resolveGlossDownloadImportSourceType(primaryFile.path, metadata);
        const result = await backendImportTask(primaryFile.path, sourceType, deps.manager.managerRoot, backendMeta, overwriteModId);
        if (!result.needFomod) {
            console.debug(`[导入] 后端导入完成：gid=${targetTask.gid} modId=${result.modId} files=${result.fileCount} 后端耗时=${result.elapsedMs}ms 前端总耗时=${Date.now() - started}ms`);
            deps.setTaskMeta(targetTask.gid, { ...(metadata ?? {}), localModId: result.modId, importedAt: new Date().toISOString() });
            await deps.manager.refreshRuntimeData({ storagePath: deps.storagePath, closeSoftLinks: deps.closeSoftLinks });
            ElMessage.success(`已导入到本地管理器：${result.modName}`);
            return;
        }
        // FOMOD：前端 parse xml + 向导弹窗选分支，再调 commit。
        if (!result.stagingDir || !result.targetDir || !result.fomodXml) throw new Error("FOMOD 准备数据缺失。");
        const fomodConfig: FomodConfig = parseFomodConfig(result.fomodXml);
        const selected = await deps.startWizard(fomodConfig);
        if (selected === null) {
            ElMessage.info("已取消 FOMOD 安装。");
            return;
        }
        const files = resolveFomodInstallFiles(fomodConfig, selected, {});
        const committed = await backendImportCommit(result.stagingDir, result.modId, result.targetDir, deps.manager.managerRoot, backendMeta, overwriteModId != null, files.map((f) => f.source));
        console.debug(`[导入] FOMOD 提交完成：gid=${targetTask.gid} modId=${committed.modId} files=${committed.fileCount} 前端总耗时=${Date.now() - started}ms`);
        deps.setTaskMeta(targetTask.gid, { ...(metadata ?? {}), localModId: committed.modId, importedAt: new Date().toISOString() });
        await deps.manager.refreshRuntimeData({ storagePath: deps.storagePath, closeSoftLinks: deps.closeSoftLinks });
        ElMessage.success(`已导入到本地管理器：${committed.modName}`);
    } catch (error: unknown) {
        ElMessage.error(getErrorMessage(error));
    } finally {
        importState.finishTaskImport(targetTask.gid);
    }
}

// 批量导入全部：一次判重（后端）+ 一次并行导入（后端）+ 一次落盘/刷新。
// 旧串行逐个 invoke 已删：N 个任务 = 1 次 duplicates 全查 + 1 次 batch 并行（后端信号量限流）+ 1 次 meta 落盘。
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
    // 物化可用项：无文件/文件丢失的先记失败，不进批量。
    const items: BackendImportBatchItem[] = [];
    const taskByGid = new Map(todo.map((t) => [t.gid, t]));
    let skipped = 0;
    let failed = 0;
    const failures: string[] = [];
    for (const task of todo) {
        if (importState.isTaskImporting(task.gid)) continue;
        const primaryFile = getTaskPrimaryFile(task);
        if (!primaryFile?.path) {
            failed += 1;
            failures.push(`${getTaskDisplayName(task, deps.taskMetaMap[task.gid])}：没有可导入的文件`);
            continue;
        }
        if (!(await FileHandler.fileExists(primaryFile.path))) {
            failed += 1;
            failures.push(`${getTaskDisplayName(task, deps.taskMetaMap[task.gid])}：下载文件不存在`);
            continue;
        }
        const metadata = deps.taskMetaMap[task.gid];
        // gameID 双路取：deps.manager 优先，store 直读兜底；日志记录实际来源。
        const storeGame = useManager().managerGame as { GlossGameId?: unknown; checkModType?: unknown } | null;
        const depsGameId = (deps.manager.managerGame as { GlossGameId?: unknown } | null)?.GlossGameId;
        const gameID = depsGameId ?? storeGame?.GlossGameId ?? null;
        if (items.length === 0) {
            console.debug(`[导入] 批量前端game：deps=${String(depsGameId)} store=${String(storeGame?.GlossGameId)} 用=${String(gameID)} checkModType=${typeof storeGame?.checkModType} 游戏=${(storeGame as { gameShowName?: string })?.gameShowName ?? (storeGame as { gameName?: string })?.gameName ?? "?"}`);
        }
        items.push({
            gid: task.gid,
            filePath: primaryFile.path,
            sourceType: await resolveGlossDownloadImportSourceType(primaryFile.path, metadata ?? null),
            metadata: {
                modName: metadata?.modTitle || metadata?.resourceName || getTaskDisplayName(task, metadata),
                fileName: metadata?.fileName || getBaseName(primaryFile.path),
                modVersion: metadata?.version || "1.0.0",
                modAuthor: metadata?.author || "",
                modWebsite: metadata?.sourceUrl || "",
                modDesc: metadata?.content || "",
                cover: metadata?.cover,
                from: getTaskSourceType(metadata),
                webId: getTaskExternalId(metadata),
                gameID,
                other: { downloadTaskGid: task.gid, sourceUrl: metadata?.sourceUrl || "" },
            },
        });
    }
    let imported = 0;
    // 分片调 batch：每片一次 invoke，片间推进度（后端单次 invoke 无中间进度，只能按片粒度展示）。
    const CHUNK = 20;
    if (items.length > 0) {
        importState.batchProgress.value = { total: items.length, done: 0, running: true };
        for (const item of items) importState.startTaskImport(item.gid);
        // 类型规则随片透传（store 直读，deps 转发可能丢值；函数式规则后端跑不了→内置回退）。
        const storeGameForRules = useManager().managerGame as { checkModType?: unknown } | null;
        const typeRules = Array.isArray(storeGameForRules?.checkModType) ? (storeGameForRules.checkModType as unknown[]) : [];
        console.debug(`[导入] 批量前端规则：store直读checkModType=${typeof storeGameForRules?.checkModType} 规则数=${typeRules.length}`);
        try {
            for (let i = 0; i < items.length; i += CHUNK) {
                const chunk = items.slice(i, i + CHUNK);
                try {
                    const results = await backendImportBatch(deps.manager.managerRoot, chunk, typeRules);
                    for (const result of results) {
                        const task = taskByGid.get(result.gid);
                        const prev = deps.taskMetaMap[result.gid] ?? {};
                        if (result.ok && result.modId != null && result.error !== "skipped") {
                            imported += 1;
                            deps.taskMetaMap[result.gid] = { ...prev, localModId: result.modId, importedAt: new Date().toISOString() };
                        } else if (result.ok && result.error === "skipped" && result.modId != null) {
                            skipped += 1;
                            deps.taskMetaMap[result.gid] = { ...prev, localModId: result.modId, importedAt: new Date().toISOString() };
                        } else {
                            failed += 1;
                            const name = task ? getTaskDisplayName(task, deps.taskMetaMap[result.gid]) : result.gid;
                            failures.push(`${name}：${result.error || "导入失败"}`);
                        }
                    }
                } catch (error: unknown) {
                    failed += chunk.length;
                    failures.push(`批量调用失败（第${Math.floor(i / CHUNK) + 1}片）：${getErrorMessage(error)}`);
                }
                importState.batchProgress.value = { total: items.length, done: Math.min(i + CHUNK, items.length), running: true };
            }
        } finally {
            for (const item of items) importState.finishTaskImport(item.gid);
            importState.batchProgress.value = { total: items.length, done: items.length, running: false };
        }
        // 一次落盘 + 一次刷新（跳过也回填了 localModId，需落盘）。
        if (imported > 0 || skipped > 0) {
            await saveDownloadMetaMap({ ...deps.taskMetaMap });
        }
        if (imported > 0) {
            await deps.manager.refreshRuntimeData({ storagePath: deps.storagePath, closeSoftLinks: deps.closeSoftLinks });
        }
    }
    if (failures.length > 0) {
        console.error(`批量导入失败明细（${failures.length}）：\n${failures.slice(0, 20).join("\n")}`);
    }
    ElMessage.success(`批量导入完成：新增 ${imported} 个，跳过重复 ${skipped} 个，失败 ${failed} 个。`);
}
