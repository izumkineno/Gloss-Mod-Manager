// 任务展示纯函数（Wave 3 自包含）：原 download-task-ui.ts 迁移，新旧两套任务形状兼容。
// DownloadTask（新 5 态，数字进度）优先；IDownloaderTask（旧字符串形状）兼容供页面迁移期使用。
import type { DownloadTask } from "../types";

interface LegacyTaskLike {
    status?: string;
    totalLength?: string | number;
    completedLength?: string | number;
    downloadSpeed?: string | number;
    files?: Array<{ path?: string }>;
}

export function toNumber(value?: string | number): number {
    const normalized = typeof value === "number" ? value : Number(value ?? 0);

    return Number.isFinite(normalized) ? normalized : 0;
}

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
export function getTaskProgress(task: DownloadTask | LegacyTaskLike): number {
    let total = 0;
    let done = 0;
    if ("total" in task && typeof task.total === "number") {
        total = task.total;
        done = typeof task.downloaded === "number" ? task.downloaded : 0;
    } else if ("totalLength" in task) {
        total = toNumber(task.totalLength);
        done = toNumber(task.completedLength);
    }
    if (total <= 0) {
        return 0;
    }
    return Math.min(100, Math.round((done / total) * 100));
}
export function getTaskPrimaryFile(task: DownloadTask | LegacyTaskLike): { path?: string } | null {
    if (!("files" in task) || !Array.isArray(task.files)) {
        return null;
    }
    return task.files.find((item) => item.path) ?? task.files[0] ?? null;
}
export function getTaskSpeedText(task: DownloadTask | LegacyTaskLike): string {
    let speed = 0;
    if ("speed" in task && typeof task.speed === "number") {
        speed = task.speed;
    } else if ("downloadSpeed" in task) {
        speed = toNumber(task.downloadSpeed);
    }
    if (speed <= 0) {
        return "";
    }
    return `${formatBytes(speed)}/s`;
}
