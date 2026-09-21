// 后端事件订阅 → 喂给 machine。
// 事件名以现状为准：dl-task-changed / dl-progress（camelCase payload）。
// dl-task-changed payload 新增 retry_count / next_retry_at_ms（后端真相源，只读投影）。
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { settleTerminal, transition } from "./machine/states";
import type { MachineStore } from "./machine/states";
import type { DownloadStatus, TerminalKind } from "./types";

export interface DlTaskChangedPayload {
    gid: string;
    // 后端 status 为小写字符串；complete/removed 走终局副作用，不入状态集。
    status: string;
    retryCount?: number;
    nextRetryAtMs?: number;
    // 注册表当前大小（后端终局对齐后的真相源）：快速完成/秒败时前端可能
    // 没收到任何 dl-progress 帧，靠它兜底补齐，避免归档行显示 0/0。
    totalLength?: number;
    completedLength?: number;
}

export interface DlProgressPayload {
    gid: string;
    downloaded: number;
    total: number;
    speed: number;
}

const TERMINAL: Record<string, TerminalKind> = {
    complete: "complete",
    removed: "removed",
};

// 后端事件喂给投影机：终局走 settleTerminal，机内变迁走 transition。
export function applyTaskChanged(store: MachineStore, payload: DlTaskChangedPayload): void {
    const terminal = TERMINAL[payload.status];
    if (terminal !== undefined) {
        // 机内已无 gid（重复终局/forget 后迟到的终局事件）直接忽略，不抛错。
        if (store.tasks.has(payload.gid)) {
            settleTerminal(store, payload.gid, terminal);
            // 终局补帧：小文件可能在任何进度帧到达前就完成，归档行缺大小会显示 0/0；
            // 事件携带的后端终值兜底写入（removed 无归档行，取不到即跳过）。
            const archived = store.archive.get(payload.gid);
            if (archived && payload.totalLength !== undefined) {
                store.archive.set(payload.gid, {
                    ...archived,
                    total: payload.totalLength,
                    downloaded: payload.completedLength ?? archived.downloaded,
                });
            }
        }
        return;
    }
    const next = transition(store, payload.gid, payload.status as DownloadStatus);
    if (payload.retryCount !== undefined) {
        next.retryCount = payload.retryCount;
    }
    if (payload.nextRetryAtMs !== undefined) {
        next.nextRetryAtMs = payload.nextRetryAtMs;
    }
    // 机内变迁同样兜底：秒败任务从未收到进度帧，错误行也能显示真实大小。
    // 注册表值单调不减，事件补写不会造成进度倒流。
    if (payload.totalLength !== undefined) {
        next.total = payload.totalLength;
        next.downloaded = payload.completedLength ?? next.downloaded;
    }
    store.tasks.set(payload.gid, next);
}

export function applyProgress(store: MachineStore, payload: DlProgressPayload): void {
    const current = store.tasks.get(payload.gid);
    if (!current) {
        return;
    }
    store.tasks.set(payload.gid, {
        ...current,
        downloaded: payload.downloaded,
        total: payload.total,
        speed: payload.speed,
    });
}

// 订阅后端事件，返回取消函数。对外经 facade.subscribe 暴露，本期不建 viewstore。
export async function subscribeBackendEvents(
    store: MachineStore,
    onSnapshot?: () => void,
): Promise<() => void> {
    const unlistenChanged = await listen<DlTaskChangedPayload>("dl-task-changed", (event) => {
        try {
            applyTaskChanged(store, event.payload);
        } finally {
            onSnapshot?.();
        }
    });
    const unlistenProgress = await listen<DlProgressPayload>("dl-progress", (event) => {
        try {
            applyProgress(store, event.payload);
        } finally {
            onSnapshot?.();
        }
    });
    const stops: UnlistenFn[] = [unlistenChanged, unlistenProgress];
    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;
        for (const stop of stops) {
            stop();
        }
    };
}
