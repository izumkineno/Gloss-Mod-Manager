// 下载页后端存储桥：投影快照/引擎设置/代理/目录经 dl_store_* 透传。
// 存储真相源在后端 download_store.json；前端仅显示和控制。
import { invoke } from "@tauri-apps/api/core";
import { ref, toRaw, watch } from "vue";
import type { Ref } from "vue";

/** 单键读取（缺键返回 fallback）。 */
export async function getDownloadStore<T>(key: string, fallback: T): Promise<T> {
    const value = await invoke<T | null>("dl_store_get", { key });
    return (value ?? fallback) as T;
}

/** 单键写入（控制变更后落盘）。 */
export async function setDownloadStore(key: string, value: unknown): Promise<void> {
    await invoke("dl_store_set", { key, value });
}

// 后端键粒度的响应式引用：语义对齐 PersistentStore.useValue（读缺键回退默认值，写透传后端）。
const storeValueRefs = new Map<string, Ref<unknown>>();
function cloneValue<T>(value: T): T {
    if (value === null || typeof value !== "object") return value;
    try {
        return structuredClone(toRaw(value) as T);
    } catch {
        return value;
    }
}
/** 与后端存储同步的响应式引用（前端仅显示和控制）。 */
export function useDownloadStoreValue<T>(key: string, fallback: T): Ref<T> {
    const cached = storeValueRefs.get(key);
    if (cached) return cached as Ref<T>;
    const state = ref<T>(cloneValue(fallback)) as Ref<T>;
    storeValueRefs.set(key, state as Ref<unknown>);
    void getDownloadStore<T>(key, fallback).then((stored) => {
        state.value = cloneValue(stored);
    }).catch(() => undefined);
    watch(state, (next) => {
        void setDownloadStore(key, cloneValue(toRaw(next) as T)).catch(() => undefined);
    }, { deep: true });
    return state;
}
