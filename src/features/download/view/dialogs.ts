// 对话框/菜单视图逻辑：读 facade 快照，不直调 invoke。
// 重试/取消/清错误菜单语义 + retrying 倒计时展示。
import type { DownloadFacade } from "../facade";
import type { DownloadTask } from "../types";
import { retryCountdownText, selectAttention } from "./selectors";

export interface TaskMenuItem {
    key: "retry" | "cancel" | "resume" | "forget";
    label: string;
    enabled: boolean;
}

export function menuForTask(task: DownloadTask): TaskMenuItem[] {
    switch (task.status) {
        case "error":
            return [
                { key: "retry", label: "重试（保留断点）", enabled: true },
                { key: "forget", label: "移除任务", enabled: true },
            ];
        case "retrying":
            return [{ key: "cancel", label: "取消重试", enabled: true }];
        case "paused":
            return [
                { key: "resume", label: "继续", enabled: true },
                { key: "cancel", label: "取消任务", enabled: true },
            ];
        default:
            return [{ key: "cancel", label: "取消任务", enabled: true }];
    }
}

export function attentionLabel(task: DownloadTask, nowMs = Date.now()): string {
    if (task.status === "retrying") {
        return retryCountdownText(task, nowMs);
    }
    return task.error ?? "下载失败，等待重试";
}

export async function runMenuAction(
    facade: DownloadFacade,
    task: DownloadTask,
    key: TaskMenuItem["key"],
): Promise<void> {
    if (key === "retry") {
        await facade.retry(task.gid);
    } else if (key === "resume") {
        await facade.resume(task.gid);
    } else if (key === "cancel") {
        await facade.cancel(task.gid);
    } else {
        await facade.forget(task.gid);
    }
}

// 清错误：一键 forget 全部 attention 组任务（只出机不删文件）。
export async function clearAttention(facade: DownloadFacade, tasks: readonly DownloadTask[]): Promise<void> {
    for (const task of selectAttention(tasks)) {
        await facade.forget(task.gid);
    }
}
