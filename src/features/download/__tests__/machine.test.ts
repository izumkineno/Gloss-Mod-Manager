// 前端投影机单测：变迁合法性、非法变迁拒绝、同一 gid 语义、meta purge 时序。
import { describe, expect, it } from "vitest";
import { createGates } from "../machine/guards";
import { canTransition, createMachine, enterMachine, settleTerminal, transition } from "../machine/states";
import { createMetaStore, purgeMeta, putMeta } from "../meta/meta-store";
import { applyTaskChanged } from "../events";
import { pump } from "../queue/pump";
import type { DownloadTask } from "../types";

function makeTask(gid: string): DownloadTask {
    return { gid, status: "waiting", retryCount: 0, nextRetryAtMs: 0 };
}

describe("transition 合法性", () => {
    it("waiting → active → error → retrying → waiting 同一 gid", () => {
        const store = createMachine();
        enterMachine(store, makeTask("g1"));
        transition(store, "g1", "active");
        transition(store, "g1", "error");
        transition(store, "g1", "retrying");
        const next = transition(store, "g1", "waiting");
        expect(next.gid).toBe("g1");
        expect(next.status).toBe("waiting");
        expect(store.tasks.get("g1")?.gid).toBe("g1");
    });

    it("paused 往返 waiting", () => {
        const store = createMachine();
        enterMachine(store, makeTask("g2"));
        transition(store, "g2", "paused");
        transition(store, "g2", "waiting");
        expect(store.tasks.get("g2")?.status).toBe("waiting");
    });
});

describe("非法变迁拒绝", () => {
    it("waiting → error 直接断言", () => {
        const store = createMachine();
        enterMachine(store, makeTask("g3"));
        expect(canTransition("waiting", "error")).toBe(false);
        expect(() => transition(store, "g3", "error")).toThrowError(/非法变迁/);
    });

    it("机内无 gid 的变迁断言", () => {
        const store = createMachine();
        expect(() => transition(store, "missing", "active")).toThrowError(/机内无此任务/);
    });

    it("complete 事件后机内无 gid，后续变迁断言", () => {
        const store = createMachine();
        enterMachine(store, makeTask("g4"));
        applyTaskChanged(store, { gid: "g4", status: "complete" });
        expect(store.tasks.has("g4")).toBe(false);
        expect(() => transition(store, "g4", "waiting")).toThrowError(/机内无此任务/);
    });
});

describe("同一 gid 语义", () => {
    it("complete 后重新下载 = 新任务入机（旧 gid 不复活）", () => {
        const store = createMachine();
        enterMachine(store, makeTask("g5"));
        settleTerminal(store, "g5", "complete");
        expect(store.terminalLog).toEqual([{ gid: "g5", kind: "complete" }]);
        // 重新下载产生新 gid 入机，旧条目不复活。
        enterMachine(store, makeTask("g6"));
        expect(store.tasks.has("g5")).toBe(false);
        expect(store.tasks.has("g6")).toBe(true);
    });

    it("complete 转终局归档保留最后一帧，removed 不入归档", () => {
        const store = createMachine();
        enterMachine(store, { ...makeTask("g9"), dir: "D:/dl" });
        transition(store, "g9", "active");
        settleTerminal(store, "g9", "complete");
        expect(store.tasks.has("g9")).toBe(false);
        const archived = store.archive.get("g9");
        expect(archived?.status).toBe("complete");
        expect(archived?.dir).toBe("D:/dl");
        // removed：记录删除，不入归档。
        enterMachine(store, makeTask("g10"));
        settleTerminal(store, "g10", "removed");
        expect(store.tasks.has("g10")).toBe(false);
        expect(store.archive.has("g10")).toBe(false);
    });

    it("retrying 事件携带后端 retry_count 投影", () => {
        const store = createMachine();
        enterMachine(store, makeTask("g7"));
        transition(store, "g7", "active");
        transition(store, "g7", "error");
        applyTaskChanged(store, { gid: "g7", status: "retrying", retryCount: 2, nextRetryAtMs: 123 });
        const task = store.tasks.get("g7");
        expect(task?.status).toBe("retrying");
        expect(task?.retryCount).toBe(2);
        expect(task?.nextRetryAtMs).toBe(123);
    });

    // 回归：小文件可能在任何进度帧（后端 0.5s 节流）到达前就完成，
    // 机内条目从未收到 dl-progress → 归档行缺 total/downloaded 显示 0/0。
    // 事件携带的后端终值必须兜底写入归档行。
    it("complete 事件零进度帧时用事件终值补齐归档行大小", () => {
        const store = createMachine();
        enterMachine(store, makeTask("g11"));
        // 无任何 applyProgress，直接收到 complete 终局事件（带后端终值）。
        applyTaskChanged(store, { gid: "g11", status: "complete", totalLength: 1048576, completedLength: 1048576 });
        const archived = store.archive.get("g11");
        expect(archived?.total).toBe(1048576);
        expect(archived?.downloaded).toBe(1048576);
    });

    // 同类兜底：秒败任务从未收到进度帧，错误行也要显示真实大小。
    it("error 事件零进度帧时用事件终值补齐机内行大小", () => {
        const store = createMachine();
        enterMachine(store, makeTask("g12"));
        transition(store, "g12", "active");
        applyTaskChanged(store, { gid: "g12", status: "error", totalLength: 4096, completedLength: 1024 });
        const task = store.tasks.get("g12");
        expect(task?.status).toBe("error");
        expect(task?.total).toBe(4096);
        expect(task?.downloaded).toBe(1024);
    });
});

describe("meta purge 时序", () => {
    it("终局后 meta 同步清理", () => {
        const store = createMachine();
        const metas = createMetaStore();
        enterMachine(store, makeTask("g8"));
        putMeta(metas, { gid: "g8", fileName: "a.zip", downloadUrl: "https://x/a.zip", source: "test" });
        settleTerminal(store, "g8", "removed");
        purgeMeta(metas, "g8");
        expect(store.tasks.has("g8")).toBe(false);
        expect(metas.metas.has("g8")).toBe(false);
    });

    it("pump 跳过 paused，waiting 正常启动", () => {
        const store = createMachine();
        const gates = createGates();
        enterMachine(store, makeTask("w1"));
        enterMachine(store, { ...makeTask("p1"), collectionId: "c1" });
        transition(store, "p1", "paused");
        const started = pump(store, gates);
        expect(started).toContain("w1");
        expect(started).not.toContain("p1");
        expect(store.tasks.get("w1")?.status).toBe("active");
    });
});
