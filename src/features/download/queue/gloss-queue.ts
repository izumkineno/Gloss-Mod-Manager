import { ensureFileName, ensureServer, getStoredSettings, resolveDownloadDirectory } from "../meta/engine";
import type { IDownloaderSettings } from "../types";
import { FileHandler } from "@/lib/FileHandler";
import { getUrlFileName, sanitizeFileName } from "@/lib/file-name-utils";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
    findGlossDuplicateLocalMods,
    findGlossDuplicateTasks,
    type IGlossDownloadTaskMeta,
} from "@/lib/gloss-download";
import {
    GLOSS_MOD_WEB_BASE_URL,
    fetchGlossModDetail,
    resolveGlossAssetUrl,
} from "@/lib/gloss-mod-api";
import {
    ARCHIVE_EXTENSIONS,
    resolveLocalModImportSourceType,
    type LocalModImportSourceType,
} from "@/lib/local-mod-import";
import { PersistentStore } from "@/lib/persistent-store";
import { listDownloadMeta, saveDownloadMetaMap } from "@/lib/download-meta";
import type { IDownloaderTask, IDownloaderTaskFile } from "../types";

export type GlossQueueDownloadStatus =
    | "created"
    | "resumed"
    | "retried"
    | "exists"
    | "external"
    | "imported";

type IGlossDownloadModSource = Pick<
    IMod,
    | "id"
    | "mods_author"
    | "mods_content"
    | "mods_image_url"
    | "mods_resource"
    | "mods_title"
    | "mods_version"
    | "game_name"
>;

export interface IQueueGlossDownloadOptions {
    mod?: IGlossDownloadModSource | null;
    modId?: number | string;
    resourceId?: number | string | "latest";
    managerModList?: IModInfo[];
    replaceLocalModId?: number;
    // 用户在设置页填写的 3DM Mods Key（无则走构建期 bake 兜底）。
    apiKey?: string | null;
}

export interface IQueueGlossDownloadResult {
    status: GlossQueueDownloadStatus;
    gid: string | null;
    mod: IGlossDownloadModSource;
    resource: IResource;
    message: string;
}

interface IQueueRuntimeContext {
    outputDirectory: string;
    proxy: string;
    settings: IDownloaderSettings;
    taskMetaMap: Record<string, IGlossDownloadTaskMeta>;
    allTasks: IDownloaderTask[];
}

const GLOSS_DOWNLOAD_USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const ARCHIVE_EXTENSION_PATTERN =
    /\.(tar\.(?:gz|xz|bz2)|zip|7z|rar|tar|gz|xz|bz2)$/iu;
const RESOURCE_FORMAT_ALIAS_MAP: Record<string, string> = {
    "7zip": "7z",
    "tar-gz": "tar.gz",
    tgz: "tar.gz",
    txz: "tar.xz",
    tbz2: "tar.bz2",
};

export function isGlossCloudDriveUrl(url?: string) {
    const normalizedUrl = (url ?? "").trim();

    if (!normalizedUrl) {
        return false;
    }

    return !normalizedUrl.includes("mod.3dmgame.com");
}

export function isGlossCloudDriveResource(resource?: IResource | null) {
    return isGlossCloudDriveUrl(resource?.mods_resource_url);
}

function getUrlExtension(url: string) {
    try {
        const parsed = new URL(url);
        const fileName = decodeURIComponent(
            parsed.pathname.split("/").pop() || "",
        );
        return (
            ARCHIVE_EXTENSION_PATTERN.exec(fileName)?.[0] ??
            /\.[A-Za-z0-9]{1,16}$/u.exec(fileName)?.[0] ??
            ""
        );
    } catch {
        return "";
    }
}

function getFileNameExtension(fileName: string) {
    return (
        ARCHIVE_EXTENSION_PATTERN.exec(fileName)?.[0] ??
        /\.[A-Za-z0-9]{1,16}$/u.exec(fileName)?.[0] ??
        ""
    );
}

function hasExtension(fileName: string) {
    return Boolean(getFileNameExtension(fileName));
}

function normalizeResourceFormat(value?: string) {
    const normalized = (value ?? "")
        .trim()
        .toLowerCase()
        .replace(/^[*.\s]+/u, "")
        .replace(/[()\[\]]/gu, " ");

    if (!normalized) {
        return "";
    }

    const direct = RESOURCE_FORMAT_ALIAS_MAP[normalized] ?? normalized;

    if (/^[a-z0-9]+(?:\.[a-z0-9]+)?$/u.test(direct)) {
        return direct;
    }

    const matched =
        normalized.match(
            /(tar\.(?:gz|xz|bz2)|7z|zip|rar|tar|gz|xz|bz2|exe|dll|pak|bin)\b/u,
        )?.[1] ?? "";

    return RESOURCE_FORMAT_ALIAS_MAP[matched] ?? matched;
}

function hasArchiveSuffix(value?: string) {
    if (!value) {
        return false;
    }

    const normalizedExtension = /^https?:\/\//iu.test(value)
        ? getUrlExtension(value)
        : getFileNameExtension(value);

    return ARCHIVE_EXTENSION_PATTERN.test(normalizedExtension.toLowerCase());
}

async function resolveTaskResourceFormat(metadata?: IGlossDownloadTaskMeta) {
    const directFormat = normalizeResourceFormat(metadata?.resourceFormat);

    if (directFormat) {
        return directFormat;
    }

    if (!metadata?.modId || !metadata?.resourceId) {
        return "";
    }

    try {
        const mod = await fetchGlossModDetail(metadata.modId);
        const resource = mod.mods_resource.find(
            (item) => String(item.id) === String(metadata.resourceId),
        );

        return normalizeResourceFormat(resource?.mods_resource_formart);
    } catch {
        return "";
    }
}

export function buildGlossOutputFileName(resource: IResource) {
    const resourceName = sanitizeFileName(resource.mods_resource_name || "");
    const urlExtension = getUrlExtension(resource.mods_resource_url);
    const formatExtension = normalizeResourceFormat(
        resource.mods_resource_formart,
    )
        ? `.${normalizeResourceFormat(resource.mods_resource_formart)}`
        : "";
    const preferredExtension = urlExtension || formatExtension;

    if (!resourceName) {
        return getUrlFileName(resource.mods_resource_url);
    }

    if (!preferredExtension && hasExtension(resourceName)) {
        return resourceName;
    }

    if (!preferredExtension) {
        return resourceName || getUrlFileName(resource.mods_resource_url);
    }

    const currentExtension = getFileNameExtension(resourceName);

    if (
        currentExtension &&
        currentExtension.toLowerCase() === preferredExtension.toLowerCase()
    ) {
        return resourceName;
    }

    return `${resourceName}${preferredExtension}`;
}

export async function resolveGlossDownloadImportSourceType(
    filePath: string,
    metadata?: IGlossDownloadTaskMeta,
): Promise<LocalModImportSourceType> {
    const directSourceType = resolveLocalModImportSourceType(filePath);

    if (directSourceType === "archive") {
        return directSourceType;
    }

    if (
        hasArchiveSuffix(metadata?.fileName) ||
        hasArchiveSuffix(metadata?.resourceName) ||
        hasArchiveSuffix(metadata?.downloadUrl)
    ) {
        return "archive";
    }

    if (metadata?.sourceType && metadata.sourceType !== "GlossMod") {
        return directSourceType;
    }

    const resourceFormat = await resolveTaskResourceFormat(metadata);

    if (
        ARCHIVE_EXTENSIONS.includes(
            resourceFormat.replace(
                /^.*\./u,
                "",
            ) as (typeof ARCHIVE_EXTENSIONS)[number],
        )
    ) {
        return "archive";
    }

    return directSourceType;
}

function getLatestResource(mod?: IGlossDownloadModSource | null) {
    return (
        mod?.mods_resource.find(
            (resource) => resource.mods_resource_latest_version,
        ) ??
        mod?.mods_resource[0] ??
        null
    );
}

function getDuplicateCriteria(
    mod: IGlossDownloadModSource,
    resource: IResource,
    outputFileName: string,
) {
    return {
        modId: mod.id,
        resourceId: resource.id,
        downloadUrl: resource.mods_resource_url,
        fileName: outputFileName,
        modTitle: mod.mods_title,
    };
}

async function getQueueRuntimeContext(): Promise<IQueueRuntimeContext> {
    const outputDirectory = await resolveDownloadDirectory();
    await FileHandler.createDirectory(outputDirectory);
    await ensureServer({ outputDirectory });

    const settings = await getStoredSettings();
    const proxy = (
        (await PersistentStore.get<string>("downloadProxy", "")) ?? ""
    ).trim();
    const taskMetaMap = await listDownloadMeta();
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
    await saveDownloadMetaMap(taskMetaMap);
}


async function createGlossDownloadTask(
    runtime: IQueueRuntimeContext,
    mod: IGlossDownloadModSource,
    resource: IResource,
    outputFileName: string,
    replaceLocalModId?: number,
) {
    // Wave 2：建任务走 facade.enqueue，meta 落盘保留供导入链路，快照由 facade 接管。
    const { getDownloadFacade } = await import("@/features/download/facade");
    const gid = await getDownloadFacade().enqueue({
        url: resource.mods_resource_url,
        dir: runtime.outputDirectory,
        fileName: outputFileName,
        headers: [
            ["Referer", `${GLOSS_MOD_WEB_BASE_URL}/mod/${mod.id}`],
            ["User-Agent", GLOSS_DOWNLOAD_USER_AGENT],
        ],
    });
    const now = new Date().toISOString();

    const taskMeta: IGlossDownloadTaskMeta = {
        sourceType: "GlossMod",
        externalId: mod.id,
        modId: mod.id,
        resourceId: resource.id,
        replaceLocalModId,
        resourceFormat: resource.mods_resource_formart,
        modTitle:
            (mod.mods_title || resource.mods_resource_name || outputFileName).trim() ||
            outputFileName,
        gameName: mod.game_name,
        resourceName: resource.mods_resource_name,
        fileName: outputFileName,
        author: mod.mods_author,
        version: resource.mods_resource_version || mod.mods_version,
        cover: resolveGlossAssetUrl(mod.mods_image_url),
        content: mod.mods_content,
        sourceUrl: `${GLOSS_MOD_WEB_BASE_URL}/mod/${mod.id}`,
        downloadUrl: resource.mods_resource_url,
        createdAt: now,
        taskStatus: "waiting",
        updatedAt: now,
    };

    const nextTaskMetaMap = {
        ...runtime.taskMetaMap,
        [gid]: taskMeta,
    };

    await saveTaskMetaMap(nextTaskMetaMap);
    runtime.taskMetaMap = nextTaskMetaMap;

    return gid;
}

function getExistingTaskMessage(task: IDownloaderTask, resource: IResource) {
    if (task.status === "complete") {
        return `${resource.mods_resource_name} 已下载完成，可前往下载页查看。`;
    }

    return `${resource.mods_resource_name} 已在下载队列中。`;
}

function getTaskPrimaryFile(task: IDownloaderTask) {
    return task.files.find((item: IDownloaderTaskFile) => item.path) ?? task.files[0] ?? null;
}

async function removeCompletedDuplicateTask(
    runtime: IQueueRuntimeContext,
    task: IDownloaderTask,
) {
    // Wave 2：complete 重下 = 新任务入机；旧终局经 facade.forget 出机（只出机不删文件），落盘文件删除保留。
    const { getDownloadFacade } = await import("@/features/download/facade");
    try {
        await getDownloadFacade().forget(task.gid);
    } catch {
        // 旧任务已被清理属于正常竞态，忽略。
    }
    const primaryFile = getTaskPrimaryFile(task);
    if (primaryFile?.path) {
        const deleted = await FileHandler.deleteFile(primaryFile.path);
        if (!deleted) {
            throw new Error("删除旧下载文件失败，请稍后重试。");
        }
    }
    const nextTaskMetaMap = { ...runtime.taskMetaMap };
    delete nextTaskMetaMap[task.gid];
    await saveTaskMetaMap(nextTaskMetaMap);
    runtime.taskMetaMap = nextTaskMetaMap;
    runtime.allTasks = runtime.allTasks.filter((item) => item.gid !== task.gid);
}

export async function queueGlossModDownload(
    options: IQueueGlossDownloadOptions,
): Promise<IQueueGlossDownloadResult> {
    const mod = options.mod ?? (await fetchGlossModDetail(options.modId ?? "", options.apiKey));
    const resource =
        options.resourceId === undefined || options.resourceId === "latest"
            ? getLatestResource(mod)
            : (mod.mods_resource.find(
                  (item) => String(item.id) === String(options.resourceId),
              ) ?? null);

    if (!resource?.mods_resource_url) {
        throw new Error("未找到可下载的资源。");
    }

    if (isGlossCloudDriveResource(resource)) {
        await openUrl(resource.mods_resource_url);

        return {
            status: "external",
            gid: null,
            mod,
            resource,
            message: `已打开 ${resource.mods_resource_name} 的网盘链接，请在浏览器中手动下载。`,
        };
    }

    let outputFileName = buildGlossOutputFileName(resource);
    const runtime = await getQueueRuntimeContext();
    // 本地名缺后缀时从服务器探测补全，失败回退本地名。
    outputFileName = await ensureFileName(
        resource.mods_resource_url,
        outputFileName,
        {
            Referer: `${GLOSS_MOD_WEB_BASE_URL}/mod/${mod.id}`,
            "User-Agent": GLOSS_DOWNLOAD_USER_AGENT,
        },
        runtime.proxy || null,
    );
    const duplicateCriteria = getDuplicateCriteria(
        mod,
        resource,
        outputFileName,
    );
    const duplicateLocalMods = findGlossDuplicateLocalMods(
        options.managerModList ?? [],
        duplicateCriteria,
    );
    const allowReplacingLocalMod =
        Number.isFinite(Number(options.replaceLocalModId)) &&
        Number(options.replaceLocalModId) > 0;

    if (duplicateLocalMods.length > 0 && !allowReplacingLocalMod) {
        return {
            status: "imported",
            gid: null,
            mod,
            resource,
            message: `${mod.mods_title} 已在本地管理列表中。`,
        };
    }
    const duplicateTasks = findGlossDuplicateTasks(
        runtime.taskMetaMap,
        duplicateCriteria,
    )
        .map((item) => ({
            task:
                runtime.allTasks.find((task) => task.gid === item.gid) ?? null,
            meta: item.meta,
        }))
        .filter(
            (
                item,
            ): item is { task: IDownloaderTask; meta: IGlossDownloadTaskMeta } =>
                item.task !== null && item.task.status !== "removed",
        );

    if (duplicateTasks.length > 0) {
        const currentTask = duplicateTasks[0].task;

        if (currentTask.status === "complete") {
            await removeCompletedDuplicateTask(runtime, currentTask);

            const gid = await createGlossDownloadTask(
                runtime,
                mod,
                resource,
                outputFileName,
                options.replaceLocalModId,
            );

            return {
                status: "retried",
                gid,
                mod,
                resource,
                message: `已重新下载：${resource.mods_resource_name}`,
            };
        }

        const nextTaskMetaMap: Record<string, IGlossDownloadTaskMeta> = {
            ...runtime.taskMetaMap,
            [currentTask.gid]: {
                ...runtime.taskMetaMap[currentTask.gid],
                replaceLocalModId:
                    options.replaceLocalModId ??
                    runtime.taskMetaMap[currentTask.gid]?.replaceLocalModId,
                taskStatus: currentTask.status as TaskStatus,
                updatedAt: new Date().toISOString(),
            },
        };

        if (currentTask.status === "paused") {
            // Wave 2：恢复走 facade.resume（后端 dl_resume）。
            const { getDownloadFacade } = await import("@/features/download/facade");
            await getDownloadFacade().resume(currentTask.gid);
            nextTaskMetaMap[currentTask.gid].taskStatus = "waiting";
            await saveTaskMetaMap(nextTaskMetaMap);
            return {
                status: "resumed",
                gid: currentTask.gid,
                mod,
                resource,
                message: `已继续下载任务：${resource.mods_resource_name}`,
            };
        }
        if (currentTask.status === "error") {
            // Wave 2：同一 gid retry（保留断点），禁止删建新 gid。
            const { getDownloadFacade } = await import("@/features/download/facade");
            await getDownloadFacade().retry(currentTask.gid);
            return {
                status: "retried",
                gid: currentTask.gid,
                mod,
                resource,
                message: `已重新加入下载队列：${resource.mods_resource_name}`,
            };
        }

        await saveTaskMetaMap(nextTaskMetaMap);

        return {
            status: "exists",
            gid: currentTask.gid,
            mod,
            resource,
            message: getExistingTaskMessage(currentTask, resource),
        };
    }

    const gid = await createGlossDownloadTask(
        runtime,
        mod,
        resource,
        outputFileName,
        options.replaceLocalModId,
    );

    return {
        status: "created",
        gid,
        mod,
        resource,
        message: `已添加 ${resource.mods_resource_name} 到下载队列。`,
    };
}
