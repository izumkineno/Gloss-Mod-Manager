// NexusMods Collection 待下载清单：后端读取和存储（collection_pending.json）。
// 前端只做 invoke 透传 + 蛇形/驼峰适配，不再经 PersistentStore 落盘。
import { invoke } from "@tauri-apps/api/core";
import type { INexusCollectionFile } from "@/lib/nexus-collection-api";

export type NexusCollectionPendingItemStatus =
    | "pending"
    | "queued"
    | "failed";

export interface INexusCollectionPendingItem extends INexusCollectionFile {
    status: NexusCollectionPendingItemStatus;
    reason?: string;
}

export interface INexusCollectionPending {
    id: string;
    gameDomain: string;
    slug: string;
    revision: number;
    name: string;
    game: ISupportedGames;
    gameName?: string;
    createdAt: number;
    updatedAt: number;
    items: INexusCollectionPendingItem[];
}

interface IBackendPendingItem {
    modId: string;
    fileId: string;
    name: string;
    version: string;
    optional: boolean;
    status: string;
    reason?: string | null;
}

interface IBackendPending {
    id: string;
    gameDomain: string;
    slug: string;
    revision: number;
    name: string;
    game: string;
    gameName: string;
    createdAt: number;
    updatedAt: number;
    items: IBackendPendingItem[];
}

function buildId(gameDomain: string, slug: string, revision: number): string {
    return `${gameDomain}/${slug}/r${revision}`;
}

function toFrontend(entry: IBackendPending): INexusCollectionPending {
    return {
        id: entry.id,
        gameDomain: entry.gameDomain,
        slug: entry.slug,
        revision: entry.revision,
        name: entry.name,
        game: entry.game as unknown as ISupportedGames,
        gameName: entry.gameName || undefined,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        items: entry.items.map((item) => ({
            modId: item.modId,
            fileId: item.fileId,
            name: item.name,
            version: item.version,
            optional: item.optional,
            status: item.status as NexusCollectionPendingItemStatus,
            reason: item.reason ?? undefined,
        })),
    };
}

// 保存/更新整个 collection 待下载清单（幂等，key 相同则覆盖 items）。
export async function saveCollectionPending(
    entry: Omit<INexusCollectionPending, "id" | "createdAt" | "updatedAt"> & {
        id?: string;
    },
): Promise<INexusCollectionPending> {
    const existing = await listCollectionPending();
    const id = entry.id ?? buildId(entry.gameDomain, entry.slug, entry.revision);
    const now = Date.now();
    const saved = await invoke<IBackendPending>("collection_pending_save", {
        entry: {
            id,
            gameDomain: entry.gameDomain,
            slug: entry.slug,
            revision: entry.revision,
            name: entry.name,
            game: String(entry.game),
            gameName: entry.gameName ?? "",
            createdAt: existing.find((item) => item.id === id)?.createdAt ?? now,
            updatedAt: now,
            items: entry.items.map((item) => ({
                modId: item.modId,
                fileId: item.fileId,
                name: item.name,
                version: item.version,
                optional: item.optional,
                status: item.status,
                reason: item.reason ?? null,
            })),
        },
    });
    return toFrontend(saved);
}

// 更新单个文件的状态（建任务成功/失败时调用）。
export async function updateCollectionPendingItem(
    id: string,
    modId: string,
    fileId: string,
    status: NexusCollectionPendingItemStatus,
    reason?: string,
): Promise<void> {
    await invoke("collection_pending_update_item", {
        id,
        modId,
        fileId,
        status,
        reason: reason ?? null,
        updatedAt: Date.now(),
    });
}

export async function listCollectionPending(): Promise<
    INexusCollectionPending[]
> {
    const entries = await invoke<IBackendPending[]>(
        "collection_pending_list",
    );
    return entries.map(toFrontend);
}

export async function removeCollectionPending(id: string): Promise<void> {
    await invoke("collection_pending_remove", { id });
}

export async function clearFinishedCollectionPending(): Promise<void> {
    await invoke("collection_pending_clear_finished");
}
