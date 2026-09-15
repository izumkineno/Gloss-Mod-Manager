import { listen } from "@tauri-apps/api/event";

// 下载任务事件的共享订阅器：多个组件同时订阅同一事件时复用同一底层 listener，
// 引用计数归零才真正取消，避免重复订阅导致的重复刷新。
// 事件只做触发器：回调里拉一次快照，不以事件 payload 为数据源。
export const DOWNLOAD_TASK_EVENTS = [
    "dl-progress",
    "dl-task-changed",
] as const;

export type DownloadTaskEventName = (typeof DOWNLOAD_TASK_EVENTS)[number];

const refCounts = new Map<DownloadTaskEventName, number>();
const unlistens = new Map<DownloadTaskEventName, () => void>();
const pending = new Map<DownloadTaskEventName, Promise<void>>();
const handlers = new Map<DownloadTaskEventName, Set<() => void>>();

function getHandlers(event: DownloadTaskEventName) {
    let set = handlers.get(event);

    if (!set) {
        set = new Set();
        handlers.set(event, set);
    }

    return set;
}

async function ensureSubscribed(event: DownloadTaskEventName) {
    if (unlistens.has(event)) {
        return;
    }

    let inflight = pending.get(event);

    if (!inflight) {
        inflight = (async () => {
            const unlisten = await listen(event, () => {
                for (const handler of getHandlers(event)) {
                    try {
                        handler();
                    } catch (error: unknown) {
                        console.error(`下载事件回调失败: ${event}`);
                        console.error(error);
                    }
                }
            });
            unlistens.set(event, unlisten);
        })();
        pending.set(event, inflight);
    }

    try {
        await inflight;
    } finally {
        pending.delete(event);
    }
}

// 订阅下载任务事件，返回取消函数。同一回调重复订阅只记一次。
export async function subscribeDownloadTaskEvents(
    handler: () => void,
    events: readonly DownloadTaskEventName[] = DOWNLOAD_TASK_EVENTS,
): Promise<() => void> {
    const subscribed: DownloadTaskEventName[] = [];

    for (const event of events) {
        getHandlers(event).add(handler);
        subscribed.push(event);
        refCounts.set(event, (refCounts.get(event) ?? 0) + 1);
    }

    // 先注册回调再建底层监听：事件触发只读 handlers，正处理中的 emit 也能被后续快照覆盖，不丢终态。
    await Promise.all(subscribed.map((event) => ensureSubscribed(event)));

    let released = false;

    return () => {
        if (released) {
            return;
        }
        released = true;

        for (const event of subscribed) {
            getHandlers(event).delete(handler);
            const next = (refCounts.get(event) ?? 1) - 1;

            if (next <= 0) {
                refCounts.delete(event);
                unlistens.get(event)?.();
                unlistens.delete(event);
            } else {
                refCounts.set(event, next);
            }
        }
    };
}
