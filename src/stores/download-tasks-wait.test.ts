// waitForTaskCondition 单测：初始即真、taskList 变化触发、取消路径。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { createPinia, defineStore, setActivePinia } from "pinia";

vi.mock("@/lib/FileHandler", () => ({ FileHandler: {} }));
vi.mock("@/lib/download-meta", () => ({
    listDownloadMeta: async () => ({}),
    putDownloadMeta: async () => {},
    removeDownloadMeta: async () => {},
}));
vi.mock("element-plus-message", () => ({ ElMessage: { success: () => {}, error: () => {} } }));
vi.mock("@/features/download/facade", () => ({
    getDownloadFacade: () => ({
        snapshot: () => [],
        subscribe: () => () => {},
    }),
}));

// store 依赖 unplugin-auto-import 的全局 defineStore，vitest 下手动补齐。
vi.stubGlobal("defineStore", defineStore);

// store 顶层在 import 时求值 getDownloadFacade，静态 import 会先于 vi.mock 生效；动态 import 让桩先生效。
const { useDownloadTasksStore } = await import("./download-tasks");

beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
});

describe("waitForTaskCondition", () => {
    it("条件初始即真直接 resolve", async () => {
        const store = useDownloadTasksStore();
        await store.waitForTaskCondition(() => true, 5000);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("taskList 变化触发 resolve", async () => {
        const store = useDownloadTasksStore();
        let flag = false;
        const pending = store.waitForTaskCondition(() => flag, 5000);
        // pullSnapshot 会覆盖 taskList（桩返回 []），触发 watch 求值。
        flag = true;
        store.pullSnapshot();
        await nextTick();
        await pending;
        expect(vi.getTimerCount()).toBe(0);
    });

    it("取消路径 resolve", async () => {
        const store = useDownloadTasksStore();
        store.startRetryProgress("e1", 2);
        const pending = store.waitForTaskCondition(
            () => store.getRetryProgress("e1")?.cancelled === true,
            5000,
        );
        store.cancelRetryProgress("e1");
        await nextTick();
        await pending;
    });
});
