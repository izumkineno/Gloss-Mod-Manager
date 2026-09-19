// 下载任务共享 UI 纯函数：从 src/pages/download.vue 逐字搬运，供下载页与 collection 页复用。
import type { IDownloaderTask } from "@/lib/download-task-types";

// 下载任务数值归一化：download.vue toNumber 逐字搬。
export function toNumber(value?: string | number): number {
    const normalized = typeof value === "number" ? value : Number(value ?? 0);

    return Number.isFinite(normalized) ? normalized : 0;
}

// 字节格式化：download.vue formatBytes 逐字搬。
export function formatBytes(value?: string | number): string {
    const bytes = toNumber(value);

    if (bytes <= 0) {
        return "0 B";
    }

    const units = ["B", "KB", "MB", "GB", "TB"];
    const exponent = Math.min(
        Math.floor(Math.log(bytes) / Math.log(1024)),
        units.length - 1,
    );
    const amount = bytes / 1024 ** exponent;

    return `${amount >= 100 ? amount.toFixed(0) : amount.toFixed(1)} ${units[exponent]}`;
}

// 任务进度百分比：download.vue getTaskProgress 逐字搬。
export function getTaskProgress(task: IDownloaderTask): number {
    if (task.status === "complete") {
        return 100;
    }

    const totalLength = toNumber(task.totalLength);

    if (totalLength <= 0) {
        return 0;
    }

    return Math.min(
        100,
        Math.round((toNumber(task.completedLength) / totalLength) * 100),
    );
}

// 任务主文件：download.vue getTaskPrimaryFile 逐字搬。
export function getTaskPrimaryFile(task: IDownloaderTask) {
    return task.files.find((item) => item.path) ?? task.files[0] ?? null;
}

// 任务速度文本：downloadSpeed 为 string 数字字节字符串，有值则格式化，无则返回空。
export function getTaskSpeedText(task: IDownloaderTask): string {
    if (!task.downloadSpeed || toNumber(task.downloadSpeed) <= 0) {
        return "";
    }

    return `${formatBytes(task.downloadSpeed)}/s`;
}
