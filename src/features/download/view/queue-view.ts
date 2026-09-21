// 下载队列视图逻辑（Wave 3.6 机械抽取）：筛选/排序/分页/选择。
// 与 download.vue 原实现逐行一致，只挪位置；模板绑定名保持不变。
import { computed, ref } from "vue";
import type { Ref } from "vue";
import type { IDownloaderTask } from "../types";
import type { IGlossDownloadTaskMeta } from "@/lib/gloss-download";

// 队列筛选（模板筛选按钮共用，含导入态）。
export type QueueFilter = "all" | "active" | "waiting" | "paused" | "stopped" | "failed" | "imported" | "unimported";

// 分页条目（数字页/省略号）。
export interface IPageItem {
    key: string;
    label: string;
    page?: number;
    ellipsis?: boolean;
}

// 筛选按钮中文标签。
export const queueFilterLabels: Record<QueueFilter, string> = {
    all: "全部",
    active: "下载中",
    waiting: "等待中",
    paused: "已暂停",
    stopped: "已结束",
    failed: "下载失败",
    imported: "已导入",
    unimported: "未导入",
};

// 状态排序权重（创建时间相同时先按状态排）。
export const TASK_STATUS_SORT_ORDER: Record<string, number> = {
    active: 0,
    waiting: 1,
    paused: 2,
    complete: 3,
    error: 4,
    removed: 5,
};

export const DEFAULT_TASK_PAGE_SIZE = "20";
export const TASK_PAGE_SIZE_OPTIONS = ["20", "50", "100"];

// 状态排序权重查询：未知状态沉底。
export function getTaskStatusSortOrder(status: string): number {
    return TASK_STATUS_SORT_ORDER[status] ?? Number.MAX_SAFE_INTEGER;
}

// 时间戳解析：非法返回 0 便于比较。
export function parseTaskTimestamp(value?: string): number {
    if (!value) {
        return 0;
    }

    const timestamp = Date.parse(value);

    return Number.isNaN(timestamp) ? 0 : timestamp;
}

// 队列排序：状态权重优先，其次创建时间倒序，最后 gid 倒序保证稳定。
export function sortTasksByCreatedAt(
    tasks: IDownloaderTask[],
    getCreatedTimestamp: (task: IDownloaderTask) => number,
): IDownloaderTask[] {
    return [...tasks].sort((left, right) => {
        const statusDifference =
            getTaskStatusSortOrder(left.status) -
            getTaskStatusSortOrder(right.status);

        if (statusDifference !== 0) {
            return statusDifference;
        }

        const timestampDifference =
            getCreatedTimestamp(right) - getCreatedTimestamp(left);

        if (timestampDifference !== 0) {
            return timestampDifference;
        }

        return right.gid.localeCompare(left.gid);
    });
}

// 分页条目生成：首尾页 + 当前页前后一页，断档处插省略号。
export function buildPaginationItems(totalPages: number, currentPage: number): IPageItem[] {
    if (totalPages <= 1) {
        return [];
    }

    const pages = new Set<number>([
        1,
        totalPages,
        currentPage - 1,
        currentPage,
        currentPage + 1,
    ]);

    if (currentPage <= 3) {
        pages.add(2);
        pages.add(3);
        pages.add(4);
    }

    if (currentPage >= totalPages - 2) {
        pages.add(totalPages - 1);
        pages.add(totalPages - 2);
        pages.add(totalPages - 3);
    }

    const sortedPages = [...pages]
        .filter((value) => value >= 1 && value <= totalPages)
        .sort((left, right) => left - right);

    const items: IPageItem[] = [];
    let previousPage = 0;

    for (const value of sortedPages) {
        if (value - previousPage > 1) {
            items.push({
                key: `ellipsis-${previousPage}-${value}`,
                label: "...",
                ellipsis: true,
            });
        }

        items.push({
            key: `page-${value}`,
            label: String(value),
            page: value,
        });
        previousPage = value;
    }

    return items;
}

export interface QueueBuckets {
    activeTasks: Ref<IDownloaderTask[]>;
    waitingTasks: Ref<IDownloaderTask[]>;
    allTasks: Ref<IDownloaderTask[]>;
    failedTasks: Ref<IDownloaderTask[]>;
    finishedTasks: Ref<IDownloaderTask[]>;
    taskMetaMap: Ref<Record<string, IGlossDownloadTaskMeta>>;
}

// 队列视图 composable：筛选/分页/选中任务（数据由调用方传入的桶 refs 提供）。
export function useQueueView(buckets: QueueBuckets) {
    // 当前筛选/页码/选中任务（模板直接绑定）。
    const queueFilter = ref<QueueFilter>("all");
    const taskPage = ref(1);
    const taskPageSize = ref(DEFAULT_TASK_PAGE_SIZE);
    const selectedTaskGid = ref("");

    // waiting 桶内再分 waiting/paused（模板 v-if 区分）。
    const waitingQueueTasks = computed(() =>
        buckets.waitingTasks.value.filter((task) => task.status === "waiting"),
    );
    const pausedTasks = computed(() =>
        buckets.waitingTasks.value.filter((task) => task.status === "paused"),
    );
    const importedTasks = computed(() =>
        buckets.allTasks.value.filter((task) => buckets.taskMetaMap.value[task.gid]?.localModId != null),
    );
    const unimportedTasks = computed(() =>
        buckets.allTasks.value.filter((task) => buckets.taskMetaMap.value[task.gid]?.localModId == null),
    );

    // 任务创建时间：meta.createdAt 优先，其次 updatedAt。
    const getTaskCreatedTimestamp = (task: IDownloaderTask): number => {
        const metadata = buckets.taskMetaMap.value[task.gid];

        return (
            parseTaskTimestamp(metadata?.createdAt) ||
            parseTaskTimestamp(metadata?.updatedAt)
        );
    };

    // 当前筛选下的任务（已按添加时间倒序排好）。
    const filteredTasks = computed(() => {
        let tasks: IDownloaderTask[] = [];

        switch (queueFilter.value) {
            case "active":
                tasks = buckets.activeTasks.value;
                break;
            case "waiting":
                tasks = waitingQueueTasks.value;
                break;
            case "paused":
                tasks = pausedTasks.value;
                break;
            case "failed":
                tasks = buckets.failedTasks.value;
                break;
            case "stopped":
                tasks = buckets.finishedTasks.value;
                break;
            case "imported":
                tasks = importedTasks.value;
                break;
            case "unimported":
                tasks = unimportedTasks.value;
                break;
            default:
                tasks = buckets.allTasks.value;
                break;
        }

        return sortTasksByCreatedAt(tasks, getTaskCreatedTimestamp);
    });

    const taskPageSizeNumber = computed(() => Number(taskPageSize.value));
    const filteredTaskCount = computed(() => filteredTasks.value.length);
    const paginatedTasks = computed(() => {
        const startIndex = (taskPage.value - 1) * taskPageSizeNumber.value;
        return filteredTasks.value.slice(
            startIndex,
            startIndex + taskPageSizeNumber.value,
        );
    });
    const taskTotalPages = computed(() => {
        if (filteredTaskCount.value === 0) {
            return 0;
        }

        return Math.ceil(filteredTaskCount.value / taskPageSizeNumber.value);
    });
    const visibleTaskRangeLabel = computed(() => {
        if (filteredTaskCount.value === 0) {
            return "暂无任务";
        }

        const startIndex = (taskPage.value - 1) * taskPageSizeNumber.value + 1;
        const endIndex = startIndex + paginatedTasks.value.length - 1;

        return `显示第 ${startIndex}-${endIndex} 条，共 ${filteredTaskCount.value} 条`;
    });
    const taskPaginationItems = computed<IPageItem[]>(() =>
        buildPaginationItems(taskTotalPages.value, taskPage.value),
    );

    // 选中任务及其 meta（详情弹窗用）。
    const selectedTask = computed(
        () =>
            buckets.allTasks.value.find((task) => task.gid === selectedTaskGid.value) ??
            null,
    );
    const selectedTaskMeta = computed(
        () => buckets.taskMetaMap.value[selectedTaskGid.value] ?? null,
    );

    // 筛选按钮（含各桶计数）。
    const queueFilterOptions = computed(() => [
        { value: "all" as QueueFilter, label: queueFilterLabels.all, count: buckets.allTasks.value.length },
        { value: "active" as QueueFilter, label: queueFilterLabels.active, count: buckets.activeTasks.value.length },
        { value: "waiting" as QueueFilter, label: queueFilterLabels.waiting, count: waitingQueueTasks.value.length },
        { value: "paused" as QueueFilter, label: queueFilterLabels.paused, count: pausedTasks.value.length },
        { value: "stopped" as QueueFilter, label: queueFilterLabels.stopped, count: buckets.finishedTasks.value.length },
        { value: "failed" as QueueFilter, label: queueFilterLabels.failed, count: buckets.failedTasks.value.length },
        { value: "imported" as QueueFilter, label: queueFilterLabels.imported, count: importedTasks.value.length },
        { value: "unimported" as QueueFilter, label: queueFilterLabels.unimported, count: unimportedTasks.value.length },
    ]);

    // 跳页：钳制到合法范围。
    function goToTaskPage(nextPage: number): void {
        if (taskTotalPages.value <= 0) {
            taskPage.value = 1;
            return;
        }

        taskPage.value = Math.min(Math.max(1, nextPage), taskTotalPages.value);
    }

    // 选中任务越界时回落到首个（任务列表变化时调用方 watch 调用）。
    function fixSelectedTask(): void {
        const tasks = buckets.allTasks.value;
        if (tasks.length === 0) {
            selectedTaskGid.value = "";
            return;
        }

        if (!selectedTaskGid.value) {
            selectedTaskGid.value = tasks[0].gid;
            return;
        }

        if (!tasks.some((task) => task.gid === selectedTaskGid.value)) {
            selectedTaskGid.value = tasks[0].gid;
        }
    }

    // 筛选/页大小变化回到第一页；总数变化时钳制页码。
    function fixTaskPage(): void {
        const count = filteredTaskCount.value;
        if (count === 0) {
            taskPage.value = 1;
            return;
        }

        const maxPage = Math.ceil(count / taskPageSizeNumber.value);

        if (taskPage.value > maxPage) {
            taskPage.value = maxPage;
        }
    }

    return {
        queueFilter,
        taskPage,
        taskPageSize,
        selectedTaskGid,
        waitingQueueTasks,
        pausedTasks,
        importedTasks,
        unimportedTasks,
        filteredTasks,
        taskPageSizeNumber,
        filteredTaskCount,
        paginatedTasks,
        taskTotalPages,
        visibleTaskRangeLabel,
        taskPaginationItems,
        selectedTask,
        selectedTaskMeta,
        queueFilterOptions,
        getTaskCreatedTimestamp,
        goToTaskPage,
        fixSelectedTask,
        fixTaskPage,
    };
}
