export interface IDownloadFilePickerItem {
    id: string;
    title: string;
    description: string;
    badges: string[];
    // 分类语义（弹窗"必装/可选"页签按它分桶）：true=可选，false/缺省=必装。
    // 不能用 badges 文案判断：Nexus 用"可选文件"、Collection 用"可选"，文本匹配会串台。
    optional?: boolean;
    // 已导入等不可选：禁用勾选，确认时过滤。
    disabled?: boolean;
    disabledReason?: string;
}

export interface IDownloadFilePickerRequest {
    title: string;
    description: string;
    note?: string;
    items: IDownloadFilePickerItem[];
    initialItemId?: string;
    initialItemIds?: string[];
    multiple?: boolean;
    confirmLabel?: string;
    cancelLabel?: string;
}

type DownloadFilePickerValue = string | string[] | null;
type DownloadFilePickerResolver = (value: DownloadFilePickerValue) => void;

export const useDownloadFilePickerStore = defineStore(
    "DownloadFilePicker",
    () => {
        const open = ref(false);
        const title = ref("");
        const description = ref("");
        const note = ref("");
        const items = ref<IDownloadFilePickerItem[]>([]);
        const selectedItemId = ref("");
        const selectedItemIds = ref<string[]>([]);
        const multiple = ref(false);
        const confirmLabel = ref("下载选中文件");
        const cancelLabel = ref("取消");

        let resolver: DownloadFilePickerResolver | null = null;

        function resetState() {
            title.value = "";
            description.value = "";
            note.value = "";
            items.value = [];
            selectedItemId.value = "";
            selectedItemIds.value = [];
            multiple.value = false;
            confirmLabel.value = "下载选中文件";
            cancelLabel.value = "取消";
        }

        function selectItem(itemId: string) {
            const target = items.value.find((item) => item.id === itemId);
            if (!target || target.disabled) {
                return;
            }

            if (!multiple.value) {
                selectedItemId.value = itemId;
                selectedItemIds.value = [itemId];
                return;
            }

            selectedItemIds.value = selectedItemIds.value.includes(itemId)
                ? selectedItemIds.value.filter((id) => id !== itemId)
                : [...selectedItemIds.value, itemId];
            selectedItemId.value = selectedItemIds.value[0] ?? "";
        }

        function cancelPending() {
            const currentResolver = resolver;

            resolver = null;
            open.value = false;
            resetState();
            currentResolver?.(null);
        }

        function confirmSelection(itemId?: string) {
            const nextItemIds = multiple.value
                ? selectedItemIds.value
                : [itemId ?? selectedItemId.value];

            const validItemIds = nextItemIds.filter((id) =>
                items.value.some((item) => item.id === id && !item.disabled),
            );

            if (validItemIds.length === 0) {
                return;
            }

            const currentResolver = resolver;
            const isMultipleSelection = multiple.value;

            resolver = null;
            open.value = false;
            resetState();
            currentResolver?.(
                isMultipleSelection ? validItemIds : validItemIds[0],
            );
        }

        function promptSelection(options: IDownloadFilePickerRequest) {
            if (resolver) {
                cancelPending();
            }

            title.value = options.title;
            description.value = options.description;
            note.value = options.note ?? "";
            items.value = [...options.items];
            multiple.value = Boolean(options.multiple);

            const initialItemIds = [
                ...(options.initialItemIds ?? []),
                ...(options.initialItemId ? [options.initialItemId] : []),
            ].filter((id, index, list) => {
                return (
                    list.indexOf(id) === index &&
                    options.items.some((item) => item.id === id)
                );
            });
            const firstSelectable = options.items.find((item) => !item.disabled) ?? null;
            selectedItemIds.value =
                initialItemIds.length > 0
                    ? initialItemIds
                    : firstSelectable
                      ? [firstSelectable.id]
                      : [];
            confirmLabel.value = options.confirmLabel ?? "下载选中文件";
            cancelLabel.value = options.cancelLabel ?? "取消";
            open.value = true;

            return new Promise<DownloadFilePickerValue>((resolve) => {
                resolver = resolve;
            });
        }

        return {
            open,
            title,
            description,
            note,
            items,
            selectedItemId,
            selectedItemIds,
            multiple,
            confirmLabel,
            cancelLabel,
            selectItem,
            cancelPending,
            confirmSelection,
            promptSelection,
        };
    },
);
