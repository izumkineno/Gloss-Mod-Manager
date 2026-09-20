<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { ElMessage } from "element-plus-message";
import {
    clearManagerInternalDrag,
    INTERNAL_DRAG_THRESHOLD,
    managerDragKind,
    managerDraggingTagName,
    startManagerTagDrag,
} from "@/lib/manager-internal-drag";

const manager = useManager();

const tagName = ref("");
const tagColor = ref("#14F7D8");
const showTagEditDialog = ref(false);
const editingTagName = ref("");
const dragTargetTagName = ref("");
const pendingTagName = ref("");
const pendingPointerPosition = ref<{ x: number; y: number } | null>(null);
// 下拉开关：选完标签自动收起
const tagPopoverOpen = ref(false);
const props = defineProps<{
    headless?: boolean;
}>();
function openCreate() {
    openCreateTagDialog();
}
defineExpose({ openCreate });

function openCreateTagDialog() {
    resetTagEditor();
    showTagEditDialog.value = true;
}

function openEditTagDialog(tag: ITag) {
    editingTagName.value = tag.name;
    tagName.value = tag.name;
    tagColor.value = tag.color;
    showTagEditDialog.value = true;
}

async function submitTag() {
    try {
        await manager.upsertTag({
            name: tagName.value,
            color: tagColor.value,
            previousName: editingTagName.value || undefined,
        });
        ElMessage.success(editingTagName.value ? "标签已更新。" : "标签已添加。");
        resetTagEditor();
        showTagEditDialog.value = false;
    } catch (error: unknown) {
        ElMessage.warning(
            error instanceof Error ? error.message : "保存标签失败。",
        );
    }
}

async function deleteTag(tag: ITag) {
    const confirmed = window.confirm(
        `确定删除标签 ${tag.name} 吗？这会同时把它从所有 Mod 上移除。`,
    );

    if (!confirmed) {
        return;
    }

    try {
        await manager.deleteTag(tag.name);

        if (editingTagName.value === tag.name) {
            resetTagEditor();
            showTagEditDialog.value = false;
        }

        ElMessage.success("标签已删除。");
    } catch (error: unknown) {
        ElMessage.error(
            error instanceof Error ? error.message : "删除标签失败。",
        );
    }
}

function clearTagDragState() {
    dragTargetTagName.value = "";
    pendingTagName.value = "";
    pendingPointerPosition.value = null;
}

async function reorderTag(draggedName: string, targetName: string) {
    const reordered = await manager.reorderTags(draggedName, targetName);

    if (!reordered) {
        clearTagDragState();
        return;
    }

    clearTagDragState();
    ElMessage.success("标签顺序已更新。");
}

function handleTagPointerDown(event: PointerEvent, tag: ITag) {
    if (event.button !== 0) {
        return;
    }

    pendingTagName.value = tag.name;
    pendingPointerPosition.value = {
        x: event.clientX,
        y: event.clientY,
    };
}

function handleTagPointerEnter(tag: ITag) {
    if (
        managerDragKind.value !== "tag" ||
        !managerDraggingTagName.value ||
        managerDraggingTagName.value === tag.name
    ) {
        return;
    }

    dragTargetTagName.value = tag.name;
}

function handleTagPointerLeave(tag: ITag) {
    if (dragTargetTagName.value === tag.name) {
        dragTargetTagName.value = "";
    }
}

function handleWindowPointerMove(event: PointerEvent) {
    if (
        !pendingTagName.value ||
        !pendingPointerPosition.value ||
        managerDragKind.value !== null
    ) {
        return;
    }

    const deltaX = event.clientX - pendingPointerPosition.value.x;
    const deltaY = event.clientY - pendingPointerPosition.value.y;

    if (Math.hypot(deltaX, deltaY) < INTERNAL_DRAG_THRESHOLD) {
        return;
    }

    startManagerTagDrag(pendingTagName.value);
}

function handleWindowPointerUp() {
    const draggedName = managerDraggingTagName.value;
    const targetName = dragTargetTagName.value;

    if (
        managerDragKind.value === "tag" &&
        draggedName &&
        targetName &&
        draggedName !== targetName
    ) {
        void reorderTag(draggedName, targetName);
        clearManagerInternalDrag();
        return;
    }

    clearTagDragState();
}

// 选中标签：写 store + 收起下拉
function pickTag(name: string) {
    manager.selectedTag = name;
    tagPopoverOpen.value = false;
}

onMounted(() => {
    window.addEventListener("pointermove", handleWindowPointerMove);
    window.addEventListener("pointerup", handleWindowPointerUp, true);
});

onUnmounted(() => {
    window.removeEventListener("pointermove", handleWindowPointerMove);
    window.removeEventListener("pointerup", handleWindowPointerUp, true);
});

function resetTagEditor() {
    editingTagName.value = "";
    tagName.value = "";
    tagColor.value = "#14F7D8";
}
</script>
<template>
    <!-- 标签下拉：筛选 + 颜色点 + 右键编辑/删除 + 拖拽排序 + 新增，全在 popover 里 -->
    <Popover v-if="!props.headless" v-model:open="tagPopoverOpen">
        <PopoverTrigger as-child>
            <Button variant="outline" size="sm" class="shrink-0">
                <span v-if="manager.selectedTag !== '全部' && manager.selectedTag !== manager.UNTAGGED_FILTER"
                    class="h-2.5 w-2.5 rounded-full"
                    :style="{ backgroundColor: manager.tags.find((t) => t.name === manager.selectedTag)?.color ?? 'transparent' }" />
                <span v-else-if="manager.selectedTag === manager.UNTAGGED_FILTER"
                    class="h-2.5 w-2.5 rounded-full border border-dashed border-muted-foreground" />
                {{ manager.selectedTag === "全部" ? "标签" : manager.selectedTag }}
            </Button>
        </PopoverTrigger>
        <PopoverContent align="start" class="w-56 p-1">
            <button class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
                :class="manager.selectedTag === '全部' ? 'bg-accent' : ''" @click="pickTag('全部')">
                全部标签
            </button>
            <button class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
                :class="manager.selectedTag === manager.UNTAGGED_FILTER ? 'bg-accent' : ''"
                @click="pickTag(manager.UNTAGGED_FILTER)">
                <span class="h-2.5 w-2.5 rounded-full border border-dashed border-muted-foreground" />
                未打标签
            </button>
            <div v-for="tag in manager.tags" :key="tag.name">
                <ContextMenu>
                    <ContextMenuTrigger
                        class="flex w-full cursor-grab items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent active:cursor-grabbing"
                        :class="[
                            manager.selectedTag === tag.name ? 'bg-accent' : '',
                            dragTargetTagName === tag.name && managerDraggingTagName !== tag.name
                                ? 'ring-1 ring-primary/50 bg-primary/5'
                                : '',
                        ]" @click="pickTag(tag.name)" @pointerdown="handleTagPointerDown($event, tag)"
                        @pointerenter="handleTagPointerEnter(tag)" @pointerleave="handleTagPointerLeave(tag)">
                        <div class="h-2.5 w-2.5 shrink-0 rounded-full" :style="{
                            backgroundColor: tag.color,
                        }" />
                        <span class="min-w-0 flex-1 truncate text-left">{{ tag.name }}</span>
                    </ContextMenuTrigger>
                    <ContextMenuContent class="w-32">
                        <ContextMenuItem @select="openEditTagDialog(tag)">
                            <IconEdit class="h-4 w-4" />
                            编辑
                        </ContextMenuItem>
                        <ContextMenuItem @select="deleteTag(tag)">
                            <IconTrash class="h-4 w-4" />
                            删除
                        </ContextMenuItem>
                    </ContextMenuContent>
                </ContextMenu>
            </div>
            <div class="mt-1 border-t pt-1">
                <Button variant="ghost" size="sm" class="w-full justify-start" @click="openCreateTagDialog">
                    <IconPlus class="h-4 w-4" />
                    新增标签
                </Button>
            </div>
        </PopoverContent>
    </Popover>
    <Dialog v-model:open="showTagEditDialog" modal>
        <DialogContent>
            <DialogHeader>
                <DialogTitle>
                    {{ editingTagName ? "编辑标签" : "添加标签" }}
                </DialogTitle>
            </DialogHeader>
            <DialogDescription class="flex flex-col gap-2">
                <InputGroup>
                    <InputGroupInput v-model="tagName" placeholder="标签名称" />
                    <InputGroupAddon align="inline-end">
                        <input type="color" v-model="tagColor" />
                    </InputGroupAddon>
                </InputGroup>
                <Button size="sm" class="self-end" @click="submitTag">
                    <IconPlus class="h-4 w-4" />
                    {{ editingTagName ? "保存" : "添加" }}
                </Button>
            </DialogDescription>
        </DialogContent>
    </Dialog>
</template>
<style scoped></style>
