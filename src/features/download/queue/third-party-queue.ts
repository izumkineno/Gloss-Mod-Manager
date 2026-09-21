import { openUrl } from "@tauri-apps/plugin-opener";
import { ensureFileName, ensureServer, getStoredSettings, resolveDownloadDirectory } from "../meta/engine";
import {
    type IDownloaderTask,
    type IDownloaderSettings,
} from "../types";
import { FileHandler } from "@/lib/FileHandler";
import { getUrlFileName, sanitizeFileName } from "@/lib/file-name-utils";
import {
    findGlossDuplicateLocalMods,
    findGlossDuplicateTasks,
    type IGlossDownloadTaskMeta,
} from "@/lib/gloss-download";
import { getDownloadStore } from "@/lib/download-store";
import { listDownloadMeta, putDownloadMeta } from "@/lib/download-meta";
import {
    fetchNexusModsSingleFileName,
    resolveThirdPartyDownloadUrl,
    type INexusModsDirectOptions,
    type IThirdPartyModDetail,
    type IThirdPartyModFile,
    type INexusModsDownloadAuthorization,
    type ThirdPartyProvider,
} from "@/lib/third-party-mod-api";

export type ThirdPartyQueueDownloadStatus =
    | "created"
    | "resumed"
    | "retried"
    | "exists"
    | "external"
    | "imported";
export interface IQueueThirdPartyDownloadOptions {
    provider: ThirdPartyProvider;
    mod: IThirdPartyModDetail;
    fileId?: string;
    gameName?: string;
    managerModList?: IModInfo[];
    nexusUser?: INexusModsUser | null;
    nexusDownloadAuthorization?: INexusModsDownloadAuthorization | null;
    nexusDirect?: INexusModsDirectOptions | null;
    replaceLocalModId?: number;
    collectionId?: string;
}

export interface IQueueThirdPartyDownloadResult {
    status: ThirdPartyQueueDownloadStatus;
    gid: string | null;
    mod: IThirdPartyModDetail;
    file: IThirdPartyModFile;
    message: string;
}

interface IQueueRuntimeContext {
    outputDirectory: string;
    proxy: string;
    settings: IDownloaderSettings;
    taskMetaMap: Record<string, IGlossDownloadTaskMeta>;
    allTasks: IDownloaderTask[];
}

const THIRD_PARTY_DOWNLOAD_USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const FILE_EXTENSION_PATTERN =
    /\.(tar\.(?:gz|xz|bz2)|zip|7z|rar|tar|gz|xz|bz2|exe|dll|pak|bin)$/iu;

function getUrlExtension(url: string) {
    try {
        const parsed = new URL(url);
        const fileName = decodeURIComponent(
            parsed.pathname.split("/").pop() || "",
        );

        return (
            FILE_EXTENSION_PATTERN.exec(fileName)?.[0] ??
            /\.[A-Za-z0-9]{1,16}$/u.exec(fileName)?.[0] ??
            ""
        );
    } catch {
        return "";
    }
}

function getFileNameExtension(fileName: string) {
    return (
        FILE_EXTENSION_PATTERN.exec(fileName)?.[0] ??
        /\.[A-Za-z0-9]{1,16}$/u.exec(fileName)?.[0] ??
        ""
    );
}

function buildOutputFileName(
    mod: IThirdPartyModDetail,
    file: IThirdPartyModFile,
    downloadUrl: string,
) {
    // 真实文件名（含 Nexus file_name）优先：自带后缀，直接可用。
    const realName = sanitizeFileName(file.fileName || "");
    if (realName && getFileNameExtension(realName)) {
        return realName;
    }
    const baseName = sanitizeFileName(
        file.name || realName || `${mod.source}-${mod.id}-${file.id}`,
    );
    const currentExtension = getFileNameExtension(baseName);

    if (currentExtension) {
        return baseName;
    }

    const urlExtension = getUrlExtension(downloadUrl);
    if (urlExtension) {
        return `${baseName}${urlExtension}`;
    }

    const urlFileName = getUrlFileName(downloadUrl);
    const out = baseName || urlFileName || "download.bin";
    if (out === "download.bin") console.warn(`[uuid-trace] buildOutputFileName fallback mod=${mod.id} file=${file.id} baseName="${String(baseName).slice(0,80)}" urlFileName="${String(urlFileName).slice(0,80)}" downloadUrl_head=${downloadUrl.slice(0,80)}`);
    return out;
}

function shouldOpenExternally(
    provider: ThirdPartyProvider,
    downloadUrl: string,
) {
    if (!/^https?:\/\//iu.test(downloadUrl)) {
        return false;
    }

    if (provider === "NexusMods") {
        return /:\/\/www\.nexusmods\.com\//iu.test(downloadUrl);
    }

    return false;
}

async function getQueueRuntimeContext(): Promise<IQueueRuntimeContext> {
    const outputDirectory = await resolveDownloadDirectory();
    await FileHandler.createDirectory(outputDirectory);
    await ensureServer({ outputDirectory });

    const settings = await getStoredSettings();
    const proxy = (
        (await getDownloadStore<string>("downloadProxy", "")) ?? ""
    ).trim();
    const taskMetaMap = await listDownloadMeta();
    // Wave 2：去重读 facade 快照（单例），不再 tellActive/tellWaiting/tellStopped。
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

async function createThirdPartyDownloadTask(
    runtime: IQueueRuntimeContext,
    options: IQueueThirdPartyDownloadOptions,
    file: IThirdPartyModFile,
    downloadUrl: string,
    outputFileName: string,
) {
    // Wave 2：建任务走 facade.enqueue（后端 dl_enqueue 真签），meta/快照由 facade 接管。
    const { getDownloadFacade } = await import("@/features/download/facade");
    const gid = await getDownloadFacade().enqueue(
        {
            url: downloadUrl,
            dir: runtime.outputDirectory,
            fileName: outputFileName,
            collectionId: options.collectionId,
            headers: [
                ["Referer", options.mod.website || "https://www.nexusmods.com/"],
                ["User-Agent", THIRD_PARTY_DOWNLOAD_USER_AGENT],
            ],
        },
    );
    const now = new Date().toISOString();

    const taskMeta: IGlossDownloadTaskMeta = {
        sourceType: options.provider as sourceType,
        externalId: options.mod.id,
        resourceId: file.id,
        replaceLocalModId: options.replaceLocalModId,
        // 治本：title 为空时逐级回退，保证卡片左侧标题恒有值（download.vue:2296 v-if）。
        modTitle:
            (options.mod.title || file.name || outputFileName).trim() || outputFileName,
        gameName: options.gameName || "",
        resourceName: file.name,
        fileName: outputFileName,
        version: file.version || options.mod.version,
        cover: options.mod.cover,
        content: options.mod.description || options.mod.summary,
        sourceUrl: options.mod.website,
        downloadUrl,
        createdAt: now,
        taskStatus: "waiting",
        updatedAt: now,
    };

    if (!outputFileName || !taskMeta.fileName) {
        console.warn(`[uuid-trace] createThirdPartyDownloadTask put gid=${gid} fileName_EMPTY outputFileName=${String(outputFileName ?? "")} file.name=${file.name ?? ""} file.fileName=${file.fileName ?? ""} downloadUrl_head=${downloadUrl.slice(0, 80)}`);
    } else {
        console.debug(`[uuid-trace] createThirdPartyDownloadTask put gid=${gid} fileName=${outputFileName}`);
    }
    // 单条写入：合集重试并发建任务时，整表覆盖会互相吞 meta（读-改-写旧快照）。
    await putDownloadMeta(gid, taskMeta);
    runtime.taskMetaMap[gid] = taskMeta;

    return gid;
}

function getExistingTaskMessage(task: IDownloaderTask, file: IThirdPartyModFile) {
    if (task.status === "complete") {
        return `${file.name} 已下载完成，可前往下载页查看。`;
    }

    return `${file.name} 已在下载队列中。`;
}

export async function queueThirdPartyModDownload(
    options: IQueueThirdPartyDownloadOptions,
): Promise<IQueueThirdPartyDownloadResult> {
    // 全链路分段日志：定位重建卡在哪一段（resolve 前/后、去重分支、建任务）。
    const queueTag = `[queue] modId=${options.mod.id} fileId=${options.fileId ?? ""}`;
    let file =
        options.mod.files.find((item) => item.id === options.fileId) ??
        options.mod.primaryFile;

    if (!file) {
        throw new Error("未找到可下载的资源。");
    }

    console.debug(`${queueTag} stage=file-resolved fileName=${file.name ?? ""}`);
    console.debug(`${queueTag} stage=resolve-url-start mode=${options.nexusDirect?.mode ?? "api"}`);
    const resolveStart = Date.now();
    const downloadUrl = (
        await resolveThirdPartyDownloadUrl(
            options.mod,
            file.id,
            options.nexusUser,
            options.nexusDownloadAuthorization,
            options.nexusDirect,
        )
    ).trim();
    console.debug(`${queueTag} stage=resolve-url-done costMs=${Date.now() - resolveStart} urlLen=${downloadUrl.length} urlHead=${downloadUrl.slice(0, 60)}`);

    if (!downloadUrl) {
        throw new Error("当前资源暂时没有可用下载地址。");
    }

    if (shouldOpenExternally(options.provider, downloadUrl)) {
        await openUrl(downloadUrl);

        return {
            status: "external",
            gid: null,
            mod: options.mod,
            file,
            message: `当前资源无法获取直链，已打开 ${options.provider} 网页。`,
        };
    }
    // 治本：最小 detail 缺 fileName 时，用单文件接口回填权威 file_name（含后缀）。
    // 接口 403/失败返回空，不阻塞，后续走 probe 回退。
    if (options.provider === "NexusMods" && !file.fileName?.trim()) {
        const gameDomain = options.mod.routeQuery.gameDomain?.trim() ?? "";
        if (gameDomain) {
            const hydrated = await fetchNexusModsSingleFileName(gameDomain, options.mod.id, file.id, options.nexusUser);
            if (hydrated) {
                file = { ...file, fileName: hydrated };
                console.debug(`${queueTag} stage=file-hydrated fileName=${hydrated}`);
            } else {
                console.warn(`[uuid-trace] hydrate-miss modId=${options.mod.id} fileId=${file.id} — fileName still empty after single-file API`);
            }
        }
    }
    const beforeFileName = file.fileName ?? "";
    let outputFileName = buildOutputFileName(options.mod, file, downloadUrl);
    if (!outputFileName) console.warn(`[uuid-trace] buildOutputFileName empty mod=${options.mod.id} file=${file.id} before=${String(beforeFileName).slice(0,80)}`);

    console.debug(`${queueTag} stage=url-ok`);
    let duplicateCriteria = {
        sourceType: options.provider as sourceType,
        externalId: options.mod.id,
        resourceId: file.id,
        downloadUrl,
        fileName: outputFileName,
        modTitle: options.mod.title,
    };
    const duplicateLocalMods = findGlossDuplicateLocalMods(
        options.managerModList ?? [],
        duplicateCriteria,
    );
    const allowReplacingLocalMod =
        Number.isFinite(Number(options.replaceLocalModId)) &&
        Number(options.replaceLocalModId) > 0;

    // 只有同一来源 webId 双匹配（score>=100）才算真重复：文件名/标题命中（60/40）误伤太多，
    // 只记日志不拦截，同名落盘由改名逻辑兜底。
    const identityDuplicate = duplicateLocalMods.find((item) => item.score >= 100) ?? null;
    console.debug(`${queueTag} stage=local-dedupe hits=${duplicateLocalMods.length} best=${duplicateLocalMods[0]?.score ?? 0}:${duplicateLocalMods[0]?.reason ?? "none"}`);
    if (identityDuplicate && !allowReplacingLocalMod) {
        return {
            status: "imported",
            gid: null,
            mod: options.mod,
            file,
            message: `${options.mod.title} 已在本地管理列表中。`,
        };
    }

    const runtime = await getQueueRuntimeContext();
    console.debug(`${queueTag} stage=runtime-ready`);
    // 本地名缺后缀时从服务器探测补全（Nexus CDN 等哈希直链），失败回退本地名。
    outputFileName = await ensureFileName(
        downloadUrl,
        outputFileName,
        {
            Referer: options.mod.website || "https://www.nexusmods.com/",
            "User-Agent": THIRD_PARTY_DOWNLOAD_USER_AGENT,
        },
        runtime.proxy || null,
    );
    // 治本第二道闸：到这里仍无后缀说明回填+探测全失败，直接抛错不建任务，
    // 避免无后缀文件再次落盘（禁止事后补后缀）。
    if (!getFileNameExtension(outputFileName)) {
        console.error(`[uuid-trace] extension gate block mod=${options.mod.id} file=${file.id} outputFileName="${String(outputFileName).slice(0,120)}" file.name="${String(file.name).slice(0,80)}" file.fileName="${String(file.fileName ?? "").slice(0,80)}"`);
        throw new Error(`未能获取 ${file.name} 的真实文件名（含后缀），已阻止建任务，请稍后重试。`);
    }
    duplicateCriteria = { ...duplicateCriteria, fileName: outputFileName };
    console.debug(`${queueTag} stage=filename-probed final=${outputFileName}`);
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
    console.debug(`${queueTag} stage=task-dedupe hits=${duplicateTasks.length}`);

    if (duplicateTasks.length > 0) {
        const currentTask = duplicateTasks[0].task;
    console.debug(`${queueTag} stage=dedupe-hit gid=${currentTask.gid} status=${currentTask.status}`);

        if (currentTask.status === "complete") {
            // 已完成任务直接复用，不删除、不新建，避免重复下载。
            return {
                status: "exists",
                gid: currentTask.gid,
                mod: options.mod,
                file,
                message: "已下载",
            };
        }

        if (currentTask.status === "paused") {
            // 暂停闸开着时保持暂停，不自动恢复；由用户显式继续。
            return {
                status: "exists",
                gid: currentTask.gid,
                mod: options.mod,
                file,
                message: `已在下载队列中（已暂停）：${file.name}`,
            };
        }

        if (currentTask.status === "error") {
            // Wave 2：同一 gid retry（保留断点），禁止删建新 gid。
            const { getDownloadFacade } = await import("@/features/download/facade");
            await getDownloadFacade().retry(currentTask.gid);
            return {
                status: "retried",
                gid: currentTask.gid,
                mod: options.mod,
                file,
                message: `已重新加入下载队列：${file.name}`,
            };
        }

            if (!outputFileName) console.warn(`[uuid-trace] third-party exists branch fileName EMPTY gid=${currentTask.gid} provider=${options.provider} file.name=${file.name ?? ""} file.fileName=${file.fileName ?? ""}`);
        // 单键写入：只更新该任务自身状态投影，不用旧快照覆盖整表（并发建任务会互相洗 meta）。
        const existsMeta = {
            ...runtime.taskMetaMap[currentTask.gid],
            replaceLocalModId:
                options.replaceLocalModId ??
                runtime.taskMetaMap[currentTask.gid]?.replaceLocalModId,
            taskStatus: currentTask.status as TaskStatus,
            updatedAt: new Date().toISOString(),
        };
        await putDownloadMeta(currentTask.gid, existsMeta);
        runtime.taskMetaMap = {
            ...runtime.taskMetaMap,
            [currentTask.gid]: existsMeta,
        };

        return {
            status: "exists",
            gid: currentTask.gid,
            mod: options.mod,
            file,
            message: getExistingTaskMessage(currentTask, file),
        };
    }

    const gid = await createThirdPartyDownloadTask(
        runtime,
        options,
        file,
        downloadUrl,
        outputFileName,
    );

    return {
        status: "created",
        gid,
        mod: options.mod,
        file,
        message: `已添加 ${file.name} 到下载队列。`,
    };
}
