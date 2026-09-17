<script setup lang="ts">
import { PanelRightClose } from "lucide-vue-next";

const MANAGER_FALLBACK_COVER = "/imgs/logo.png";

const manager = useManager();
const { selectedDetailModId, detailPanelOpen } = storeToRefs(manager);

// 当前选中的 mod（本地字段兜底展示）
const detailMod = computed(() => {
    if (selectedDetailModId.value == null) return null;
    return (
        manager.managerModList.find(
            (mod) => mod.id === selectedDetailModId.value,
        ) ?? null
    );
});

interface IFileTreeNode {
    name: string;
    path: string;
    children: IFileTreeNode[];
    isFile: boolean;
}

// modFiles 扁平路径 -> 树（文件夹优先，文件夹/文件各自按名排序）
const fileTree = computed<IFileTreeNode[]>(() => {
    const files = detailMod.value?.modFiles ?? [];
    const root: IFileTreeNode[] = [];
    for (const filePath of files) {
        const parts = filePath.split('/').flatMap((s) => s.split('\\')).filter(Boolean);
        let level = root;
        let prefix = '';
        parts.forEach((part, index) => {
            const isLast = index === parts.length - 1;
            // 最后一段含扩展名视为文件，否则为文件夹
            const isFile = isLast && /\.[^./\\]+$/.test(part);
            prefix = prefix ? prefix + '/' + part : part;
            let node = level.find((n) => n.name === part && n.isFile === isFile);
            if (!node) {
                node = { name: part, path: prefix, children: [], isFile };
                level.push(node);
            }
            level = node.children;
        });
    }
    const sortNodes = (nodes: IFileTreeNode[]) => {
        nodes.sort((a, b) => {
            if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
            return a.name.localeCompare(b.name, 'zh-CN');
        });
        nodes.forEach((n) => sortNodes(n.children));
    };
    sortNodes(root);
    return root;
});

// 默认展开第一层
const expandedPaths = ref<Set<string>>(new Set());

watch(detailMod, () => {
    expandedPaths.value = new Set(
        fileTree.value.map((n) => n.path),
    );
}, { immediate: true });

function togglePath(path: string) {
    const next = new Set(expandedPaths.value);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    expandedPaths.value = next;
}

function closePanel() {
    detailPanelOpen.value = false;
}

function getCoverSrc(item: IModInfo) {
    return item.cover || MANAGER_FALLBACK_COVER;
}
</script>
<template>
    <Card
        v-if="detailPanelOpen"
        class="hidden max-h-full w-[26rem] shrink-0 self-stretch overflow-y-auto lg:block"
    >
        <CardHeader class="flex flex-row items-center justify-between gap-2">
            <CardTitle class="text-base">Mod 详情</CardTitle>
            <Button variant="ghost" size="icon" @click="closePanel">
                <PanelRightClose class="h-4 w-4" />
            </Button>
        </CardHeader>
        <CardContent v-if="detailMod" class="flex flex-col gap-4">
            <!-- 封面 -->
            <div class="overflow-hidden rounded-lg bg-muted/20">
                <AsyncImage
                    :src="getCoverSrc(detailMod)"
                    :fallback-src="MANAGER_FALLBACK_COVER"
                    :alt="`${detailMod.modName} 封面`"
                    class="h-auto w-full object-cover"
                />
            </div>
            <!-- 名称/版本/作者 -->
            <div class="space-y-1">
                <div class="font-medium leading-tight">
                    {{ detailMod.modName }}
                </div>
                <div class="text-xs text-muted-foreground">
                    {{ detailMod.modVersion || "未知版本" }}
                    <template v-if="detailMod.modAuthor">
                        · {{ detailMod.modAuthor }}
                    </template>
                </div>
            </div>
            <!-- 类型 + 标签 -->
            <div class="flex flex-wrap gap-1.5">
                <Badge variant="secondary">
                    {{ manager.getTypeName(detailMod.modType) }}
                </Badge>
                <Badge
                    v-for="tag in detailMod.tags ?? []"
                    :key="tag.name"
                    variant="outline"
                >
                    <div
                        class="h-2 w-2 rounded-full"
                        :style="{ backgroundColor: tag.color }"
                    ></div>
                    {{ tag.name }}
                </Badge>
            </div>
            <!-- 描述 -->
            <div class="space-y-1">
                <div class="text-xs font-medium text-muted-foreground">
                    介绍
                </div>
                <p
                    v-if="detailMod.modDesc"
                    class="max-h-48 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed"
                >
                    {{ detailMod.modDesc }}
                </p>
                <p v-else class="text-sm text-muted-foreground">暂无介绍</p>
            </div>
            <!-- 官网 -->
            <Button
                v-if="detailMod.modWebsite"
                variant="outline"
                size="sm"
                as-child
            >
                <a
                    :href="detailMod.modWebsite"
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    访问官网
                </a>
            </Button>
            <!-- 文件树 -->
            <div v-if="detailMod.modFiles?.length" class="space-y-1">
                <div class="text-xs font-medium text-muted-foreground">
                    文件（{{ detailMod.modFiles.length }}）
                </div>
                <ul class="max-h-64 space-y-0.5 overflow-y-auto text-xs">
                    <FileTreeNode
                        v-for="node in fileTree"
                        :key="node.path"
                        :node="node"
                        :depth="0"
                        :expanded-paths="expandedPaths"
                        @toggle="togglePath"
                    />
                </ul>
            </div>
            <!-- 来源 -->
            <div class="text-xs text-muted-foreground">
                来源：{{ detailMod.from ?? "本地" }}
                <template v-if="detailMod.webId">
                    #{{ detailMod.webId }}
                </template>
            </div>
        </CardContent>
        <CardContent v-else>
            <p class="py-10 text-center text-sm text-muted-foreground">
                点击任意 Mod 查看详情
            </p>
        </CardContent>
    </Card>
</template>
