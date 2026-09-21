// Wave 2 单测：shell 分组/停播 + selectors 分组/倒计时 + dialogs 菜单语义。
import { describe, expect, it, vi } from "vitest";
import { groupByCollection, toShell, visibleTasks } from "../shell/collection-shell";
import { groupOf, retryCountdownText, selectAttention, sortForDisplay } from "../view/selectors";
import { clearAttention, menuForTask } from "../view/dialogs";
import type { DownloadTask } from "../types";

function makeTask(gid: string, status: DownloadTask["status"], collectionId?: string): DownloadTask {
    return { gid, status, retryCount: 0, nextRetryAtMs: 0, collectionId };
}

describe("shell", () => {
    it("按 collectionId 分组，无归属任务不进组", () => {
        const tasks = [makeTask("a", "waiting", "c1"), makeTask("b", "active"), makeTask("c", "waiting", "c1")];
        const groups = groupByCollection(tasks);
        expect(groups.get("c1")?.map((t) => t.gid).sort()).toEqual(["a", "c"]);
        expect(groups.has("b")).toBe(false);
    });

    it("闸命中组停播", () => {
        const tasks = [makeTask("a", "waiting", "c1"), makeTask("b", "waiting")];
        expect(visibleTasks(tasks, new Set(["c1"])).map((t) => t.gid)).toEqual(["b"]);
    });

    it("toShell 透传闸状态", () => {
        expect(toShell("c1", new Set(["c1"]))).toEqual({ collectionId: "c1", paused: true });
        expect(toShell("c1", new Set()).paused).toBe(false);
    });
});

describe("selectors", () => {
    it("retrying 与 error 同属 attention", () => {
        expect(groupOf(makeTask("a", "retrying"))).toBe("attention");
        expect(groupOf(makeTask("b", "error"))).toBe("attention");
        expect(selectAttention([makeTask("a", "retrying"), makeTask("b", "active")]).map((t) => t.gid)).toEqual(["a"]);
    });

    it("倒计时文本含秒数与剩余次数", () => {
        const now = 1000000;
        const text = retryCountdownText({ ...makeTask("a", "retrying"), retryCount: 1, nextRetryAtMs: now + 2500 }, now);
        expect(text).toBe("3秒后重试/剩余2次");
    });

    it("attention 置顶排序", () => {
        const sorted = sortForDisplay([makeTask("p", "paused"), makeTask("e", "error"), makeTask("a", "active")]);
        expect(sorted.map((t) => t.gid)).toEqual(["e", "a", "p"]);
    });
});

describe("dialogs", () => {
    it("error 给重试菜单，retrying 给取消菜单", () => {
        expect(menuForTask(makeTask("a", "error")).map((m) => m.key)).toEqual(["retry", "forget"]);
        expect(menuForTask(makeTask("b", "retrying")).map((m) => m.key)).toEqual(["cancel"]);
    });

    it("clearAttention 逐个 forget", async () => {
        const forget = vi.fn(async (_gid: string) => {});
        await clearAttention({ forget } as never, [makeTask("a", "error"), makeTask("b", "active")]);
        expect(forget).toHaveBeenCalledTimes(1);
        expect(forget).toHaveBeenCalledWith("a");
    });
});
