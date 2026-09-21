// pending 占位 + active 计数 + pump 触发（前端投影缓存，不另持队列）。
// paused 机内冻结占位 pending，不在机外另立队列。MAX_ACTIVE=5 沿用现状。
import { transition, type MachineStore } from "../machine/states";
import { isGated, type GateState } from "../machine/guards";

export const MAX_ACTIVE = 5;

export function countActive(store: MachineStore): number {
    let n = 0;
    for (const task of store.tasks.values()) {
        if (task.status === "active") {
            n += 1;
        }
    }
    return n;
}

// pump：waiting 中无闸且有槽位 → active；paused/error/retrying 不动（计时归后端）。
export function pump(store: MachineStore, gates: GateState): string[] {
    const started: string[] = [];
    let active = countActive(store);
    for (const task of store.tasks.values()) {
        if (active >= MAX_ACTIVE) {
            break;
        }
        if (task.status !== "waiting" || isGated(gates, task.collectionId)) {
            continue;
        }
        transition(store, task.gid, "active");
        started.push(task.gid);
        active += 1;
    }
    return started;
}
