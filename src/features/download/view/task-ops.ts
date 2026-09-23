// 任务操作编排（Wave 3.6 机械抽取）：单任务暂停/继续/移除 + 批量暂停/继续/清理。
// 与 download.vue 原实现逐行一致，只挪位置；操作前后走调用方传入的 operation 守卫与刷新。
import { ElMessage } from "element-plus-message";
import { invoke } from "@tauri-apps/api/core";
import { getDownloadFacade } from "../facade";
import type { IDownloaderTask } from "../types";
import { getErrorMessage } from "./task-display";

export interface TaskOpsHooks {
    startTaskOperation: (gid: string) => void;
    finishTaskOperation: (gid: string) => void;
    refreshTaskLists: (silent?: boolean) => Promise<void>;
}

// 单任务暂停（操作守卫防并发）。
export async function pauseTask(task: IDownloaderTask, hooks: TaskOpsHooks): Promise<void> {
    hooks.startTaskOperation(task.gid);

    try {
        await getDownloadFacade().pause(task.gid);
        await hooks.refreshTaskLists();
    } catch (error: unknown) {
        ElMessage.error(getErrorMessage(error));
    } finally {
        hooks.finishTaskOperation(task.gid);
    }
}

// 单任务继续（操作守卫防并发）。
export async function resumeTask(task: IDownloaderTask, hooks: TaskOpsHooks): Promise<void> {
    hooks.startTaskOperation(task.gid);

    try {
        await getDownloadFacade().resume(task.gid);
        await hooks.refreshTaskLists();
    } catch (error: unknown) {
        ElMessage.error(getErrorMessage(error));
    } finally {
        hooks.finishTaskOperation(task.gid);
    }
}

// 暂停全部：计数回显。
export async function pauseAllTasks(refresh: () => Promise<void>): Promise<void> {
    try {
        const count = await getDownloadFacade().pauseAll();
        ElMessage.success(count > 0 ? `已暂停全部：${count} 个任务。` : "暂无可暂停的任务。");
        await refresh();
    } catch (error: unknown) {
        ElMessage.error(getErrorMessage(error));
    }
}

// 继续全部：计数回显。
export async function resumeAllTasks(refresh: () => Promise<void>): Promise<void> {
    try {
        const count = await getDownloadFacade().resumeAll();
        ElMessage.success(count > 0 ? `已继续全部：${count} 个任务。` : "暂无可继续的任务。");
        await refresh();
    } catch (error: unknown) {
        ElMessage.error(getErrorMessage(error));
    }
}

// 单任务移除（走调用方 removeTaskRecord：后端删除 + 快照 + meta）。
export async function removeTask(
    task: IDownloaderTask,
    hooks: TaskOpsHooks & { removeTaskRecord: (task: IDownloaderTask) => Promise<void> },
): Promise<void> {
    hooks.startTaskOperation(task.gid);
    try {
        await hooks.removeTaskRecord(task);
        await hooks.refreshTaskLists();
    } catch (error: unknown) {
        ElMessage.error(getErrorMessage(error));
    } finally {
        hooks.finishTaskOperation(task.gid);
    }
}

// 清理已结束：facade.purge 清后端注册表 + 前端终局归档，再清对应 meta 落盘，单条失败不中断。
// deleteFile=true 时一并删本地文件（含 .download.bitcode 断点，后端负责）。
export async function purgeStoppedTasks(
    stoppedTasks: IDownloaderTask[],
    hooks: TaskOpsHooks & {
        removeTaskMeta: (gid: string) => Promise<void>;
    },
    deleteFile = false,
): Promise<void> {
    // 入口快照：批量来源（已完成/失败页）与规模，删文件开关是关键分叉。
    console.info(`[purge] start total=${stoppedTasks.length} deleteFile=${deleteFile} gids_head=${stoppedTasks.slice(0, 5).map((t) => t.gid).join(",")}`);
    if (stoppedTasks.length === 0) {
        ElMessage.info("当前没有可清理的历史任务。");
        return;
    }

    // 真清后端（按 gid 批量）+ 前端终局归档；ghost 记录后端侧直接忽略。
    const tasks = [...stoppedTasks];
    let backendFailed: Array<[string, string]> = [];
    let backendCount = 0;
    try {
        // facade.purge 返回后端真实命中数；ghost（重启后注册表已清）count=0 时按路径删文件。
        const result = await getDownloadFacade().purge(
            tasks.map((task) => task.gid),
            deleteFile,
        );
        backendFailed = result.failed;
        backendCount = result.count;
        if (deleteFile && backendCount === 0) {
            // ghost fallback：从任务 dir + files[].path 拼输出路径，后端按路径删。
            const paths = tasks
                .map((task) => {
                    const file = task.files?.find((f) => f.path) ?? task.files?.[0];
                    if (!task.dir || !file?.path) return undefined;
                    const dir = task.dir.replace(/[/\\]+$/, "");
                    const name = file.path.split(/[/\\]/).pop();
                    return name ? `${dir}/${name}` : undefined;
                })
                .filter((p): p is string => !!p);
            console.info(`[purge] ghost fallback deleteFile paths=${paths.length}`);
            if (paths.length > 0) {
                const [ok, failed] = await invoke<[number, Array<[string, string]>]>("dl_delete_files", { paths });
                backendCount = ok;
                backendFailed = [...backendFailed, ...failed];
                console.info(`[purge] ghost fallback done ok=${ok} failed=${failed.length}`);
            }
        } else {
            backendCount = tasks.length - backendFailed.length;
        }
        console.info(`[purge] backend done targets=${tasks.length} cleaned~=${backendCount} failed=${backendFailed.length} deleteFile=${deleteFile}`);
        for (const [gid, reason] of backendFailed) {
            console.warn(`[purge] backend failed gid=${gid} reason=${reason}`);
        }
    } catch (error: unknown) {
        console.error(`[purge] backend invoke FAILED total=${tasks.length} deleteFile=${deleteFile}`, error);
        ElMessage.error(getErrorMessage(error));
        return;
    }
    let removed = 0;
    let metaFailed = 0;
    for (const task of tasks) {
        try {
            await hooks.removeTaskMeta(task.gid);
            removed += 1;
        } catch (error: unknown) {
            // 单条清理失败不中断。
            metaFailed += 1;
            console.warn(`[purge] meta remove FAILED gid=${task.gid}`, error);
        }
    }
    // meta 已逐键 removeTaskMeta 落盘；不再整表回写（旧快照会洗掉并发链路的新条目）。
    await hooks.refreshTaskLists();
    console.info(`[purge] done total=${tasks.length} backend_cleaned~=${backendCount} meta_removed=${removed} meta_failed=${metaFailed} backend_failed=${backendFailed.length} deleteFile=${deleteFile}`);
    if (backendFailed.length > 0) {
        ElMessage.warning(`已清理 ${removed} 条记录，但 ${backendFailed.length} 个文件删失败：${backendFailed[0][1]}${backendFailed.length > 1 ? "…" : ""}`);
    } else {
        ElMessage.success(`已清理 ${removed} 条历史任务。`);
    }
}
