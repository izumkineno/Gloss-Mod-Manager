// 下载页纯展示逻辑（Wave 3.6 机械抽取）：状态文案/样式/文件名/时间/数字/速率。
// 与 download.vue 原实现逐行一致，只挪位置；不改行为、不改视觉。
import { formatBytes, getTaskPrimaryFile, toNumber } from "./format";
import type { IDownloaderTask } from "../types";

// 任务状态中文标签（模板 Badge/去重弹窗共用）。
export const taskStatusLabels: Record<string, string> = {
    active: "下载中",
    waiting: "等待中",
    paused: "已暂停",
    complete: "已完成",
    error: "失败",
    removed: "已移除",
};

// 任务状态排序权重（队列展示用：进行中优先，其次等待/暂停，最后结束态）。
export const TASK_STATUS_SORT_ORDER: Record<string, number> = {
    active: 0,
    waiting: 1,
    paused: 2,
    complete: 3,
    error: 4,
    removed: 5,
};

const numberFormatter = new Intl.NumberFormat("zh-CN");
const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
});

// 状态标签：未知状态原样回显，避免模板空白。
export function getTaskStatusLabel(status: string): string {
    return taskStatusLabels[status] ?? status;
}

// 状态徽标样式：按状态映射色系，其余走中性 muted。
export function getTaskStatusClass(status: string): string {
    if (status === "complete") {
        return "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300";
    }

    if (status === "active") {
        return "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-300";
    }

    if (status === "paused") {
        return "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300";
    }

    if (status === "error" || status === "removed") {
        return "border-destructive/30 bg-destructive/10 text-destructive";
    }

    return "border-border bg-muted/40 text-muted-foreground";
}

// 路径取基名：兼容 win/posix 分隔符。
export function getBaseName(filePath?: string): string {
    if (!filePath) {
        return "";
    }

    return filePath.split(/[\\/]+/u).pop() ?? filePath;
}

// 任务展示名优先级：meta.fileName > meta.resourceName > BT 名 > 主文件基名 > gid（最后一级是 uuid 回退，必须打日志）。
export function getTaskDisplayName(
    task: IDownloaderTask,
    meta?: { fileName?: string; resourceName?: string } | null,
): string {
    if (meta?.fileName) {
        return meta.fileName;
    }

    if (meta?.resourceName) {
        return meta.resourceName;
    }

    if (task.bittorrent?.info?.name) {
        return task.bittorrent.info.name;
    }

    const primaryFile = getTaskPrimaryFile(task);

    if (primaryFile?.path) {
        return getBaseName(primaryFile.path);
    }

    // [uuid-trace] 最终回退到 gid/uuid：无名悬孤任务，日志要包含全部显示源的空值字段与相关 gid，以便反查是哪一环节丢名。
    try {
        const metaFileName = (meta as unknown as { fileName?: unknown })?.fileName;
        const metaResourceName = (meta as unknown as { resourceName?: unknown })?.resourceName;
        console.warn(
            `[uuid-trace] getTaskDisplayName fallback gid=${task.gid} status=${task.status ?? "-"} meta.fileName=${String(metaFileName ?? "")} meta.resourceName=${String(metaResourceName ?? "")} bittorrent.name=${String(task.bittorrent?.info?.name ?? "")} primaryFile.path=${String(primaryFile?.path ?? "")} dir=${String((task as unknown as { dir?: unknown })?.dir ?? "")} — returned gid fallback`,
        );
    } catch {}
    return task.gid;
}

// 任务输出文件名：meta.fileName 优先，其次主文件基名，最后回退 download.bin。
export function getTaskOutputFileName(
    task: IDownloaderTask,
    meta?: { fileName?: string } | null,
): string {
    if (meta?.fileName) {
        return meta.fileName;
    }

    const primaryFile = getTaskPrimaryFile(task);

    if (primaryFile?.path) {
        return getBaseName(primaryFile.path);
    }

    try {
        console.warn(
            `[uuid-trace] getTaskOutputFileName fallback gid=${task.gid} status=${task.status ?? "-"} meta.fileName=${String((meta as unknown as { fileName?: unknown })?.fileName ?? "")} primaryFile.path=${String(primaryFile?.path ?? "")} — returned download.bin`,
        );
    } catch {}
    return "download.bin";
}

// 时间戳解析：非法返回 0，便于排序比较。
export function parseTaskTimestamp(value?: string): number {
    if (!value) {
        return 0;
    }

    const timestamp = Date.parse(value);

    return Number.isNaN(timestamp) ? 0 : timestamp;
}

// 日期展示：空为未知时间，非法原样回显。
export function formatDate(value?: string): string {
    if (!value) {
        return "未知时间";
    }

    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
        return value;
    }

    return dateFormatter.format(parsed);
}

// 数字千分位（zh-CN）。
export function formatNumber(value?: string | number): string {
    return numberFormatter.format(toNumber(value));
}

// 速率展示：字节数 + /s。
export function formatSpeed(value?: string | number): string {
    return `${formatBytes(value)}/s`;
}

// 后端 invoke 错误文案：字符串原文保留，Error 取 message，其余回退通用提示。
export function getErrorMessage(error: unknown): string {
    if (typeof error === "string" && error.trim()) return error;
    if (error instanceof Error && error.message.trim()) {
        return error.message;
    }

    return "操作失败，请稍后重试。";
}
