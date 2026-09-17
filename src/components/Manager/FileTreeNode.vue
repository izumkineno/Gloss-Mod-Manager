<script setup lang="ts">
import { ChevronRight, File, Folder } from "lucide-vue-next";

interface IFileTreeNode {
    name: string;
    path: string;
    children: IFileTreeNode[];
    isFile: boolean;
}

defineProps<{
    node: IFileTreeNode;
    depth: number;
    expandedPaths: Set<string>;
}>();

defineEmits<{
    toggle: [path: string];
}>();
</script>
<template>
    <li>
        <!-- 文件夹：点击展开/收起 -->
        <button
            v-if="!node.isFile"
            type="button"
            class="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-accent/60"
            :style="{ paddingLeft: `${depth * 12 + 4}px` }"
            @click="$emit('toggle', node.path)"
        >
            <ChevronRight
                class="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform"
                :class="{ 'rotate-90': expandedPaths.has(node.path) }"
            />
            <Folder class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span class="truncate" :title="node.path">{{ node.name }}</span>
            <span class="ml-auto shrink-0 text-muted-foreground/60">
                {{ node.children.length }}
            </span>
        </button>
        <!-- 文件：缩进对齐 -->
        <div
            v-else
            class="flex items-center gap-1 px-1 py-0.5 text-muted-foreground"
            :style="{ paddingLeft: `${depth * 12 + 20}px` }"
        >
            <File class="h-3.5 w-3.5 shrink-0" />
            <span class="truncate" :title="node.path">{{ node.name }}</span>
        </div>
        <!-- 子节点 -->
        <ul v-if="!node.isFile && expandedPaths.has(node.path)">
            <FileTreeNode
                v-for="child in node.children"
                :key="child.path"
                :node="child"
                :depth="depth + 1"
                :expanded-paths="expandedPaths"
                @toggle="$emit('toggle', $event)"
            />
        </ul>
    </li>
</template>
