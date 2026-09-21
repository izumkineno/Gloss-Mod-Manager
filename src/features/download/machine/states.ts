// 状态集 + 变迁表 + transition() 唯一入口（前端投影机）。
// 投影机定位：事件驱动，不在前端算退避/计时；retrying 为只读投影。
import type { ArchivedTask, DownloadStatus, DownloadTask, TaskProjection, TerminalKind } from "../types";

// 合法变迁表（from → to），对齐计划 §2。
const TRANSITIONS: Record<DownloadStatus, Partial<Record<DownloadStatus, true>>> = {
    waiting: { active: true, paused: true },
    active: { paused: true, error: true, waiting: true },
    paused: { waiting: true },
    error: { retrying: true, paused: true },
    retrying: { waiting: true, error: true, paused: true },
};

export const DOWNLOAD_STATUSES: readonly DownloadStatus[] = [
    "waiting",
    "active",
    "paused",
    "error",
    "retrying",
];

// 测试缝 + transition 共用：非法变迁的唯一判定点。
export function canTransition(from: DownloadStatus, to: DownloadStatus): boolean {
    return (TRANSITIONS[from] as Record<string, true>)[to] === true;
}

export interface MachineStore {
    tasks: Map<string, DownloadTask>;
    /** 终局归档：complete 任务保留最后一帧投影（展示/重新下载用），purge 清空。 */
    archive: Map<string, ArchivedTask>;
    terminalLog: Array<{ gid: string; kind: TerminalKind }>;
}

export function createMachine(): MachineStore {
    return { tasks: new Map(), archive: new Map(), terminalLog: [] };
}

// 入机：∅ → waiting（同 gid 已在机内则断言失败）。
export function enterMachine(store: MachineStore, task: DownloadTask): void {
    if (store.tasks.has(task.gid)) {
        throw new Error(`任务已在机内: ${task.gid}`);
    }
    store.tasks.set(task.gid, { ...task, status: "waiting" });
}

// 引导同步：应用重启/页面重载后前端机为空，从后端真相源（dl_list）重建投影。
// 属 ∅→state 的初始化登记（restore），不走 runtime 变迁表；变迁表只约束运行时行为。
// complete 投影转入终局归档；removed 忽略（后端不留 removed 记录，防御性分支）。
export function restoreTask(store: MachineStore, task: TaskProjection): void {
    if (task.status === "removed") {
        return;
    }
    if (task.status === "complete") {
        // status 已窄化为 TerminalKind，可安全入归档。
        store.archive.set(task.gid, { ...task, status: "complete" });
        return;
    }
    // 此处 status 必为机内 5 态（removed/complete 已拦截）；TS 对 Omit 联合的窄化不完整，显式收窄。
    store.tasks.set(task.gid, { ...task, status: task.status as DownloadStatus });
}

// transition 唯一入口：机内已无 gid 的变迁、非法迁移动断言。
export function transition(store: MachineStore, gid: string, to: DownloadStatus): DownloadTask {
    const current = store.tasks.get(gid);
    if (!current) {
        throw new Error(`机内无此任务: ${gid}`);
    }
    if (!canTransition(current.status, to)) {
        throw new Error(`非法变迁: ${current.status} → ${to} (${gid})`);
    }
    const next = { ...current, status: to };
    store.tasks.set(gid, next);
    return next;
}

// 终局副作用：出机 + 发射终局事件（complete/removed 不是状态）。
// complete：转入终局归档（保留最后一帧投影，供“已结束”列表展示与重新下载，purge 时清空）。
// removed：记录删除，不入归档（forget/cancel 后行不残留）。
// 机内无此 gid 时：若它在终局归档中（用户删除已完成/已结束记录），同步清掉归档行；两处皆无才断言。
// “重新下载”= 新 gid 入机，本函数不复活旧条目。
export function settleTerminal(store: MachineStore, gid: string, kind: TerminalKind): void {
    const entry = store.tasks.get(gid);
    if (!entry) {
        // 归档中的记录（已完成行）被删除：清归档即出“列表”，不算异常。
        if (store.archive.has(gid)) {
            store.tasks.delete(gid);
            if (kind === "removed") {
                store.archive.delete(gid);
            }
            store.terminalLog.push({ gid, kind });
            return;
        }
        // removed 幂等：后端 dl_cancel/dl_purge_stopped 会 emit "removed" 事件，
        // facade.cancel/purge 本地又 settleTerminal 一次，事件先到时本地二次终局属正常竞态，
        // 直接吞掉并记审计日志，不再抛"机内无此任务"中断删除链路（meta 清理/列表刷新）。
        if (kind === "removed") {
            store.terminalLog.push({ gid, kind });
            return;
        }
        throw new Error(`机内无此任务，无法终局: ${gid}`);
    }
    store.tasks.delete(gid);
    if (kind === "complete") {
        store.archive.set(gid, { ...entry, status: kind });
    } else {
        store.archive.delete(gid);
    }
    store.terminalLog.push({ gid, kind });
}
