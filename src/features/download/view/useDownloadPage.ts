// 下载页任务视图逻辑（Wave 3 机械抽取）：筛选/排序/分页/批量操作。
// 实现与 download.vue 原样一致，只挪位置；页面保留布局 + 事件转发。
// 数据一律走 facade 单例快照，禁止直调 invoke 与旧 store。
import { computed, ref } from "vue";
import { ElMessage } from "element-plus-message";
import { getDownloadFacade } from "../facade";
import type { TaskProjection } from "../types";

export type QueueFilter = "all" | "active" | "waiting" | "paused" | "attention";

export interface PageItem {
    key: string;
    label: string;
    page?: number;
    ellipsis?: boolean;
}

const DEFAULT_PAGE_SIZE = 20;

export function useDownloadPageView() {
    const facade = getDownloadFacade();
    const tasks = ref<TaskProjection[]>([]);
    const queueFilter = ref<QueueFilter>("all");
    const taskPage = ref(1);
    const taskPageSize = ref(String(DEFAULT_PAGE_SIZE));
    const operatingIds = ref<string[]>([]);

    function pull(): void {
        tasks.value = facade.snapshot();
    }

    function subscribe(): () => void {
        pull();
        return facade.subscribe((next: TaskProjection[]) => {
            tasks.value = next;
        });
    }
    const filteredTasks = computed(() => {
        switch (queueFilter.value) {
            case "active":
                return tasks.value.filter((t) => t.status === "active");
            case "waiting":
                return tasks.value.filter((t) => t.status === "waiting");
            case "paused":
                return tasks.value.filter((t) => t.status === "paused");
            case "attention":
                return tasks.value.filter((t) => t.status === "error" || t.status === "retrying");
            default:
                return tasks.value;
        }
    });

    const taskPageSizeNumber = computed(() => Number(taskPageSize.value) || DEFAULT_PAGE_SIZE);
    const taskTotalPages = computed(() => Math.max(1, Math.ceil(filteredTasks.value.length / taskPageSizeNumber.value)));
    const paginatedTasks = computed(() => {
        const size = taskPageSizeNumber.value;
        const start = (taskPage.value - 1) * size;
        return filteredTasks.value.slice(start, start + size);
    });
    const visibleTaskRangeLabel = computed(() => {
        if (filteredTasks.value.length === 0) {
            return "共 0 条";
        }
        const start = (taskPage.value - 1) * taskPageSizeNumber.value + 1;
        const end = Math.min(filteredTasks.value.length, start + taskPageSizeNumber.value - 1);
        return `第 ${start}-${end} 条，共 ${filteredTasks.value.length} 条`;
    });

    const taskPaginationItems = computed<PageItem[]>(() => {
        const total = taskTotalPages.value;
        const current = taskPage.value;
        const items: PageItem[] = [];
        for (let page = 1; page <= total; page += 1) {
            if (total > 7 && page !== 1 && page !== total && Math.abs(page - current) > 2) {
                const last = items[items.length - 1];
                if (!last || last.key !== `ellipsis-${page}`) {
                    items.push({ key: `ellipsis-${page}`, label: "…", ellipsis: true });
                }
                continue;
            }
            items.push({ key: `page-${page}`, label: String(page), page });
        }
        return items;
    });

    function goToTaskPage(nextPage: number): void {
        taskPage.value = Math.min(Math.max(1, nextPage), taskTotalPages.value);
    }

    function isOperating(gid: string): boolean {
        return operatingIds.value.includes(gid);
    }

    async function runOp(gid: string, op: (gid: string) => Promise<unknown>, refresh: () => Promise<unknown>): Promise<void> {
        operatingIds.value = [...operatingIds.value, gid];
        try {
            await op(gid);
            await refresh();
        } catch (error: unknown) {
            ElMessage.error(error instanceof Error ? error.message : "操作失败，请稍后重试。");
        } finally {
            operatingIds.value = operatingIds.value.filter((item) => item !== gid);
        }
    }

    // 单任务操作：暂停/继续/重试/移除（同一 gid 语义）。
    async function pauseTask(gid: string, refresh: () => Promise<unknown>): Promise<void> {
        await runOp(gid, (id) => facade.pause(id), refresh);
    }

    async function resumeTask(gid: string, refresh: () => Promise<unknown>): Promise<void> {
        await runOp(gid, (id) => facade.resume(id), refresh);
    }

    async function retryTask(gid: string, refresh: () => Promise<unknown>): Promise<void> {
        await runOp(gid, (id) => facade.retry(id), refresh);
    }

    async function removeTask(gid: string, refresh: () => Promise<unknown>): Promise<void> {
        await runOp(gid, (id) => facade.cancel(id), refresh);
    }

    // 批量操作：暂停全部/继续全部/清理 attention 组。
    async function pauseAllTasks(refresh: () => Promise<unknown>): Promise<void> {
        try {
            const count = await facade.pauseAll();
            ElMessage.success(count > 0 ? `已暂停全部：${count} 个任务。` : "暂无可暂停的任务。");
            await refresh();
        } catch (error: unknown) {
            ElMessage.error(error instanceof Error ? error.message : "操作失败，请稍后重试。");
        }
    }

    async function resumeAllTasks(refresh: () => Promise<unknown>): Promise<void> {
        try {
            const count = await facade.resumeAll();
            ElMessage.success(count > 0 ? `已继续全部：${count} 个任务。` : "暂无可继续的任务。");
            await refresh();
        } catch (error: unknown) {
            ElMessage.error(error instanceof Error ? error.message : "操作失败，请稍后重试。");
        }
    }

    async function retryAllFailedTasks(refresh: () => Promise<unknown>): Promise<void> {
        const failed = tasks.value.filter((t) => t.status === "error");
        if (failed.length === 0) {
            ElMessage.info("当前没有失败的任务。");
            return;
        }
        let success = 0;
        for (const task of failed) {
            try {
                await facade.retry(task.gid);
                success += 1;
            } catch {
                // 单条失败不中断。
            }
        }
        await refresh();
        ElMessage.success(`已重试 ${success} 个，共 ${failed.length} 个。`);
    }

    async function purgeAttentionTasks(refresh: () => Promise<unknown>): Promise<void> {
        const attention = tasks.value.filter((t) => t.status === "error" || t.status === "retrying");
        if (attention.length === 0) {
            ElMessage.info("当前没有可清理的历史任务。");
            return;
        }
        let removed = 0;
        for (const task of attention) {
            try {
                await facade.forget(task.gid);
                removed += 1;
            } catch {
                // 单条清理失败不中断。
            }
        }
        await refresh();
        ElMessage.success(`已清理 ${removed} 条历史任务。`);
    }

    return {
        tasks,
        queueFilter,
        taskPage,
        taskPageSize,
        filteredTasks,
        paginatedTasks,
        taskTotalPages,
        visibleTaskRangeLabel,
        taskPaginationItems,
        pull,
        subscribe,
        goToTaskPage,
        isOperating,
        pauseTask,
        resumeTask,
        retryTask,
        removeTask,
        pauseAllTasks,
        resumeAllTasks,
        retryAllFailedTasks,
        purgeAttentionTasks,
    };
}
