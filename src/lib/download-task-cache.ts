import { join } from "@tauri-apps/api/path";
import { stat } from "@tauri-apps/plugin-fs";
import type { IDownloaderTask } from "@/lib/download-task-types";
import type { IGlossDownloadTaskMeta } from "@/lib/gloss-download";

const DOWNLOAD_TASK_SNAPSHOT_KEY = "aria2TaskSnapshotMap";
const RESTORED_TASK_ERROR_CODE = "GMM_RESTORED_TASK";
const RESTORED_TASK_ERROR_MESSAGE =
    "任务未能从本地快照恢复，可点击“重试”重新加入下载队列。";

function toNumber(value?: string | number) {
    const normalized = Number(value ?? 0);

    return Number.isFinite(normalized) ? normalized : 0;
}

function isFinishedByProgress(task: IDownloaderTask) {
    const totalLength = toNumber(task.totalLength);
    const completedLength = toNumber(task.completedLength);

    return totalLength > 0 && completedLength >= totalLength;
}

async function normalizeRestoredTask(task: IDownloaderTask, liveGids: Set<string>) {
    if (liveGids.has(task.gid) || task.status === "removed") {
        return task;
    }

    if (isFinishedByProgress(task)) {
        return {
            ...task,
            status: "complete",
            downloadSpeed: "0",
            connections: "0",
            errorCode: RESTORED_TASK_ERROR_CODE,
        };
    }

    if (["active", "waiting", "paused"].includes(task.status)) {
        // B：快照有、live 无（多为重启后内存表清空）。stat 真实文件，
        // size >= total 才算 complete，否则保持 error。
        const filePath = task.files.find((item) => item.path)?.path ?? task.files[0]?.path;
        const totalLength = toNumber(task.totalLength);
        if (filePath && totalLength > 0) {
            try {
                const metadata = await stat(filePath);
                if (metadata.size >= totalLength) {
                    return {
                        ...task,
                        status: "complete",
                        completedLength: String(totalLength),
                        downloadSpeed: "0",
                        connections: "0",
                        errorCode: RESTORED_TASK_ERROR_CODE,
                    };
                }
            } catch {
                // 文件不存在/不可读：落到下面的 error 分支。
            }
        }
        return {
            ...task,
            status: "error",
            downloadSpeed: "0",
            connections: "0",
            errorCode: RESTORED_TASK_ERROR_CODE,
            errorMessage: task.errorMessage || RESTORED_TASK_ERROR_MESSAGE,
        };
    }

    return {
        ...task,
        downloadSpeed: "0",
        connections: "0",
        errorCode: RESTORED_TASK_ERROR_CODE,
    };
}

async function buildTaskFilePath(
    metadata: IGlossDownloadTaskMeta,
    fallbackDirectory?: string,
) {
    const fileName = metadata.fileName || metadata.resourceName || "";

    if (!fileName) {
        return "";
    }

    if (!fallbackDirectory) {
        return fileName;
    }

    return await join(fallbackDirectory, fileName);
}

async function createTaskFromMetadata(
    gid: string,
    metadata: IGlossDownloadTaskMeta,
    fallbackDirectory?: string,
) {
    const status = metadata.taskStatus === "complete" ? "complete" : "error";
    const filePath = await buildTaskFilePath(metadata, fallbackDirectory);
    const uri = metadata.downloadUrl?.trim();

    return {
        gid,
        status,
        totalLength: "0",
        completedLength: "0",
        downloadSpeed: "0",
        connections: "0",
        dir: fallbackDirectory,
        files: [
            {
                index: "1",
                path: filePath,
                length: "0",
                completedLength: "0",
                selected: "true",
                uris: uri ? [{ status: "used", uri }] : [],
            },
        ],
        errorCode: RESTORED_TASK_ERROR_CODE,
        errorMessage:
            metadata.taskStatus === "complete"
                ? undefined
                : RESTORED_TASK_ERROR_MESSAGE,
    } satisfies IDownloaderTask;
}

export function isRestoredDownloadTask(task?: IDownloaderTask | null) {
    return task?.errorCode === RESTORED_TASK_ERROR_CODE;
}

export async function readDownloadTaskSnapshots() {
    return (
        (await PersistentStore.get<Record<string, IDownloaderTask>>(
            DOWNLOAD_TASK_SNAPSHOT_KEY,
            {},
        )) ?? {}
    );
}

export async function mergeDownloadTaskSnapshots(
    liveTasks: IDownloaderTask[],
    taskMetaMap: Record<string, IGlossDownloadTaskMeta> = {},
    fallbackDirectory?: string,
) {
    const storedSnapshots = await readDownloadTaskSnapshots();
    const liveGids = new Set(liveTasks.map((task) => task.gid));
    const nextSnapshots: Record<string, IDownloaderTask> = {
        ...storedSnapshots,
    };

    for (const task of liveTasks) {
        if (task.status === "removed") {
            delete nextSnapshots[task.gid];
            continue;
        }

        nextSnapshots[task.gid] = task;
    }

    for (const [gid, metadata] of Object.entries(taskMetaMap)) {
        if (nextSnapshots[gid] || metadata.taskStatus === "removed") {
            continue;
        }

        nextSnapshots[gid] = await createTaskFromMetadata(
            gid,
            metadata,
            fallbackDirectory,
        );
    }

    const normalizedSnapshots: Record<string, IDownloaderTask> = {};

    for (const [gid, task] of Object.entries(nextSnapshots)) {
        const normalizedTask = await normalizeRestoredTask(task, liveGids);

        if (normalizedTask.status !== "removed") {
            normalizedSnapshots[gid] = normalizedTask;
        }
    }

    await PersistentStore.set(DOWNLOAD_TASK_SNAPSHOT_KEY, normalizedSnapshots);

    return Object.values(normalizedSnapshots);
}

export async function removeDownloadTaskSnapshot(gid: string) {
    const storedSnapshots = await readDownloadTaskSnapshots();

    if (!storedSnapshots[gid]) {
        return;
    }

    const nextSnapshots = { ...storedSnapshots };
    delete nextSnapshots[gid];
    await PersistentStore.set(DOWNLOAD_TASK_SNAPSHOT_KEY, nextSnapshots, true);
}

export async function removeDownloadTaskSnapshots(gids: string[]) {
    if (gids.length === 0) {
        return;
    }

    const gidSet = new Set(gids);
    const storedSnapshots = await readDownloadTaskSnapshots();
    const nextSnapshots = Object.fromEntries(
        Object.entries(storedSnapshots).filter(([gid]) => !gidSet.has(gid)),
    );

    await PersistentStore.set(DOWNLOAD_TASK_SNAPSHOT_KEY, nextSnapshots, true);
}
