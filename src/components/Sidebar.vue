<script setup lang="ts">
import { useRoute } from "vue-router";
import { Pin, PinOff } from "lucide-vue-next";
import { NAV_BOTTOM_ITEMS, NAV_ITEMS } from "@/lib/nav-items";
import { useSettings } from "@/stores/settings";
import { cn } from "@/lib/utils";

const route = useRoute();
const settings = useSettings();

const isPinned = (path: string) => settings.pinnedTabs.includes(path);

function togglePin(path: string) {
    const next = settings.pinnedTabs.filter((item) => item !== path);

    if (!isPinned(path)) {
        next.push(path);
    }

    settings.pinnedTabs = next;
}

function linkClass(active: boolean) {
    return cn(
        "group flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors relative overflow-hidden",
        active
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
    );
}
</script>

<template>
    <aside
        class="flex w-16 md:w-40 flex-col border-r border-border bg-sidebar/50 backdrop-blur-xl transition-all duration-300"
    >
        <div class="flex-1 overflow-auto py-4 flex flex-col gap-1 px-3">
            <div
                v-for="item in NAV_ITEMS"
                :key="item.path"
                class="group/item relative"
            >
                <router-link
                    :to="item.path"
                    :class="linkClass(route.path === item.path)"
                    @contextmenu.prevent="togglePin(item.path)"
                >
                    <component :is="item.icon" class="h-5 w-5 shrink-0" />
                    <span class="hidden md:inline-block">{{
                        $t(item.labelKey)
                    }}</span>

                    <div
                        v-if="route.path === item.path"
                        class="absolute left-0 top-1/2 h-1/2 w-1 -translate-y-1/2 rounded-r-full bg-primary"
                    />
                </router-link>
                <!-- hover 出现置顶钮；右键同样可切换 -->
                <button
                    class="absolute right-1 top-1/2 hidden h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/60 hover:bg-accent hover:text-foreground group-hover/item:flex"
                    :title="$t(isPinned(item.path) ? 'nav.unpin' : 'nav.pin')"
                    @click="togglePin(item.path)"
                >
                    <PinOff v-if="isPinned(item.path)" class="h-3.5 w-3.5" />
                    <Pin v-else class="h-3.5 w-3.5" />
                </button>
            </div>
        </div>

        <div class="p-3 border-t border-border/50">
            <div
                v-for="item in NAV_BOTTOM_ITEMS"
                :key="item.path"
                class="group/item relative"
            >
                <router-link
                    :to="item.path"
                    :class="linkClass(route.path === item.path)"
                    @contextmenu.prevent="togglePin(item.path)"
                >
                    <component :is="item.icon" class="h-5 w-5 shrink-0" />
                    <span class="hidden md:inline-block">{{
                        $t(item.labelKey)
                    }}</span>
                </router-link>
                <button
                    class="absolute right-1 top-1/2 hidden h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/60 hover:bg-accent hover:text-foreground group-hover/item:flex"
                    :title="$t(isPinned(item.path) ? 'nav.unpin' : 'nav.pin')"
                    @click="togglePin(item.path)"
                >
                    <PinOff v-if="isPinned(item.path)" class="h-3.5 w-3.5" />
                    <Pin v-else class="h-3.5 w-3.5" />
                </button>
            </div>
        </div>
    </aside>
</template>
