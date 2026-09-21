import { ensureFileName, ensureServer, getStoredSettings, resolveDownloadDirectory } from "../meta/engine";
import {
    type IDownloaderTask,
    type IDownloaderSettings,
} from "../types";
import { FileHandler } from "@/lib/FileHandler";
import { getUrlFileName, sanitizeFileName } from "@/lib/file-name-utils";
import {
    findGlossDuplicateTasks,
    type IGlossDownloadTaskMeta,
} from "@/lib/gloss-download";
import { PersistentStore } from "@/lib/persistent-store";

export type CustomQueueDownloadStatus =
    | "created"
    | "exists"
    | "resumed"
    | "retried";

export interface IQueueCustomDownloadOptions {
    downloadUrl: string;
    fileName?: string;
    title?: string;
}

export interface IQueueCustomDownloadResult {
    status: CustomQueueDownloadStatus;
    gid: string;
    message: string;
}

interface IQueueRuntimeContext {
    outputDirectory: string;
    proxy: string;
    settings: IDownloaderSettings;
    taskMetaMap: Record<string, IGlossDownloadTaskMeta>;
    allTasks: IDownloaderTask[];
}

const DOWNLOAD_TASK_META_KEY = "aria2TaskMetaMap";
const CUSTOM_DOWNLOAD_USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

function buildOutputFileName(options: IQueueCustomDownloadOptions) {
    const preferredName = sanitizeFileName(
        options.fileName ||
            options.title ||
            getUrlFileName(options.downloadUrl),
    );

    return preferredName || "download.bin";
}

async function getQueueRuntimeContext(): Promise<IQueueRuntimeContext> {
    const outputDirectory = await resolveDownloadDirectory();
    await FileHandler.createDirectory(outputDirectory);
    await ensureServer({ outputDirectory });

    const settings = await getStoredSettings();
    const proxy = (
        (await PersistentStore.get<string>("downloadProxy", "")) ?? ""
    ).trim();
    const taskMetaMap =
        (await PersistentStore.get<Record<string, IGlossDownloadTaskMeta>>(
            DOWNLOAD_TASK_META_KEY,
            {},
        )) ?? {};
    // Wave 2：去重读 facade 快照（单例）。
    const { getDownloadFacade } = await import("@/features/download/facade");
    const allTasks: IDownloaderTask[] = getDownloadFacade().snapshot().map((task) => ({
        gid: task.gid,
        status: task.status,
        files: [],
    }));
    return {
        outputDirectory,
        proxy,
        settings,
        taskMetaMap,
        allTasks,
    };
}

async function saveTaskMetaMap(
    taskMetaMap: Record<string, IGlossDownloadTaskMeta>,
) {
    await PersistentStore.set(DOWNLOAD_TASK_META_KEY, taskMetaMap);
}


function resolveExistingTaskStatus(task?: IDownloaderTask | null) {
    switch (task?.status) {
        case "error":
            return "retried" as const;
        case "paused":
            return "resumed" as const;
        case "waiting":
        case "active":
        case "complete":
        default:
            return "exists" as const;
    }
}

function resolveExistingTaskMessage(status: CustomQueueDownloadStatus) {
    switch (status) {
        case "resumed":
            return "自定义下载任务已恢复。";
        case "retried":
            return "自定义下载任务已重试。";
        default:
            return "该自定义下载已在队列中。";
    }
}

export async function queueCustomDownload(
    options: IQueueCustomDownloadOptions,
): Promise<IQueueCustomDownloadResult> {
    const downloadUrl = options.downloadUrl.trim();

    if (!/^https?:\/\//iu.test(downloadUrl)) {
        throw new Error("自定义下载地址必须是 http 或 https 链接。");
    }

    let outputFileName = buildOutputFileName(options);
    const runtime = await getQueueRuntimeContext();
    // 本地名缺后缀时从服务器探测补全，失败回退本地名。
    outputFileName = await ensureFileName(
        downloadUrl,
        outputFileName,
        { "User-Agent": CUSTOM_DOWNLOAD_USER_AGENT },
        runtime.proxy || null,
    );
    const duplicateCriteria = {
        sourceType: "Customize" as const,
        externalId: downloadUrl,
        downloadUrl,
        fileName: outputFileName,
        modTitle: (options.title || outputFileName).trim(),
    };
    const duplicateTasks = findGlossDuplicateTasks(
        runtime.taskMetaMap,
        duplicateCriteria,
    );
    const matchedTask = duplicateTasks[0];

    if (matchedTask) {
        const targetTask = runtime.allTasks.find((task) => {
            return task.gid === matchedTask.gid;
        });
        const status = resolveExistingTaskStatus(targetTask);
        // Wave 2：恢复/重试走 facade（后端 dl_resume/dl_retry），同一 gid。
        const { getDownloadFacade } = await import("@/features/download/facade");
        const facade = getDownloadFacade();
        if (status === "resumed") {
            await facade.resume(matchedTask.gid);
        }
        if (status === "retried") {
            await facade.retry(matchedTask.gid);
        }
        return {
            status,
            gid: matchedTask.gid,
            message: resolveExistingTaskMessage(status),
        };
    }

    // Wave 2：建任务走 facade.enqueue，快照由 facade 接管。
    const { getDownloadFacade } = await import("@/features/download/facade");
    const gid = await getDownloadFacade().enqueue({
        url: downloadUrl,
        dir: runtime.outputDirectory,
        fileName: outputFileName,
        headers: [["User-Agent", CUSTOM_DOWNLOAD_USER_AGENT]],
    });
    const now = new Date().toISOString();
    const nextTaskMetaMap = {
        ...runtime.taskMetaMap,
        [gid]: {
            sourceType: "Customize",
            externalId: downloadUrl,
            modTitle: (options.title || outputFileName).trim(),
            resourceName: outputFileName,
            fileName: outputFileName,
            sourceUrl: downloadUrl,
            downloadUrl,
            createdAt: now,
            taskStatus: "waiting",
            updatedAt: now,
        } satisfies IGlossDownloadTaskMeta,
    };

    await saveTaskMetaMap(nextTaskMetaMap);

    return {
        status: "created",
        gid,
        message: "已添加自定义下载任务。",
    };
}
