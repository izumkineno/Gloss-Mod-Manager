// 下载文件选择弹窗的列表过滤器：纯函数，便于单测（弹窗本身是 SFC，逻辑放这里）。
// 分类看 IDownloadFilePickerItem.optional 语义字段，不用徽章文案——各来源的徽章
// 用词不同（Nexus "可选文件" / Collection "可选"），文本匹配会让可选页签空掉。
import type { IDownloadFilePickerItem } from "@/stores/download-picker";

export type TDownloadFilePickerFilter =
    | "all"
    | "required"
    | "optional"
    | "undownloaded"
    | "unselected";

// 某过滤器下可见的行；已导入等 disabled 行不受分类过滤影响（始终可见但不可点）。
export function filterDownloadFilePickerItems(
    items: IDownloadFilePickerItem[],
    filter: TDownloadFilePickerFilter,
    isSelected: (itemId: string) => boolean,
) {
    return items.filter((item) => {
        if (filter === "required" && item.optional === true) {
            return false;
        }

        if (filter === "optional" && item.optional !== true) {
            return false;
        }

        // 未下载：去掉已导入/已下载（两者都是 badges 标记，无需任务快照）。
        if (
            filter === "undownloaded" &&
            (item.badges.includes("已导入") || item.badges.includes("已下载"))
        ) {
            return false;
        }

        if (filter === "unselected" && isSelected(item.id)) {
            return false;
        }

        return true;
    });
}
