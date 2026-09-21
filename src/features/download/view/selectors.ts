// facade 快照选择器：筛选/排序/分组/倒计时展示语义。
// retrying 与 error 同组展示，附“x 秒后重试 / 剩余 n 次”；计时字段只读后端投影。
import type { DownloadStatus, DownloadTask, TaskProjection } from "../types";

export type TaskGroup = "active" | "attention" | "waiting" | "paused";

const ATTENTION: Record<string, true> = { error: true, retrying: true };

export function groupOf(task: DownloadTask): TaskGroup {
    if (task.status === "active") {
        return "active";
    }
    if (ATTENTION[task.status] === true) {
        return "attention";
    }
    if (task.status === "paused") {
        return "paused";
    }
    return "waiting";
}

export function selectByStatus(tasks: readonly DownloadTask[], status: DownloadStatus): DownloadTask[] {
    return tasks.filter((task) => task.status === status);
}

export function selectAttention(tasks: readonly DownloadTask[]): DownloadTask[] {
    return tasks.filter((task) => ATTENTION[task.status] === true);
}

// retrying 展示：剩余秒数（后端 nextRetryAtMs - now，后端未给则 0）+ 剩余次数（上限 3）。
export function retryCountdownText(task: DownloadTask, nowMs = Date.now(), maxRetries = 3): string {
    const remainMs = Math.max(0, task.nextRetryAtMs - nowMs);
    const seconds = Math.ceil(remainMs / 1000);
    const remainCount = Math.max(0, maxRetries - task.retryCount);
    return `${seconds}秒后重试/剩余${remainCount}次`;
}

export function sortForDisplay(tasks: readonly DownloadTask[]): DownloadTask[] {
    const rank: Record<TaskGroup, number> = { attention: 0, active: 1, waiting: 2, paused: 3 };
    return [...tasks].sort((a, b) => rank[groupOf(a)] - rank[groupOf(b)]);
}
// 页内筛选（含导入态）：meta localModId 判定 imported/unimported，其余按状态桶。
export type QueueFilter =
    | "all"
    | "active"
    | "waiting"
    | "paused"
    | "stopped"
    | "failed"
    | "imported"
    | "unimported";
export function filterTasks(
    tasks: readonly TaskProjection[],
    filter: QueueFilter,
    isImported: (gid: string) => boolean,
): TaskProjection[] {
    switch (filter) {
        case "active":
            return tasks.filter((t) => t.status === "active");
        case "waiting":
            return tasks.filter((t) => t.status === "waiting");
        case "paused":
            return tasks.filter((t) => t.status === "paused");
        case "failed":
            return tasks.filter((t) => t.status === "error" || t.status === "retrying");
        case "stopped":
            return tasks.filter((t) => t.status === "complete");
        case "imported":
            return tasks.filter((t) => isImported(t.gid));
        case "unimported":
            return tasks.filter((t) => !isImported(t.gid));
        default:
            return [...tasks];
    }
}
export interface PageSlice {
    page: number;
    pageSize: number;
}
export function paginateTasks(tasks: readonly DownloadTask[], slice: PageSlice): DownloadTask[] {
    const start = (slice.page - 1) * slice.pageSize;
    return tasks.slice(start, start + slice.pageSize);
}
export function rangeLabel(total: number, slice: PageSlice): string {
    if (total === 0) {
        return "暂无任务";
    }
    const start = (slice.page - 1) * slice.pageSize + 1;
    const end = Math.min(total, start + slice.pageSize - 1);
    return `显示第 ${start}-${end} 条，共 ${total} 条`;
}
