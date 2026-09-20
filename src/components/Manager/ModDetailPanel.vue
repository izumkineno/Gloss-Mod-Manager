<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { PanelRightClose } from "lucide-vue-next";
import RichModDesc from "@/components/common/RichModDesc.vue";
import { fetchNexusModsModMeta } from "@/lib/third-party-mod-api";
import { useSettings } from "@/stores/settings";
import { useManager } from "@/stores/manager";

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

// 在线懒加载：老数据本地介绍/封面为空时，现取线上并写回本地。
// 触发条件：Nexus 来源 + 有 webId + 介绍或封面缺失；失败静默，保持本地展示。
const settings = useSettings();
const onlineDesc = ref("");
const onlineCover = ref("");
const onlineLoading = ref(false);
// 死图/缺字段统一入口：force=true 时无视本地值强制重拉（图片 404/过期场景）。
const deadCoverRetriedIds = new Set<number>();
async function hydrateMod(mod: IModInfo, force = false) {
    onlineDesc.value = "";
    onlineCover.value = "";
    const hydrateTag = `[hydrate] id=${mod.id} name=${mod.modName} from=${mod.from ?? ""} webId=${String(mod.webId ?? "")}`;
    const needDesc = force || !mod.modDesc?.trim();
    const needCover = force || !mod.cover?.trim();
    console.debug(`${hydrateTag} stage=check force=${force} needDesc=${needDesc} needCover=${needCover} localDescLen=${mod.modDesc?.length ?? 0} cover=${mod.cover ? "yes" : "no"}`);
    if (!needDesc && !needCover) {
        console.debug(`${hydrateTag} stage=skip reason=complete`);
        return;
    }
    if (mod.from !== "NexusMods") {
        console.debug(`${hydrateTag} stage=skip reason=non-nexus`);
        return;
    }
    const webId = String(mod.webId ?? "").trim();
    if (!webId || webId === "0") {
        console.debug(`${hydrateTag} stage=skip reason=no-webId`);
        return;
    }
    const gameDomain = manager.managerGame?.nexusMods?.game_domain_name?.trim() ?? "";
    if (!gameDomain) {
        console.debug(`${hydrateTag} stage=skip reason=no-gameDomain`);
        return;
    }
    onlineLoading.value = true;
    console.debug(`${hydrateTag} stage=fetch-start domain=${gameDomain}`);
    const fetchStart = Date.now();
    try {
        const meta = await fetchNexusModsModMeta(gameDomain, webId, settings.nexusModsUser);
        console.debug(`${hydrateTag} stage=fetch-done costMs=${Date.now() - fetchStart} hit=${Boolean(meta)} descLen=${meta?.description?.length ?? 0} summaryLen=${meta?.summary?.length ?? 0} author=${meta?.author ?? ""} cover=${meta?.cover ? "yes" : "no"}`);
        if (!meta) return;
        if (selectedDetailModId.value !== mod.id) {
            console.debug(`${hydrateTag} stage=drop reason=selection-changed`);
            return;
        }
        const desc = meta.description || meta.summary || "";
        if (needDesc && desc) onlineDesc.value = desc;
        if (needCover && meta.cover) onlineCover.value = meta.cover;
        console.debug(`${hydrateTag} stage=apply onlineDesc=${Boolean(onlineDesc.value)} onlineCover=${Boolean(onlineCover.value)}`);
        if (!onlineDesc.value && !onlineCover.value) return;
        manager.managerModList = manager.managerModList.map((item) =>
            item.id !== mod.id ? item : manager.normalizeMod({
                ...item,
                modAuthor: meta.author || item.modAuthor,
                modDesc: needDesc && desc ? desc : item.modDesc,
                cover: needCover && meta.cover ? meta.cover : item.cover,
            }),
        );
        await manager.saveManagerData();
        console.debug(`${hydrateTag} stage=persisted`);
    } catch (error: unknown) {
        console.warn(`${hydrateTag} stage=fetch-error error=${error instanceof Error ? error.message : String(error)}`);
    } finally {
        onlineLoading.value = false;
    }
}
watch(detailMod, (mod) => {
    deadCoverRetriedIds.clear();
    if (!mod) {
        console.debug("[hydrate] skip reason=no-mod");
        return;
    }
    void hydrateMod(mod);
}, { immediate: true });

// 原图加载失败（404/过期 CDN）：强制重拉一次，新 cover 写回本地；还拿不到就保持 fallback。
function handleCoverFailed(failedSrc: string) {
    const mod = detailMod.value;
    if (!mod || deadCoverRetriedIds.has(mod.id)) return;
    deadCoverRetriedIds.add(mod.id);
    console.warn(`[hydrate] id=${mod.id} stage=cover-dead src=${failedSrc.slice(0, 120)} action=refetch`);
    void hydrateMod({ ...mod, cover: "", modDesc: mod.modDesc ?? "" }, true);
}

// 本地优先，在线兜底。
const descSource = computed(() => detailMod.value?.modDesc || onlineDesc.value);

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
    if (item.cover?.trim()) return item.cover;
    if (detailMod.value && item.id === detailMod.value.id && onlineCover.value) return onlineCover.value;
    return MANAGER_FALLBACK_COVER;
}
// 介绍渲染已抽到公共组件 RichModDesc
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
                    @failed="handleCoverFailed"
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
            <!-- 描述:公共富文本组件,紧凑暗色面板 -->
            <div class="space-y-1">
                <div class="text-xs font-medium text-muted-foreground">
                    介绍
                </div>
                <RichModDesc :source="descSource" compact />
                <p v-if="onlineLoading" class="text-xs text-muted-foreground">正在加载在线介绍…</p>
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
<!-- 介绍样式已收敛至公共组件 RichModDesc -->
