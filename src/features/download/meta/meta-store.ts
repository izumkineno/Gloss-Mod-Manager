// TaskMeta 存储：生命周期随 task 进出机；complete/removed 后出机 + meta 清理。
import type { TaskMeta } from "../types";

export interface MetaStore {
    metas: Map<string, TaskMeta>;
}

export function createMetaStore(): MetaStore {
    return { metas: new Map() };
}

// 入机时登记 meta；出机（终局副作用）时同步清理，不留残留。
export function putMeta(store: MetaStore, meta: TaskMeta): void {
    store.metas.set(meta.gid, meta);
}

export function purgeMeta(store: MetaStore, gid: string): void {
    store.metas.delete(gid);
}
