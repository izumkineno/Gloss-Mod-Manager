// 重试编排（Wave 3.6 机械抽取）：脏地址拦截/同名复用/facade.retry/失败汇总。
// 与 download.vue 原实现逐行一致，只挪位置；nexus 网页回退地址判据保持原样。
import { ElMessage } from "element-plus-message";
import { getDownloadFacade } from "../facade";
import type { IDownloaderTask } from "../types";
import type { IGlossDownloadTaskMeta } from "@/lib/gloss-download";
import { getTaskPrimaryFile } from "./format";
import { getErrorMessage, getTaskDisplayName } from "./task-display";

export interface RetryDeps {
    taskMetaMap: Record<string, IGlossDownloadTaskMeta>;
    allTasks: IDownloaderTask[];
    failedTasks: IDownloaderTask[];
    forgetTaskRecord: (gid: string) => Promise<void>;
    removeTaskRecord: (task: IDownloaderTask) => Promise<void>;
    refreshTaskLists: (silent?: boolean) => Promise<void>;
    startTaskOperation: (gid: string) => void;
    finishTaskOperation: (gid: string) => void;
    removeStaleSiblingRecords: (gid: string) => Promise<number>;
    selectTask: (gid: string) => void;
    ensureEngineReady: () => Promise<string>;
    normalizedDownloaderSettings: { split: number; maxConnectionPerServer: number; minSplitSize: string };
    /** 新 gid 入机后交接 meta（重下/回退建的新任务沿用旧记录的展示与导入信息）。 */
    setTaskMeta: (gid: string, metadata: IGlossDownloadTaskMeta) => unknown;
}

// 重试地址收集：meta.downloadUrl 优先，其次 files 内全部 uri（去重保序）。
export function getTaskRetryUris(
    task: IDownloaderTask,
    taskMetaMap: Record<string, IGlossDownloadTaskMeta>,
): string[] {
    const uriSet = new Set<string>();
    const metadataDownloadUrl =
        taskMetaMap[task.gid]?.downloadUrl?.trim();

    if (metadataDownloadUrl) {
        uriSet.add(metadataDownloadUrl);
    }

    for (const file of task.files) {
        for (const item of file.uris ?? []) {
            const normalizedUri = item.uri?.trim();

            if (!normalizedUri) {
                continue;
            }

            uriSet.add(normalizedUri);
        }
    }

    return [...uriSet];
}

// 无有效下载地址判据（真假任务通用）：meta 存的是 nexus 网页回退地址且 files 里无有效直链。
export function isTaskRetryUnrecoverable(
    task: IDownloaderTask,
    taskMetaMap: Record<string, IGlossDownloadTaskMeta>,
): boolean {
    const savedUrl = taskMetaMap[task.gid]?.downloadUrl?.trim() ?? "";
    if (savedUrl && !/:\/\/www\.nexusmods\.com\//iu.test(savedUrl)) return false;
    const hasLiveUri = task.files.some((file) =>
        (file.uris ?? []).some((item) => {
            const uri = item.uri?.trim() ?? "";
            return uri && !/:\/\/www\.nexusmods\.com\//iu.test(uri);
        }),
    );
    return !hasLiveUri;
}

// 新 gid 入机后的 meta 交接：旧记录的展示/导入信息（来源、标题、封面、游戏名等）
// 原样搬给新任务，仅重置导入态与时间戳。旧记录缺失时用任务自身文件名/地址合成
// 最小 meta，保证新任务展示名不断（否则回退 gid，见 getTaskDisplayName）。
async function handoverMeta(
    task: IDownloaderTask,
    deps: Pick<RetryDeps, "taskMetaMap" | "setTaskMeta">,
    oldGid: string,
    newGid: string,
): Promise<void> {
    const now = new Date().toISOString();
    const previous = deps.taskMetaMap[oldGid];
    if (previous) {
        await deps.setTaskMeta(newGid, {
            ...previous,
            localModId: undefined,
            taskStatus: "waiting",
            createdAt: now,
            updatedAt: now,
        });
        return;
    }
    // 无旧 meta：从任务自身推导文件名与地址，避免新任务无名。
    const fileName = (getTaskPrimaryFile(task)?.path?.split(/[\\/]+/u).pop() || "").trim();
    if (!fileName) return;
    const downloadUrl = getTaskRetryUris(task, deps.taskMetaMap).filter((uri) => !/:\/\/www\.nexusmods\.com\//iu.test(uri))[0] || task.files.find((file) => (file.uris ?? []).some((item) => item.uri))?.uris?.[0]?.uri || "";
    await deps.setTaskMeta(newGid, {
        sourceType: "Customize",
        modTitle: fileName,
        fileName,
        downloadUrl,
        taskStatus: "waiting",
        createdAt: now,
        updatedAt: now,
    });
}

// 单任务重试：脏地址直接清理；同名存活任务直接复用；否则 facade.retry 同 gid 重试并清理同文件旧记录。
export async function retryTask(
    task: IDownloaderTask,
    deps: RetryDeps,
    quiet = false,
): Promise<string | null> {
    deps.startTaskOperation(task.gid);

    try {
        // 脏地址拦截（真假任务通用）：免费 key 回退存的是 nexus 网页地址，
        // 拿它重试等于把网页当直链，会建出无名 0B 废任务且旧任务不减。
        // 无有效直链的废记录直接清理（后端 forget + 快照 + meta），用户重新添加即可。
        if (isTaskRetryUnrecoverable(task, deps.taskMetaMap)) {
            await deps.forgetTaskRecord(task.gid);
            await deps.refreshTaskLists();
            if (!quiet) ElMessage.success(`已清理无地址任务 ${getTaskDisplayName(task, deps.taskMetaMap[task.gid])}，请删除后重新添加。`);
            return null;
        }
        const uris = getTaskRetryUris(task, deps.taskMetaMap).filter((uri) => !/:\/\/www\.nexusmods\.com\//iu.test(uri));
        if (!uris.length) {
            await deps.forgetTaskRecord(task.gid);
            await deps.refreshTaskLists();
            if (!quiet) ElMessage.success(`已清理无地址任务 ${getTaskDisplayName(task, deps.taskMetaMap[task.gid])}，请删除后重新添加。`);
            return null;
        }

        await deps.ensureEngineReady();

        // 终局任务（complete 已出机入终局归档）：同 gid retry 是非法变迁（机内 5 态不含 complete，
        // 后端 dl_retry 仅 error 语义），计划钉死“重新下载 = forget 旧记录 + 新 gid 入机”。
        if (task.status === "complete") {
            const completeMeta = deps.taskMetaMap[task.gid];
            const completeFileName = (completeMeta?.fileName
                || getTaskPrimaryFile(task)?.path?.split(/[\\/]+/u).pop()
                || "").trim();
            if (!completeFileName) {
                await deps.forgetTaskRecord(task.gid);
                await deps.refreshTaskLists();
                if (!quiet) {
                    ElMessage.success(`已清理无文件名任务 ${getTaskDisplayName(task, deps.taskMetaMap[task.gid])}，请删除后重新添加。`);
                }
                return null;
            }
            // 目录优先用旧任务投影里的落盘目录；缺失时回退引擎就绪目录。
            const completeDir = task.dir || String(await deps.ensureEngineReady());
            const newGid = await getDownloadFacade().enqueue({
                url: uris[0],
                dir: completeDir,
                fileName: completeFileName,
            });
            await handoverMeta(task, deps, task.gid, newGid);
            await deps.forgetTaskRecord(task.gid);
            await deps.removeStaleSiblingRecords(newGid);
            await deps.refreshTaskLists();
            if (!quiet) {
                deps.selectTask(newGid);
                ElMessage.success(`已重新加入下载队列：${getTaskDisplayName(task, deps.taskMetaMap[task.gid])}`);
            }
            return newGid;
        }

        // 按文件名查重复：同 out 文件名已有非终局任务（active/waiting/paused）则直接复用，
        // 不建新任务，避免失败列表里同文件越重试越多。error/complete 的老记录不管（由 forget 链清理）。
        const metaFileName = deps.taskMetaMap[task.gid]?.fileName
            || getTaskPrimaryFile(task)?.path?.split(/[\\/]+/u).pop()
            || "";
        const outFileName = metaFileName.trim().toLowerCase();
        if (outFileName) {
            const liveDuplicate = deps.allTasks.find((item) => {
                if (item.gid === task.gid) return false;
                if (!["active", "waiting", "paused"].includes(item.status)) return false;
                const itemName = (deps.taskMetaMap[item.gid]?.fileName || getTaskPrimaryFile(item)?.path?.split(/[\\/]+/u).pop() || "").trim().toLowerCase();
                return itemName === outFileName;
            });
            if (liveDuplicate) {
                // 被重试的旧 error 记录已无用，直接清掉，指向存活任务。
                await deps.forgetTaskRecord(task.gid);
                await deps.removeStaleSiblingRecords(liveDuplicate.gid);
                await deps.refreshTaskLists();
                if (!quiet) {
                    deps.selectTask(liveDuplicate.gid);
                    ElMessage.info(`已存在同名下载任务 ${getTaskDisplayName(liveDuplicate, deps.taskMetaMap[liveDuplicate.gid])}，已清理重复失败记录。`);
                }
                return liveDuplicate.gid;
            }
        }

        // 同一 gid retry（保留断点）；后端机内无此 gid 时（应用重启后的降级 error 记录）
        // 回退为 forget + 新 gid 入机——老"删建重试"语义的合规替代，新任务续用同一输出目录与文件名。
        let gid = task.gid;
        try {
            await getDownloadFacade().retry(task.gid);
        } catch (retryError: unknown) {
            const message = getErrorMessage(retryError);
            if (!/任务不存在/u.test(message)) {
                throw retryError;
            }
            const ghostMeta = deps.taskMetaMap[task.gid];
            const ghostFileName = (ghostMeta?.fileName
                || getTaskPrimaryFile(task)?.path?.split(/[\\/]+/u).pop()
                || "").trim();
            const ghostUrl = ghostMeta?.downloadUrl || task.files.find((file) => (file.uris ?? []).some((item) => item.uri))?.uris?.[0]?.uri || "";
            if (!ghostFileName || !ghostUrl) {
                await deps.forgetTaskRecord(task.gid);
                await deps.refreshTaskLists();
                if (!quiet) {
                    ElMessage.success(`已清理失效任务记录 ${getTaskDisplayName(task, ghostMeta)}，请重新添加。`);
                }
                return null;
            }
            const ghostDir = task.dir || String(await deps.ensureEngineReady());
            gid = await getDownloadFacade().enqueue({ url: ghostUrl, dir: ghostDir, fileName: ghostFileName });
            await handoverMeta(task, deps, task.gid, gid);
            await deps.forgetTaskRecord(task.gid);
        }
        await deps.refreshTaskLists();
        const retryDisplayName = getTaskDisplayName(task, deps.taskMetaMap[task.gid]);
        await deps.removeStaleSiblingRecords(gid);
        await deps.refreshTaskLists();
        const retriedTask = deps.allTasks.find((item) => item.gid === gid);
        // 新任务若已秒失败（直链过期会立刻 error），失败计数看起来"没减"：
        // 实际旧的已清、新又失败，必须明示，否则用户以为重试没生效。
        if (!quiet) {
            deps.selectTask(gid);
            if (retriedTask?.status === "error") {
                ElMessage.error(`重试的任务再次失败 ${retryDisplayName}：${retriedTask.errorMessage || "下载地址可能已过期，请重新添加。"}`);
            } else {
                ElMessage.success(`已重新加入下载队列：${retryDisplayName}`);
            }
        }
        return gid;
    } catch (error: unknown) {
        if (!quiet) ElMessage.error(getErrorMessage(error));
        return null;
    } finally {
        deps.finishTaskOperation(task.gid);
    }
}

// 失败 tab 的全部重试：先关全局暂停闸，废任务直接清理，有效任务逐个走 retryTask，最后汇总。
export async function retryAllFailedTasks(deps: RetryDeps): Promise<void> {
    if (deps.failedTasks.length === 0) {
        ElMessage.info("当前没有失败的任务。");
        return;
    }
    try {
        await getDownloadFacade().pauseAll();
    } catch {
        // 关闸失败不中断，继续重试。
    }
    let success = 0;
    let cleaned = 0;
    const total = deps.failedTasks.length;
    for (const task of [...deps.failedTasks]) {
        if (isTaskRetryUnrecoverable(task, deps.taskMetaMap)) {
            // 废任务：无直链，重试只会建无名 0B 任务，直接清理。
            try {
                await deps.removeTaskRecord(task);
                cleaned += 1;
            } catch {
                // 清理失败保留原任务，不中断后续。
            }
            continue;
        }
        const gid = await retryTask(task, deps, true);
        if (gid) success += 1;
    }
    await deps.refreshTaskLists();
    ElMessage.success(`已加入待下载队列 ${success} 个，清理无地址任务 ${cleaned} 个，共 ${total} 个，点继续全部开始。`);
}
