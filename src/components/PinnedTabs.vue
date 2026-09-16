<script setup lang="ts">
import { computed, defineAsyncComponent, inject, ref, watch, type Ref } from "vue";
import { useRoute } from "vue-router";
import { LayoutGrid, Pin, PinOff } from "lucide-vue-next";
import { PINNABLE_TABS, type INavItem } from "@/lib/nav-items";
import { useSettings } from "@/stores/settings";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";

// 顶部图标点击不再跳路由：就地弹大框，直接渲染对应页面组件。
// 异步引入避免首屏打包全部页面；unknown 路径回退空态。
const PAGE_COMPONENTS: Record<string, unknown> = {
    "/": defineAsyncComponent(() => import("@/pages/index.vue")),
    "/games": defineAsyncComponent(() => import("@/pages/games.vue")),
    "/manager": defineAsyncComponent(() => import("@/pages/manager.vue")),
    "/explore": defineAsyncComponent(() => import("@/pages/explore.vue")),
    "/download": defineAsyncComponent(() => import("@/pages/download.vue")),
    "/mcp": defineAsyncComponent(() => import("@/pages/mcp.vue")),
    "/backup": defineAsyncComponent(() => import("@/pages/backup.vue")),
    "/ai-chat": defineAsyncComponent(() => import("@/pages/ai-chat.vue")),
    "/about": defineAsyncComponent(() => import("@/pages/about.vue")),
    "/settings": defineAsyncComponent(() => import("@/pages/settings.vue")),
};

const route = useRoute();
const settings = useSettings();

// 选择器浮窗开关；内容 popup 每图标独立 open 状态。
const pickerOpen = ref(false);
const activePopupPath = ref<string | null>(null);
// 主页面遮罩由 Layout 提供：popup 打开时只压暗内容区。
const pinnedPopupOpen = inject<Ref<boolean>>("pinnedPopupOpen", ref(false));
watch(activePopupPath, (path) => {
    pinnedPopupOpen.value = path !== null;
});

const pinnedItems = computed<INavItem[]>(() => {
    const order = new Map(
        settings.pinnedTabs.map((path, index) => [path, index]),
    );

    return PINNABLE_TABS.filter((item) => order.has(item.path)).sort(
        (a: INavItem, b: INavItem) =>
            (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0),
    );
});

const isPinned = (path: string) => settings.pinnedTabs.includes(path);

function togglePin(path: string) {
    const next = settings.pinnedTabs.filter((item) => item !== path);

    if (!isPinned(path)) {
        next.push(path);
    }
    settings.pinnedTabs = next;
}
// 内层 Dialog/Dropdown/Select 全 portal 到 body，点击它们会触发外层
// Popover 的 outside-close。有 overlay 存活时拦下关闭事件，popup 保持打开。
function guardPopupOutside(event: Event) {
    const target = event.target as HTMLElement | null;
    if (
        target?.closest(
            '[data-slot="dialog-overlay"], [data-slot="dialog-content"], [data-slot="dropdown-menu-content"], [data-slot="select-content"], [data-slot="popover-content"]',
        )
    ) {
        event.preventDefault();
    }
}
</script>

<template>
    <div class="flex items-center gap-1">
        <!-- 已置顶 tab：点击弹大框，不跳路由 -->
        <Popover
            v-for="item in pinnedItems"
            :key="item.path"
            :open="activePopupPath === item.path"
            @update:open="
                (open: boolean) =>
                    (activePopupPath = open ? item.path : null)
            "
        >
            <div>
                <PopoverTrigger as-child>
                    <Button
                        variant="ghost"
                        size="icon"
                        class="h-7 w-7"
                        :class="
                            cn(
                                (route.path === item.path ||
                                    activePopupPath === item.path) &&
                                    'bg-accent text-accent-foreground',
                            )
                        "
                        :title="$t(item.labelKey)"
                    >
                        <component :is="item.icon" class="h-4 w-4" />
                    </Button>
                </PopoverTrigger>
            </div>
            <!-- popup 自带毛玻璃 + 柔影，遮罩只压主页面（见 Layout） -->
            <PopoverContent
                align="center"
                side="bottom"
                :side-offset="12"
                class="page-popup z-50 h-[62vh] max-h-[calc(100vh-6rem)] w-[min(52vw,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] overflow-auto rounded-2xl border-white/20 bg-white/75 p-3 shadow-[0_32px_80px_-16px_rgba(0,0,0,0.35)] backdrop-blur-2xl sm:p-5 dark:border-white/10 dark:bg-neutral-900/70 dark:shadow-[0_32px_80px_-16px_rgba(0,0,0,0.7)]"
                @pointer-down-outside="guardPopupOutside"
                @interact-outside="guardPopupOutside"
            >
                <component
                    :is="PAGE_COMPONENTS[item.path]"
                    v-if="activePopupPath === item.path"
                />
            </PopoverContent>
        </Popover>

        <!-- 入口按钮：打开浮窗选择要置顶的 tab -->
        <Button
            variant="ghost"
            size="icon"
            class="h-7 w-7 text-muted-foreground"
            :title="$t('nav.pinTabs')"
            @click="pickerOpen = true"
        >
            <LayoutGrid class="h-4 w-4" />
        </Button>

        <Dialog v-model:open="pickerOpen">
            <DialogContent class="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{{ $t("nav.pinTabs") }}</DialogTitle>
                </DialogHeader>
                <div class="flex flex-col gap-1">
                    <button
                        v-for="item in PINNABLE_TABS"
                        :key="item.path"
                        class="flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent/50"
                        @click="togglePin(item.path)"
                    >
                        <component
                            :is="item.icon"
                            class="h-4 w-4 shrink-0 text-muted-foreground"
                        />
                        <span class="flex-1 text-left">{{
                            $t(item.labelKey)
                        }}</span>
                        <Pin
                            v-if="isPinned(item.path)"
                            class="h-4 w-4 text-primary"
                        />
                        <PinOff
                            v-else
                            class="h-4 w-4 text-muted-foreground/40"
                        />
                    </button>
                </div>
            </DialogContent>
        </Dialog>
    </div>
</template>
 <style>
 /* popup 内容 portal 到 body，scoped :deep 够不着，放全局 */
 .page-popup {
     container-type: inline-size;
 }
 .page-popup .mx-auto {
     max-width: none;
 }
 /* ai-chat：视口定高在小框内会撑爆，改为框内自适应 */
 .page-popup .h-\[calc\(100vh-3rem\)\] {
     height: auto;
     min-height: 50vh;
 }
 /* manager 宽表：允许横滚，不把 popup 撑爆 */
 .page-popup table {
     min-width: 640px;
 }
 /* popup 窄框：多列网格统一收成 2 列 / 单列 */
 .page-popup .grid-cols-4,
 .page-popup .sm\:grid-cols-3,
 .page-popup .xl\:grid-cols-4 {
     grid-template-columns: repeat(2, minmax(0, 1fr));
 }
 .page-popup .grid-cols-3,
 .page-popup .sm\:grid-cols-2,
 .page-popup .md\:grid-cols-2,
 .page-popup .lg\:grid-cols-3,
 .page-popup .lg\:grid-cols-\[minmax\(0\,1fr\)_minmax\(0\,0\.85fr\)\],
 .page-popup .lg\:grid-cols-\[minmax\(0\,0\.85fr\)_minmax\(0\,1\.15fr\)\],
 .page-popup .xl\:grid-cols-\[minmax\(0\,1fr\)_22rem\],
 .page-popup .xl\:grid-cols-\[minmax\(0\,1\.1fr\)_minmax\(0\,0\.9fr\)\] {
     grid-template-columns: minmax(0, 1fr);
 }
 /* popup 窄框：横向 flex 行改纵排 */
 .page-popup .lg\:flex-row {
     flex-direction: column;
     align-items: stretch;
 }
 /* popup 窄框：输入组不撑宽，input 可收缩 */
 .page-popup [data-slot="input-group"] {
     min-width: 0;
     max-width: 100%;
 }
 .page-popup [data-slot="input-group-control"] {
     min-width: 0;
     width: 0;
     flex: 1 1 0;
 }
 </style>
