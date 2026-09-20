<script setup lang="ts">
// 主页:三站 Mod 趋势(按下载量 Top 10),复用探索页同一列表接口。
// 游戏取 manager.managerGame(持久化注水,天然就是上次关闭前选择的)。
import { onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { Flame, LoaderCircle } from "lucide-vue-next";
import {
    fetchThirdPartyMods,
    isThirdPartyProviderSupported,
    type IThirdPartyModItem,
    type ThirdPartyProvider,
} from "@/lib/third-party-mod-api";

const manager = useManager();
const settings = useSettings();
const router = useRouter();
const { t } = useI18n();

// 3dm 无公开列表 API,只做三站。
const providers: ThirdPartyProvider[] = [
    "NexusMods",
    "Thunderstore",
    "ModIo",
];
const activeProvider = ref<ThirdPartyProvider>("NexusMods");
const items = ref<IThirdPartyModItem[]>([]);
const loading = ref(false);
const errorMessage = ref("");
// 筛选:时间范围 + 排序口径。API 无周增量,近一周 = 拉 100 条按下载排序后客户端按 updatedAt 过滤。
const rangeOptions = ["week", "all"] as const;
type RangeOption = (typeof rangeOptions)[number];
const sortOptions = ["downloads", "updatedAt"] as const;
type SortOption = (typeof sortOptions)[number];
const activeRange = ref<RangeOption>("week");
const activeSort = ref<SortOption>("downloads");
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// 当前游戏是否支持该站,不支持则 Tab 禁用。
function isSupported(provider: ThirdPartyProvider) {
    return isThirdPartyProviderSupported(manager.managerGame, provider);
}

async function fetchTrending() {
    const game = manager.managerGame;
    if (!game) {
        items.value = [];
        errorMessage.value = t("explore.messages.selectGameFirst");
        return;
    }
    if (!isSupported(activeProvider.value)) {
        items.value = [];
        errorMessage.value = t("explore.thirdParty.providerUnsupported", {
            provider: activeProvider.value,
        });
        return;
    }
    loading.value = true;
    errorMessage.value = "";
    try {
        const result = await fetchThirdPartyMods(
            activeProvider.value,
            game,
            { page: 1, pageSize: 100, searchText: "", sort: "downloads" },
            settings.nexusModsUser,
        );
        let list = result.items;
        if (activeRange.value === "week") {
            const cutoff = Date.now() - WEEK_MS;
            list = list.filter((item) => {
                const ts = Date.parse(item.updatedAt ?? "");
                return Number.isFinite(ts) && ts >= cutoff;
            });
        }
        if (activeSort.value === "updatedAt") {
            list = [...list].sort(
                (a, b) =>
                    Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""),
            );
        }
        items.value = list.slice(0, 10);
    } catch (error: unknown) {
        items.value = [];
        errorMessage.value =
            error instanceof Error
                ? error.message
                : t("explore.thirdParty.fetchFailed", {
                      provider: activeProvider.value,
                  });
    } finally {
        loading.value = false;
    }
}

// 点击卡片跳探索页对应站点,详情/下载走原流程。
function openInExplore(item: IThirdPartyModItem) {
    void router.push({
        path: "/explore",
        query: {
            provider: item.source,
            tpSearch: item.title,
        },
    });
}

function formatCount(n: number) {
    if (n >= 10000) return `${(n / 10000).toFixed(1)}w`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
}

watch(activeProvider, () => void fetchTrending());
watch([activeRange, activeSort], () => void fetchTrending());
// managerGame 由持久化异步注水,首帧为 null,等注水完成再拉。
watch(
    () => manager.managerGame,
    () => void fetchTrending(),
);
onMounted(() => {
    // 主页挂载即预热水合：Nexus API key + Cookie，collection/探索页首次建任务不再撞空读。
    void import("@/lib/secret-store").then(({ SecretStore }) => {
        SecretStore.prewarm();
        void SecretStore.ready("nexusModsToken", "nexusModsCookie");
    });
    void fetchTrending();
});
</script>
<template>
    <div class="mx-auto w-full max-w-[1560px] space-y-6">
        <header class="flex flex-wrap items-center gap-x-4 gap-y-3">
            <div class="space-y-1">
                <h1
                    class="flex items-center gap-2 text-xl font-semibold tracking-tight"
                >
                    <Flame class="size-5 text-orange-500" />
                    {{ $t("home.trending.title") }}
                </h1>
                <p class="text-sm text-muted-foreground">
                    {{ $t("home.trending.subtitle") }}
                </p>
            </div>
        </header>

        <nav
            class="-mx-1 flex items-center gap-1 overflow-x-auto px-1 pb-1 no-scrollbar"
        >
            <button
                v-for="provider in providers"
                :key="provider"
                type="button"
                :disabled="!isSupported(provider)"
                class="relative shrink-0 cursor-pointer rounded-full px-3.5 py-1.5 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-40"
                :class="
                    activeProvider === provider
                        ? 'bg-foreground text-background'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                "
                @click="activeProvider = provider"
            >
                {{ provider }}
            </button>
        </nav>

        <div class="flex flex-wrap items-center gap-2">
            <div class="flex items-center gap-1 rounded-full border p-1">
                <button
                    v-for="range in rangeOptions"
                    :key="range"
                    type="button"
                    class="cursor-pointer rounded-full px-3 py-1 text-xs font-medium transition-colors"
                    :class="
                        activeRange === range
                            ? 'bg-foreground text-background'
                            : 'text-muted-foreground hover:text-foreground'
                    "
                    @click="activeRange = range"
                >
                    {{ $t(`home.trending.range.${range}`) }}
                </button>
            </div>
            <div class="flex items-center gap-1 rounded-full border p-1">
                <button
                    v-for="sort in sortOptions"
                    :key="sort"
                    type="button"
                    class="cursor-pointer rounded-full px-3 py-1 text-xs font-medium transition-colors"
                    :class="
                        activeSort === sort
                            ? 'bg-foreground text-background'
                            : 'text-muted-foreground hover:text-foreground'
                    "
                    @click="activeSort = sort"
                >
                    {{ $t(`home.trending.sort.${sort}`) }}
                </button>
            </div>
        </div>

        <div
            v-if="loading"
            class="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
        >
            <LoaderCircle class="size-5 animate-spin" />
            {{ $t("explore.common.loadingTypes") }}
        </div>
        <div
            v-else-if="errorMessage"
            class="rounded-xl border border-dashed py-16 text-center text-sm text-muted-foreground"
        >
            {{ errorMessage }}
        </div>
        <div
            v-else
            class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5"
        >
            <Card
                v-for="(item, index) in items"
                :key="`${item.source}-${item.id}`"
                class="cursor-pointer overflow-hidden transition-transform hover:scale-[1.02]"
                @click="openInExplore(item)"
            >
                <div class="relative aspect-16/10 w-full overflow-hidden bg-muted">
                    <img
                        v-if="item.cover"
                        :src="item.cover"
                        :alt="item.title"
                        class="h-full w-full object-cover"
                        loading="lazy"
                    />
                    <span
                        class="absolute top-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-xs font-semibold text-white"
                    >
                        #{{ index + 1 }}
                    </span>
                </div>
                <CardContent class="space-y-1 p-3">
                    <div class="truncate text-sm font-medium" :title="item.title">
                        {{ item.title }}
                    </div>
                    <div class="flex items-center justify-between text-xs text-muted-foreground">
                        <span class="truncate">{{ item.author }}</span>
                        <span class="flex shrink-0 items-center gap-1">
                            <IconDownload class="size-3.5" />
                            {{ formatCount(item.downloads) }}
                        </span>
                    </div>
                </CardContent>
            </Card>
        </div>
    </div>
</template>
<style scoped></style>
