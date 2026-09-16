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
                align="start"
                side="bottom"
                :side-offset="12"
                class="z-50 h-[62vh] w-[52vw] min-w-105 overflow-auto rounded-2xl border-white/20 bg-white/75 p-5 shadow-[0_32px_80px_-16px_rgba(0,0,0,0.35)] backdrop-blur-2xl dark:border-white/10 dark:bg-neutral-900/70 dark:shadow-[0_32px_80px_-16px_rgba(0,0,0,0.7)]"
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
