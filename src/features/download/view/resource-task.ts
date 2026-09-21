// Gloss 资源建任务编排（Wave 3.6 机械抽取）：去重判定/建任务/meta 落盘/继续已有。
// 与 download.vue 原实现逐行一致，只挪位置；probe 链路（ensureFileName）只挪调用位置零改动。
import { ref } from "vue";
import { ElMessage } from "element-plus-message";
import { ensureFileName } from "../meta/engine";
import { getDownloadFacade } from "../facade";
import { buildGlossOutputFileName } from "../queue/helpers";
import { buildUniqueGlossFileName, findGlossDuplicateTasks, getGlossModPresence } from "@/lib/gloss-download";
import type { IGlossDownloadTaskMeta } from "@/lib/gloss-download";
import type { IDownloaderTask } from "../types";
import { getErrorMessage, getTaskDisplayName } from "./task-display";
import type { DuplicateDecisionAction } from "./dedupe";

export const GLOSS_MOD_API_BASE_URL = "https://mod.3dmgame.com/api/v3";
export const GLOSS_MOD_WEB_BASE_URL = "https://mod.3dmgame.com";
const GLOSS_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// 内置详情占位封面（Mod 无封面时用）。
export const EMPTY_POSTER =
    "data:image/svg+xml;charset=UTF-8," +
    encodeURIComponent(`
		<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
			<defs>
				<linearGradient id="download-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
					<stop offset="0%" stop-color="#121212" />
					<stop offset="55%" stop-color="#4a2d15" />
					<stop offset="100%" stop-color="#dfa85d" />
				</linearGradient>
			</defs>
			<rect width="640" height="360" rx="24" fill="url(#download-gradient)" />
			<circle cx="120" cy="84" r="72" fill="rgba(255,255,255,0.08)" />
			<circle cx="540" cy="280" r="96" fill="rgba(255,255,255,0.08)" />
			<text x="42" y="206" fill="#fff5df" font-size="40" font-family="Arial, sans-serif">Gloss Download</text>
			<text x="42" y="246" fill="#ffe0a3" font-size="22" font-family="Arial, sans-serif">内置详情与下载</text>
		</svg>
	`);

export interface IAddResourceTaskResult {
    handled: boolean;
    gid: string | null;
}

export interface IResourceDuplicateTask {
    task: IDownloaderTask;
    meta: IGlossDownloadTaskMeta;
    score: number;
}

export interface ResourceDeps {
    selectedMod: IMod | null;
    taskMetaMap: Record<string, IGlossDownloadTaskMeta>;
    allTasks: IDownloaderTask[];
    resolvedDownloadDirectory: string;
    downloadProxy: string;
    managerModList: IModInfo[];
    ensureEngineReady: () => Promise<string>;
    setTaskMeta: (gid: string, metadata: IGlossDownloadTaskMeta) => void;
    refreshTaskLists: (silent?: boolean) => Promise<void>;
    removeTaskRecord: (task: IDownloaderTask) => Promise<void>;
    retryTask: (task: IDownloaderTask) => Promise<string | null>;
    resumeTask: (task: IDownloaderTask) => Promise<void>;
    hideAddModDialog: () => void;
    showTaskDetail: (gid: string) => void;
    promptDuplicateDecision: (options: {
        title: string;
        description: string;
        note?: string;
        items: Array<{ title: string; description: string; badges: string[] }>;
        actions: Array<{ value: DuplicateDecisionAction; label: string; description: string; variant?: "default" | "outline" | "destructive" }>;
    }) => Promise<DuplicateDecisionAction>;
}

// 资源建任务进行键（右键菜单 disabled 用）。
export function useResourceAdding() {
    const addingResourceKey = ref("");

    function isResourceAdding(resource: IResource, modId?: number | string): boolean {
        return addingResourceKey.value === `${modId}-${resource.id ?? resource.mods_resource_name}`;
    }

    return { addingResourceKey, isResourceAdding };
}

// 输出文件名：Gloss 资源名规范命名。
export function buildOutputFileName(resource: IResource): string {
    return buildGlossOutputFileName(resource);
}

// Gloss 静态资源地址解析：绝对地址直返，相对地址拼站根，空走占位封面。
export function resolveGlossAssetUrl(path?: string): string {
    if (!path) {
        return EMPTY_POSTER;
    }

    if (/^https?:\/\//u.test(path)) {
        return path;
    }

    const normalized = path.startsWith("/") ? path : `/${path}`;

    return `${GLOSS_MOD_WEB_BASE_URL}${normalized}`;
}

// 去重弹窗徽标：状态 + 资源名 + 文件名。
export function getDuplicateDialogItemBadges(
    task: IDownloaderTask,
    metadata: IGlossDownloadTaskMeta,
    statusLabel: (status: string) => string,
): string[] {
    const badges = [statusLabel(task.status)];

    if (metadata.resourceName) {
        badges.push(metadata.resourceName);
    }

    if (metadata.fileName) {
        badges.push(metadata.fileName);
    }

    return badges;
}

// 当前资源的重复任务：按 mod/资源/url/文件名打分，过滤已移除。
export function findResourceDuplicateTasks(
    resource: IResource,
    deps: ResourceDeps,
): IResourceDuplicateTask[] {
    if (!deps.selectedMod) {
        return [];
    }

    return findGlossDuplicateTasks(deps.taskMetaMap, {
        modId: deps.selectedMod.id,
        resourceId: resource.id,
        downloadUrl: resource.mods_resource_url,
        fileName: buildOutputFileName(resource),
        modTitle: deps.selectedMod.mods_title,
    })
        .map((item) => {
            const task = deps.allTasks.find(
                (current) => current.gid === item.gid,
            );

            if (!task) {
                return null;
            }

            return {
                task,
                meta: item.meta,
                score: item.score,
            };
        })
        .filter((item): item is IResourceDuplicateTask => item !== null)
        .filter((item) => item.task.status !== "removed");
}

// 资源存在态（本地/队列）：无选中 Mod 时按空条件查。
export function getResourcePresence(
    resource: IResource,
    deps: ResourceDeps,
): ReturnType<typeof getGlossModPresence> {
    if (!deps.selectedMod) {
        return getGlossModPresence(
            deps.taskMetaMap,
            deps.managerModList,
            {},
        );
    }

    return getGlossModPresence(deps.taskMetaMap, deps.managerModList, {
        modId: deps.selectedMod.id,
        resourceId: resource.id,
        downloadUrl: resource.mods_resource_url,
        fileName: buildOutputFileName(resource),
        modTitle: deps.selectedMod.mods_title,
    });
}

// 资源按钮文案：按存在态映射。
export function getResourceActionLabel(
    resource: IResource,
    deps: ResourceDeps,
): string {
    const presence = getResourcePresence(resource, deps);

    switch (presence.state) {
        case "active":
            return "查看下载";
        case "waiting":
            return "已在队列";
        case "paused":
            return "继续处理";
        case "error":
            return "重试或处理";
        case "complete":
            return "已下载";
        case "imported":
            return "已在本地";
        default:
            return "添加到下载队列";
    }
}

// 全部相关文件名（含本次输出名）：keep-both 改名时避让用。
export function getAllDuplicateTaskFileNames(
    resource: IResource,
    deps: ResourceDeps,
): string[] {
    const fileNames = findResourceDuplicateTasks(resource, deps)
        .map((item) => item.meta.fileName || getTaskDisplayName(item.task, item.meta))
        .filter(Boolean);

    fileNames.push(buildOutputFileName(resource));
    return fileNames;
}

// 资源建任务内核：探测补全文件名后 facade.enqueue，meta 落盘。
export async function createResourceTask(
    resource: IResource,
    outputFileName: string,
    deps: ResourceDeps,
    addingResourceKey: { value: string },
): Promise<string | null> {
    if (!deps.selectedMod) {
        return null;
    }

    const resourceKey = `${deps.selectedMod.id}-${resource.id ?? resource.mods_resource_name}`;
    addingResourceKey.value = resourceKey;

    try {
        const outputDirectory = await deps.ensureEngineReady();
        const trimmedProxy = (deps.downloadProxy ?? "").trim();
        // 本地名缺后缀时从服务器探测补全，失败回退原名。
        outputFileName = await ensureFileName(
            resource.mods_resource_url,
            outputFileName,
            {
                referer: `${GLOSS_MOD_WEB_BASE_URL}/mod/${deps.selectedMod.id}`,
                "user-agent": GLOSS_UA,
            },
            trimmedProxy || null,
        );
        // Wave 3：页内建任务走 facade.enqueue（后端 dl_enqueue），meta 落盘保留。
        const gid = await getDownloadFacade().enqueue({
            url: resource.mods_resource_url,
            dir: outputDirectory,
            fileName: outputFileName,
            headers: [
                ["Referer", `${GLOSS_MOD_WEB_BASE_URL}/mod/${deps.selectedMod.id}`],
                ["User-Agent", GLOSS_UA],
            ],
        });
        const now = new Date().toISOString();

        deps.setTaskMeta(gid, {
            sourceType: "GlossMod",
            externalId: deps.selectedMod.id,
            modId: deps.selectedMod.id,
            resourceId: resource.id,
            resourceFormat: resource.mods_resource_formart,
            modTitle: deps.selectedMod.mods_title,
            gameName: deps.selectedMod.game_name,
            resourceName: resource.mods_resource_name,
            fileName: outputFileName,
            author: deps.selectedMod.mods_author,
            version:
                resource.mods_resource_version ||
                deps.selectedMod.mods_version,
            cover: resolveGlossAssetUrl(deps.selectedMod.mods_image_url),
            content: deps.selectedMod.mods_content,
            sourceUrl: `${GLOSS_MOD_WEB_BASE_URL}/mod/${deps.selectedMod.id}`,
            downloadUrl: resource.mods_resource_url,
            createdAt: now,
            taskStatus: "waiting",
            updatedAt: now,
        });

        ElMessage.success(`已添加 ${resource.mods_resource_name} 到下载队列。`);
        await deps.refreshTaskLists();
        deps.showTaskDetail(gid);
        deps.hideAddModDialog();
        return gid;
    } catch (error: unknown) {
        console.error("添加下载任务失败");
        console.error(error);
        ElMessage.error(getErrorMessage(error));
        return null;
    } finally {
        addingResourceKey.value = "";
    }
}

// 复用已有任务：paused 继续，error 重试，其余定位。
export async function continueExistingTask(
    task: IDownloaderTask,
    deps: ResourceDeps,
): Promise<string> {
    deps.hideAddModDialog();

    if (task.status === "paused") {
        await deps.resumeTask(task);
        deps.showTaskDetail(task.gid);
        ElMessage.success(`已继续现有任务：${getTaskDisplayName(task, deps.taskMetaMap[task.gid])}`);
        return task.gid;
    }

    if (task.status === "error") {
        const retriedGid = await deps.retryTask(task);

        if (retriedGid) {
            deps.showTaskDetail(retriedGid);
        }

        return retriedGid ?? task.gid;
    }

    deps.showTaskDetail(task.gid);
    deps.hideAddModDialog();
    ElMessage.info(`已定位到现有任务：${getTaskDisplayName(task, deps.taskMetaMap[task.gid])}`);
    return task.gid;
}

// 资源添加入口：去重弹窗决策（取消/继续/覆盖/同时存在），无重复直建。
export async function addResourceTask(
    resource: IResource,
    deps: ResourceDeps,
    addingResourceKey: { value: string },
    statusLabel: (status: string) => string,
): Promise<IAddResourceTaskResult> {
    if (!deps.selectedMod) {
        return {
            handled: false,
            gid: null,
        };
    }

    const duplicateTasks = findResourceDuplicateTasks(resource, deps);

    if (duplicateTasks.length > 0) {
        const decision = await deps.promptDuplicateDecision({
            title: "发现重复下载任务",
            description: `${deps.selectedMod.mods_title} 已经存在相同下载记录。`,
            note: "继续会优先沿用当前最接近的任务；覆盖会删除现有记录后重新下载；同时存在会自动改一个新文件名。",
            items: duplicateTasks.map((item) => ({
                title: item.meta.modTitle || getTaskDisplayName(item.task, item.meta),
                description:
                    item.task.errorMessage ||
                    `保存到 ${item.task.dir || deps.resolvedDownloadDirectory || "当前下载目录"}`,
                badges: getDuplicateDialogItemBadges(item.task, item.meta, statusLabel),
            })),
            actions: [
                {
                    value: "cancel",
                    label: "取消",
                    description: "保留现状，不再添加新任务。",
                    variant: "outline",
                },
                {
                    value: "continue",
                    label: "继续",
                    description: "优先复用或恢复现有任务。",
                },
                {
                    value: "overwrite",
                    label: "覆盖",
                    description: "移除现有任务，按原文件名重新下载。",
                    variant: "destructive",
                },
                {
                    value: "keep-both",
                    label: "同时存在",
                    description: "自动改名后另存一份。",
                    variant: "outline",
                },
            ],
        });

        if (decision === "cancel") {
            ElMessage.info("已取消重复下载。");
            return {
                handled: true,
                gid: null,
            };
        }

        if (decision === "continue") {
            return {
                handled: true,
                gid: await continueExistingTask(duplicateTasks[0].task, deps),
            };
        }

        if (decision === "overwrite") {
            for (const item of duplicateTasks) {
                await deps.removeTaskRecord(item.task);
            }

            const gid = await createResourceTask(
                resource,
                buildOutputFileName(resource),
                deps,
                addingResourceKey,
            );

            return {
                handled: gid !== null,
                gid,
            };
        }

        const gid = await createResourceTask(
            resource,
            buildUniqueGlossFileName(
                buildOutputFileName(resource),
                getAllDuplicateTaskFileNames(resource, deps),
            ),
            deps,
            addingResourceKey,
        );

        return {
            handled: gid !== null,
            gid,
        };
    }

    const gid = await createResourceTask(
        resource,
        buildOutputFileName(resource),
        deps,
        addingResourceKey,
    );

    return {
        handled: gid !== null,
        gid,
    };
}
