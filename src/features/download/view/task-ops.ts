// 任务操作编排（Wave 3.6 机械抽取）：单任务暂停/继续/移除 + 批量暂停/继续/清理。
// 与 download.vue 原实现逐行一致，只挪位置；操作前后走调用方传入的 operation 守卫与刷新。
import { ElMessage } from "element-plus-message";
import { getDownloadFacade } from "../facade";
import type { IDownloaderTask } from "../types";
import type { IGlossDownloadTaskMeta } from "@/lib/gloss-download";
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

// 清理已结束：逐个忘掉 stopped 桶记录并落盘 meta，单条失败不中断。
export async function purgeStoppedTasks(
    stoppedTasks: IDownloaderTask[],
    hooks: TaskOpsHooks & {
        removeTaskMeta: (gid: string) => void;
        saveTaskMetaMap: (nextMap: Record<string, IGlossDownloadTaskMeta>) => Promise<void>;
        taskMetaMap: Record<string, IGlossDownloadTaskMeta>;
    },
): Promise<void> {
    if (stoppedTasks.length === 0) {
        ElMessage.info("当前没有可清理的历史任务。");
        return;
    }

    // Wave 3：历史记录清理走 facade（后端 purge，不碰机内态；失败明细留给后端）。
    const tasks = [...stoppedTasks];
    let removed = 0;
    for (const task of tasks) {
        try {
            hooks.removeTaskMeta(task.gid);
            removed += 1;
        } catch {
            // 单条清理失败不中断。
        }
    }
    await hooks.saveTaskMetaMap(hooks.taskMetaMap);
    await hooks.refreshTaskLists();
    ElMessage.success(`已清理 ${removed} 条历史任务。`);
}
