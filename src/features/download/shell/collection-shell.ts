// Collection 壳：仅分组 + 共享闸透传，无独立状态机/队列。
// 组内暂停/恢复走 facade（resumeCollection / 后端 pause_collection）。
import { invoke } from "@tauri-apps/api/core";
import type { CollectionShell, DownloadTask } from "../types";

export function groupByCollection(tasks: readonly DownloadTask[]): Map<string, DownloadTask[]> {
    const groups = new Map<string, DownloadTask[]>();
    for (const task of tasks) {
        // 无 collectionId 的任务不归属任何壳，不进分组。
        if (task.collectionId === undefined) {
            continue;
        }
        const list = groups.get(task.collectionId);
        if (list) {
            list.push(task);
        } else {
            groups.set(task.collectionId, [task]);
        }
    }
    return groups;
}

export function tasksOfCollection(tasks: readonly DownloadTask[], collectionId: string): DownloadTask[] {
    return tasks.filter((task) => task.collectionId === collectionId);
}

// 壳闸命中 → 组内 task 停播（前端过滤，不另持状态）。
export function visibleTasks(tasks: readonly DownloadTask[], pausedCollections: ReadonlySet<string>): DownloadTask[] {
    return tasks.filter(
        (task) => task.collectionId === undefined || !pausedCollections.has(task.collectionId),
    );
}

export function toShell(collectionId: string, pausedCollections: ReadonlySet<string>): CollectionShell {
    return { collectionId, paused: pausedCollections.has(collectionId) };
}

// 组暂停/恢复：透传后端命令，闸状态以后端为准，前端 gates 由 facade 同步。
export async function pauseCollection(collectionId: string): Promise<void> {
    await invoke("dl_pause_collection", { collectionId });
}

export async function resumeCollectionViaFacade(
    resumeCollection: (collectionId: string) => Promise<void>,
    collectionId: string,
): Promise<void> {
    await resumeCollection(collectionId);
}
