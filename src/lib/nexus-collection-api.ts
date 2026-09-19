// NexusMods Collection 查询：revision 列表 + revision 内文件清单。
// 请求与归一化在后端（collection_pending.rs）完成，前端只做 invoke 透传。
import { invoke } from "@tauri-apps/api/core";

export interface INexusCollectionRevision {
    revisionNumber: number;
    revisionStatus: string;
}

export interface INexusCollectionInfo {
    name: string;
    latestRevisionNumber: number | null;
    modCount: number;
    revisions: INexusCollectionRevision[];
}

export interface INexusCollectionFile {
    modId: string;
    fileId: string;
    name: string;
    version: string;
    optional: boolean;
}

interface IBackendInfo {
    name: string;
    latestRevisionNumber: number | null;
    modCount: number;
    revisions: INexusCollectionRevision[];
}

interface IBackendFile {
    modId: string;
    fileId: string;
    name: string;
    version: string;
    optional: boolean;
}

// 查 collection 基本信息 + 全量 revision 列表（默认最新排前）。
export async function fetchNexusCollectionInfo(
    gameDomain: string,
    slug: string,
    nexusUser?: INexusModsUser | null,
): Promise<INexusCollectionInfo> {
    const info = await invoke<IBackendInfo>("nexus_collection_info", {
        gameDomain,
        slug,
        apiKey: nexusUser?.key?.trim() ?? "",
    });
    return {
        name: info.name,
        latestRevisionNumber: info.latestRevisionNumber,
        modCount: info.modCount,
        revisions: info.revisions,
    };
}

// 查指定 revision 的文件清单，每项自带 modId/fileId，可直接复用单文件下载链路。
export async function fetchNexusCollectionFiles(
    gameDomain: string,
    slug: string,
    revision: number,
    nexusUser?: INexusModsUser | null,
): Promise<INexusCollectionFile[]> {
    const files = await invoke<IBackendFile[]>("nexus_collection_files", {
        gameDomain,
        slug,
        revision,
        apiKey: nexusUser?.key?.trim() ?? "",
    });
    return files.map((item) => ({
        modId: item.modId,
        fileId: item.fileId,
        name: item.name,
        version: item.version,
        optional: item.optional,
    }));
}
