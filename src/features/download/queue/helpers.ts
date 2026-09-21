// 队列纯函数迁移层（Wave 3）：原 gloss-download-queue.ts 的无状态帮助。
// 建任务/去重已走 facade；此处仅保留文件名/网盘判定/队列选项类型供 selection/mcp 复用。
// 后续调用方改直读 facade 后可再删本层。
import { getUrlFileName, sanitizeFileName } from "@/lib/file-name-utils";

export type GlossQueueDownloadStatus =
    | "created"
    | "resumed"
    | "retried"
    | "exists"
    | "external"
    | "imported";

export interface IQueueGlossDownloadOptions {
    mod?: Pick<IMod, "id" | "mods_author" | "mods_content" | "mods_image_url" | "mods_resource" | "mods_title" | "mods_version" | "game_name"> | null;
    modId?: number | string;
    resourceId?: number | string | "latest";
    managerModList?: IModInfo[];
    replaceLocalModId?: number;
    apiKey?: string | null;
}

export interface IQueueGlossDownloadResult {
    status: GlossQueueDownloadStatus;
    gid: string | null;
    mod: NonNullable<IQueueGlossDownloadOptions["mod"]>;
    resource: IResource;
    message: string;
}

const ARCHIVE_EXTENSION_PATTERN =
    /\.(tar\.(?:gz|xz|bz2)|zip|7z|rar|tar|gz|xz|bz2)$/iu;

export function isGlossCloudDriveUrl(url?: string): boolean {
    const normalizedUrl = (url ?? "").trim();

    if (!normalizedUrl) {
        return false;
    }

    return !normalizedUrl.includes("mod.3dmgame.com");
}

export function isGlossCloudDriveResource(resource?: IResource | null): boolean {
    return isGlossCloudDriveUrl(resource?.mods_resource_url);
}

function getUrlExtension(url: string): string {
    try {
        const parsed = new URL(url);
        const fileName = decodeURIComponent(parsed.pathname.split("/").pop() || "");
        return (
            ARCHIVE_EXTENSION_PATTERN.exec(fileName)?.[0] ??
            /\.[A-Za-z0-9]{1,16}$/u.exec(fileName)?.[0] ??
            ""
        );
    } catch {
        return "";
    }
}

export function buildGlossOutputFileName(resource: IResource): string {
    const resourceName = sanitizeFileName(resource.mods_resource_name || "");
    const urlExtension = getUrlExtension(resource.mods_resource_url);

    if (!resourceName) {
        return getUrlFileName(resource.mods_resource_url);
    }

    if (urlExtension) {
        const currentExtension = ARCHIVE_EXTENSION_PATTERN.exec(resourceName)?.[0] ?? "";
        if (currentExtension.toLowerCase() === urlExtension.toLowerCase()) {
            return resourceName;
        }
        return `${resourceName}${urlExtension}`;
    }
    return resourceName || getUrlFileName(resource.mods_resource_url);
}
