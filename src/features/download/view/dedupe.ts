// 去重弹窗编排（Wave 3.6 机械抽取）：promise 式弹窗 + 去重键/同文件归一。
// 与 download.vue 原实现逐行一致，只挪位置；解决器关闭时默认 cancel。
import { reactive } from "vue";
import type { Ref } from "vue";
import type { IDownloaderTask } from "../types";
import type { IGlossDownloadTaskMeta } from "@/lib/gloss-download";

// 去重决策动作（弹窗选项值）。
export type DuplicateDecisionAction =
    | "cancel"
    | "continue"
    | "overwrite"
    | "keep-both";

// 弹窗内任务条目。
export interface IDuplicateDialogItem {
    title: string;
    description: string;
    badges: string[];
}

// 弹窗选项按钮。
export interface IDuplicateDialogOption {
    value: DuplicateDecisionAction;
    label: string;
    description: string;
    variant?: "default" | "outline" | "destructive";
}

// 弹窗状态（模板直接绑定）。
export interface IDuplicateDialogState {
    open: boolean;
    title: string;
    description: string;
    note: string;
    items: IDuplicateDialogItem[];
    options: IDuplicateDialogOption[];
}

export interface IDedupeMetaSource {
    taskMetaMap: Ref<Record<string, IGlossDownloadTaskMeta>>;
    allTasks: Ref<IDownloaderTask[]>;
    getTaskDisplayName: (task: IDownloaderTask) => string;
}

// 去重弹窗 composable：open 状态 + promise 解决器。
export function useDedupeDialog() {
    const duplicateDialog = reactive<IDuplicateDialogState>({
        open: false,
        title: "",
        description: "",
        note: "",
        items: [],
        options: [],
    });

    let duplicateDialogResolver:
        | ((action: DuplicateDecisionAction) => void)
        | null = null;

    // 解决并清空弹窗（无等待者时空操作）。
    function resolveDuplicateDialog(action: DuplicateDecisionAction): void {
        const resolver = duplicateDialogResolver;

        duplicateDialogResolver = null;
        duplicateDialog.open = false;
        duplicateDialog.title = "";
        duplicateDialog.description = "";
        duplicateDialog.note = "";
        duplicateDialog.items = [];
        duplicateDialog.options = [];
        resolver?.(action);
    }

    // 弹出决策框并等待用户选择；已有未决弹窗时先按 cancel 解决旧的。
    function promptDuplicateDecision(options: {
        title: string;
        description: string;
        note?: string;
        items: IDuplicateDialogItem[];
        actions: IDuplicateDialogOption[];
    }): Promise<DuplicateDecisionAction> {
        if (duplicateDialogResolver) {
            resolveDuplicateDialog("cancel");
        }

        duplicateDialog.title = options.title;
        duplicateDialog.description = options.description;
        duplicateDialog.note = options.note ?? "";
        duplicateDialog.items = options.items;
        duplicateDialog.options = options.actions;
        duplicateDialog.open = true;

        return new Promise<DuplicateDecisionAction>((resolve) => {
            duplicateDialogResolver = resolve;
        });
    }

    // 弹窗被外部关闭（X/遮罩）时按 cancel 解决，避免 promise 悬挂。
    function onDuplicateDialogClosed(): void {
        if (!duplicateDialog.open && duplicateDialogResolver) {
            const resolver = duplicateDialogResolver;

            duplicateDialogResolver = null;
            resolver("cancel");
        }
    }

    return {
        duplicateDialog,
        resolveDuplicateDialog,
        promptDuplicateDecision,
        onDuplicateDialogClosed,
    };
}

// 同文件归一键：externalId:resourceId 优先（跨入口同文件同键），其次 fileName，其次 gid。
export function getStoppedTaskDedupeKey(
    task: IDownloaderTask,
    metaMap: Record<string, IGlossDownloadTaskMeta>,
    getPrimaryFileName: (task: IDownloaderTask) => string,
): string {
    const meta = metaMap[task.gid];
    const externalId = meta?.externalId ?? meta?.modId ?? "";
    if (externalId && meta?.resourceId) return `id:${externalId}:${meta.resourceId}`;
    const fileName = meta?.fileName || getPrimaryFileName(task);
    if (fileName.trim()) return `file:${fileName.trim().toLowerCase()}`;
    return `gid:${task.gid}`;
}

// 新任务落定后清理同键的旧 stopped 记录，返回清理条数（单条失败不中断）。
export async function removeStaleSiblingRecords(
    newGid: string,
    source: IDedupeMetaSource & { forgetTaskRecord: (gid: string) => Promise<void> },
    getPrimaryFileName: (task: IDownloaderTask) => string,
): Promise<number> {
    const newTask = source.allTasks.value.find((task) => task.gid === newGid);
    if (!newTask) return 0;
    const key = getStoppedTaskDedupeKey(newTask, source.taskMetaMap.value, getPrimaryFileName);
    let cleaned = 0;
    for (const task of [...source.allTasks.value]) {
        if (task.gid === newGid || getStoppedTaskDedupeKey(task, source.taskMetaMap.value, getPrimaryFileName) !== key) continue;
        try {
            await source.forgetTaskRecord(task.gid);
            cleaned += 1;
        } catch {
            // 单条清理失败不中断。
        }
    }
    return cleaned;
}
