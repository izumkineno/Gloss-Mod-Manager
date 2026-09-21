// 导入来源判定（Wave 3 自包含）：原 gloss-download-queue.ts 纯函数迁移，队列删除后 monitor 不再跨文件引用。
// 压缩包后缀 → archive，其余走本地探测；GlossMod 走 resourceFormat 回退判定。
import {
    ARCHIVE_EXTENSIONS,
    resolveLocalModImportSourceType,
    type LocalModImportSourceType,
} from "@/lib/local-mod-import";
import { fetchGlossModDetail } from "@/lib/gloss-mod-api";
import type { IGlossDownloadTaskMeta } from "@/lib/gloss-download";

const ARCHIVE_EXTENSION_PATTERN =
    /\.(tar\.(?:gz|xz|bz2)|zip|7z|rar|tar|gz|xz|bz2)$/iu;

function getFileNameExtension(fileName: string): string {
    return (
        ARCHIVE_EXTENSION_PATTERN.exec(fileName)?.[0] ??
        /\.[A-Za-z0-9]{1,16}$/u.exec(fileName)?.[0] ??
        ""
    );
}

function hasArchiveSuffix(value?: string): boolean {
    if (!value) {
        return false;
    }

    return ARCHIVE_EXTENSION_PATTERN.test(getFileNameExtension(value).toLowerCase());
}

async function resolveTaskResourceFormat(metadata?: IGlossDownloadTaskMeta): Promise<string> {
    if (metadata?.resourceFormat?.trim()) {
        return metadata.resourceFormat.trim().toLowerCase();
    }

    if (!metadata?.modId || !metadata?.resourceId) {
        return "";
    }

    try {
        const mod = await fetchGlossModDetail(metadata.modId);
        const resource = mod.mods_resource.find(
            (item) => String(item.id) === String(metadata.resourceId),
        );

        return (resource?.mods_resource_formart ?? "").trim().toLowerCase();
    } catch {
        return "";
    }
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
        (ARCHIVE_EXTENSIONS as readonly string[]).includes(
            resourceFormat.replace(/^.*\./u, ""),
        )
    ) {
        return "archive";
    }

    return directSourceType;
}
