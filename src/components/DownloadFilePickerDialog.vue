<script setup lang="ts">
import { storeToRefs } from "pinia";
import { cn } from "@/lib/utils";
import {
    filterDownloadFilePickerItems,
    type TDownloadFilePickerFilter,
} from "@/lib/download-picker-filter";

const picker = useDownloadFilePickerStore();
const {
    open,
    title,
    description,
    note,
    items,
    selectedItemIds,
    multiple,
    confirmLabel,
    cancelLabel,
} = storeToRefs(picker);

watch(open, (opened) => {
    if (!opened) {
        picker.cancelPending();
    }
});

function handleSelect(itemId: string) {
    picker.selectItem(itemId);
}

function handleConfirm() {
    picker.confirmSelection();
}

function handleCancel() {
    picker.cancelPending();
}

function isSelected(itemId: string) {
    return selectedItemIds.value.includes(itemId);
}
// 有效勾选数（去掉已导入等禁用行）：确认按钮按它禁用，避免点确认静默无反应。
const validSelectedCount = computed(() => {
    return items.value.filter((item) => !item.disabled && isSelected(item.id)).length;
});


// 过滤器：全部/必装/可选/未下载/未勾选；过滤逻辑在 @/lib/download-picker-filter 里，便于单测。
const pickerFilter = ref<TDownloadFilePickerFilter>("all");
const pickerFilterOptions: Array<{
    value: TDownloadFilePickerFilter;
    label: string;
}> = [
    { value: "all", label: "全部" },
    { value: "undownloaded", label: "未下载" },
    { value: "required", label: "必装" },
    { value: "optional", label: "可选" },
    { value: "unselected", label: "未勾选" },
];
const visibleItems = computed(() => {
    return filterDownloadFilePickerItems(
        items.value,
        pickerFilter.value,
        isSelected,
    );
});
watch(open, () => {
    pickerFilter.value = "all";
});
</script>

<template>
    <Dialog v-model:open="open" modal>
        <DialogContent class="sm:max-w-3xl">
            <DialogHeader>
                <DialogTitle>{{ title }}</DialogTitle>
                <DialogDescription>
                    {{ description }}
                </DialogDescription>
            </DialogHeader>
            <div class="space-y-4">
                <div class="flex flex-wrap gap-2">
                    <Button
                        v-for="opt in pickerFilterOptions"
                        :key="opt.value"
                        size="sm"
                        :variant="pickerFilter === opt.value ? 'default' : 'outline'"
                        @click="pickerFilter = opt.value"
                    >
                        {{ opt.label }}
                    </Button>
                </div>
                <div
                    v-if="note"
                    class="rounded-xl border border-border/70 bg-muted/30 px-4 py-3 text-sm text-muted-foreground"
                >
                    {{ note }}
                </div>
                <div class="max-h-[48vh] space-y-3 overflow-y-auto pr-1">
                    <button
                        v-for="item in visibleItems"
                        :key="item.id"
                        type="button"
                        :disabled="item.disabled"
                        :class="
                            cn(
                                'w-full rounded-xl border px-4 py-4 text-left transition-colors',
                                item.disabled
                                    ? 'cursor-not-allowed opacity-50'
                                    : isSelected(item.id)
                                      ? 'border-primary bg-primary/5 shadow-xs'
                                      : 'hover:border-primary/40 hover:bg-muted/30',
                            )
                        "
                        @click="handleSelect(item.id)"
                    >
                        <div class="flex items-start justify-between gap-3">
                            <div class="space-y-2">
                                <div class="flex flex-wrap items-center gap-2">
                                    <div class="text-sm font-medium">
                                        {{ item.title }}
                                    </div>
                                    <Badge
                                        v-for="badge in item.badges"
                                        :key="`${item.id}-${badge}`"
                                        class="rounded-full"
                                        variant="outline"
                                    >
                                        {{ badge }}
                                    </Badge>
                                </div>
                                <p
                                    class="whitespace-pre-line text-sm leading-6 text-muted-foreground"
                                >
                                    {{ item.description }}
                                </p>
                            </div>

                            <div
                                :class="
                                    cn(
                                        'shrink-0 rounded-full border px-3 py-1 text-xs font-medium',
                                        isSelected(item.id)
                                            ? 'border-primary bg-primary text-primary-foreground'
                                            : 'border-border/70 text-muted-foreground',
                                    )
                                "
                            >
                                {{
                                    item.disabled
                                        ? (item.disabledReason || "已导入")
                                        : isSelected(item.id)
                                          ? multiple
                                              ? "已勾选"
                                              : "已选择"
                                          : multiple
                                            ? "点击勾选"
                                            : "点击选择"
                                }}
                            </div>
                        </div>
                    </button>
                </div>
            </div>

            <DialogFooter>
                <Button variant="outline" @click="handleCancel">
                    {{ cancelLabel }}
                </Button>
                <Button
                    :disabled="validSelectedCount === 0"
                    :title="validSelectedCount === 0 ? '请先勾选可下载的文件' : ''"
                    @click="handleConfirm"
                >
                    {{ confirmLabel }}
                </Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>
</template>

<style scoped></style>
