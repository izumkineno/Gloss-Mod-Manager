<script setup lang="ts">
import { fetch as httpFetch } from "@tauri-apps/plugin-http";
import { ElMessage } from "element-plus-message";
import {
    hasGlossMultipleResources,
    queueGlossModDownloadWithSelection,
} from "@/features/download/view/file-selection";
import { resolveGlossModKey } from "@/lib/gloss-mod-api";
import RichModDesc from "@/components/common/RichModDesc.vue";

const GLOSS_MOD_API_BASE_URL = "https://mod.3dmgame.com/api/v3";
const GLOSS_MOD_WEB_BASE_URL = "https://mod.3dmgame.com";
const EMPTY_POSTER =
    "data:image/svg+xml;charset=UTF-8," +
    encodeURIComponent(`
		<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600" viewBox="0 0 960 600">
			<rect width="960" height="600" fill="#e7e7e7" />
			<g fill="none" stroke="#b4b4b4" stroke-width="12" stroke-linecap="round" stroke-linejoin="round">
				<rect x="396" y="240" width="168" height="132" rx="14" />
				<path d="M396 333l45-39 39 33 45-42 39 33" />
			</g>
			<circle cx="450" cy="282" r="13" fill="#b4b4b4" />
		</svg>
	`);
const numberFormatter = new Intl.NumberFormat("zh-CN");
const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
});

interface IGlossApiResponse<T> {
    success: boolean;
    msg: string;
    data: T | null;
}

const route = useRoute();
const router = useRouter();
const manager = useManager();
const settings = useSettings();

const modDetail = ref<IMod | null>(null);
const loading = ref(false);
const errorMessage = ref("");
const queueingResourceKey = ref("");

let requestSequence = 0;


const routeModId = computed(() => {
    const { params } = route;

    if (!("id" in params)) {
        return "";
    }

    const rawId = Array.isArray(params.id) ? params.id[0] : params.id;
    const normalized = String(rawId ?? "").trim();

    return /^\d+$/u.test(normalized) ? normalized : "";
});

const latestResource = computed(
    () =>
        modDetail.value?.mods_resource.find(
            (resource) => resource.mods_resource_latest_version,
        ) ??
        modDetail.value?.mods_resource[0] ??
        null,
);
const coverImages = computed(() => {
    const imageList = [
        modDetail.value?.mods_image_url,
        ...(modDetail.value?.mods_images_url ?? []),
    ]
        .map((item) => resolveAssetUrl(item))
        .filter(Boolean);

    return [...new Set(imageList)].slice(0, 6);
});
const markdownSource = computed(() => {
    const summary = normalizeMarkdownSource(modDetail.value?.mods_desc);
    const detail = normalizeMarkdownSource(modDetail.value?.mods_content);

    if (summary && detail && summary === detail) {
        return detail;
    }

    return [summary, detail].filter(Boolean).join("\n\n");
});

watch(
    routeModId,
    (modId) => {
        void loadModDetail(modId);
    },
    { immediate: true },
);

function normalizeMarkdownSource(value?: string) {
    return (value ?? "").replace(/\r\n?/gu, "\n").trim();
}

function resolveAssetUrl(path?: string) {
    if (!path) {
        return "";
    }

    if (/^https?:\/\//u.test(path)) {
        return path;
    }

    const normalized = path.startsWith("/") ? path : `/${path}`;

    return `${GLOSS_MOD_WEB_BASE_URL}${normalized}`;
}

function formatDate(value?: string) {
    if (!value) {
        return "未知时间";
    }

    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
        return value;
    }

    return dateFormatter.format(parsed);
}

function formatNumber(value?: string | number) {
    const normalized = Number(value ?? 0);

    return numberFormatter.format(Number.isFinite(normalized) ? normalized : 0);
}

function getErrorMessage(error: unknown) {
    if (error instanceof Error && error.message.trim()) {
        return error.message;
    }

    return "读取 Mod 详情失败，请稍后重试。";
}

async function loadModDetail(modId: string) {
    if (!modId) {
        modDetail.value = null;
        errorMessage.value = "当前详情页缺少有效的 Mod ID。";
        return;
    }

    const effectiveKey = resolveGlossModKey(settings.glossModKey);
    if (!effectiveKey) {
        modDetail.value = null;
        errorMessage.value = "未填写 3DM Mods Key，请前往设置页填写。";
        return;
    }

    const currentRequestSequence = ++requestSequence;
    loading.value = true;
    errorMessage.value = "";

    try {
        const response = await httpFetch(
            `${GLOSS_MOD_API_BASE_URL}/mods/${modId}`,
            {
                method: "GET",
                headers: {
                    Accept: "application/json",
                    Authorization: effectiveKey,
                },
            },
        );
        const payload = (await response.json()) as IGlossApiResponse<IMod>;

        if (currentRequestSequence !== requestSequence) {
            return;
        }

        if (!response.ok || !payload.success || !payload.data) {
            throw new Error(payload.msg || "读取 Mod 详情失败");
        }

        modDetail.value = payload.data;
    } catch (error: unknown) {
        if (currentRequestSequence !== requestSequence) {
            return;
        }

        modDetail.value = null;
        errorMessage.value = getErrorMessage(error);
    } finally {
        if (currentRequestSequence === requestSequence) {
            loading.value = false;
        }
    }
}

async function openDownloadPage() {
    // 不再自动跳转建任务：下载页不再消费 modId/resourceId/autoDownload 参数，
    // 这里只做路由跳转，用户到下载页自行操作。
    try {
        await router.push({ path: "/download" });
    } catch (error: unknown) {
        console.error(error);
        ElMessage.error("打开下载页失败。");
    }
}

function getResourceQueueKey(resource?: IResource | null) {
    if (!resource) {
        return "";
    }

    return String(resource.id ?? resource.mods_resource_name);
}

function isQueueingResource(resource?: IResource | null) {
    return (
        Boolean(resource) &&
        queueingResourceKey.value === getResourceQueueKey(resource)
    );
}

function getPrimaryDownloadButtonLabel() {
    if (isQueueingResource(latestResource.value)) {
        return "加入中...";
    }

    if (!latestResource.value) {
        return "暂无资源";
    }

    return hasGlossMultipleResources(modDetail.value)
        ? "选择资源下载"
        : "下载最新资源";
}

async function downloadResource(resource?: IResource | null) {
    if (!modDetail.value) {
        ElMessage.warning("当前没有可用的 Mod 详情。");
        return;
    }

    if (!resource) {
        ElMessage.warning("当前资源不存在或不可下载。");
        return;
    }

    const queueKey = getResourceQueueKey(resource);
    queueingResourceKey.value = queueKey;

    try {
        const shouldPromptSelection =
            hasGlossMultipleResources(modDetail.value) &&
            resource.id === latestResource.value?.id;
        const result = await queueGlossModDownloadWithSelection({
            mod: modDetail.value,
            resourceId: shouldPromptSelection ? undefined : resource.id,
            managerModList: manager.managerModList,
            apiKey: settings.glossModKey,
        });

        if (!result) {
            ElMessage.info("已取消选择下载资源。");
            return;
        }

        if (
            result.status === "created" ||
            result.status === "resumed" ||
            result.status === "retried"
        ) {
            ElMessage.success(result.message);
            return;
        }

        ElMessage.info(result.message);
    } catch (error: unknown) {
        console.error(error);
        ElMessage.error(
            error instanceof Error ? error.message : "提交下载任务失败。",
        );
    } finally {
        if (queueingResourceKey.value === queueKey) {
            queueingResourceKey.value = "";
        }
    }
}

async function goBackToExplore() {
    try {
        const returnTo = Array.isArray(route.query.returnTo)
            ? route.query.returnTo[0]
            : route.query.returnTo;
        const target =
            typeof returnTo === "string" && returnTo.startsWith("/explore")
                ? returnTo
                : "/explore";

        await router.push(target);
    } catch (error: unknown) {
        console.error(error);
        ElMessage.error("返回游览页失败。");
    }
}
</script>

<template>
    <div class="mx-auto w-full max-w-[1400px] space-y-6">
        <div class="flex items-center gap-2">
            <Button variant="ghost" size="sm" @click="goBackToExplore">
                <IconArrowLeft class="size-4" />
                返回游览
            </Button>
        </div>

        <div v-if="loading" class="space-y-6">
            <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
                <div class="space-y-4">
                    <div class="h-4 w-40 animate-pulse rounded bg-muted"></div>
                    <div class="h-9 w-3/4 animate-pulse rounded bg-muted"></div>
                    <div class="h-4 w-full animate-pulse rounded bg-muted"></div>
                    <div class="h-4 w-4/5 animate-pulse rounded bg-muted"></div>
                    <div class="flex gap-6 pt-2">
                        <div
                            v-for="item in 4"
                            :key="item"
                            class="h-12 w-20 animate-pulse rounded bg-muted"
                        ></div>
                    </div>
                </div>
                <div class="aspect-16/10 animate-pulse rounded-xl bg-muted"></div>
            </div>
        </div>

        <div
            v-else-if="errorMessage"
            class="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-6"
        >
            <IconCircleAlert class="mt-0.5 size-5 shrink-0 text-destructive" />
            <div class="space-y-1">
                <div class="text-sm font-medium">加载失败</div>
                <p class="text-sm text-muted-foreground">{{ errorMessage }}</p>
            </div>
        </div>

        <div
            v-else-if="!modDetail"
            class="flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-16 text-center"
        >
            <div
                class="flex size-11 items-center justify-center rounded-full bg-muted"
            >
                <IconInbox class="size-5 text-muted-foreground" />
            </div>
            <p class="mt-4 text-sm text-muted-foreground">
                当前没有可展示的 Mod 详情。
            </p>
        </div>

        <template v-else>
            <section
                class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]"
            >
                <div class="flex flex-col gap-5">
                    <div class="space-y-3">
                        <div
                            class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
                        >
                            <span>{{ modDetail.game_name }}</span>
                            <span aria-hidden="true">·</span>
                            <span>{{ modDetail.mods_type_name || "未分类" }}</span>
                            <span aria-hidden="true">·</span>
                            <span>
                                更新于 {{ formatDate(modDetail.mods_updateTime) }}
                            </span>
                            <Badge
                                v-if="modDetail.support_gmm"
                                variant="secondary"
                                class="rounded-md font-normal"
                            >
                                支持 GMM
                            </Badge>
                        </div>

                        <h1
                            class="text-2xl leading-tight font-semibold tracking-tight lg:text-3xl"
                        >
                            {{ modDetail.mods_title }}
                        </h1>

                        <p
                            v-if="modDetail.mods_desc"
                            class="max-w-2xl text-sm leading-6 text-muted-foreground"
                        >
                            {{ modDetail.mods_desc }}
                        </p>
                    </div>

                    <dl class="flex flex-wrap gap-x-8 gap-y-3">
                        <div class="space-y-0.5">
                            <dt class="text-xs text-muted-foreground">下载</dt>
                            <dd class="text-lg font-semibold tabular-nums">
                                {{ formatNumber(modDetail.mods_download_cnt) }}
                            </dd>
                        </div>
                        <div class="space-y-0.5">
                            <dt class="text-xs text-muted-foreground">浏览</dt>
                            <dd class="text-lg font-semibold tabular-nums">
                                {{ formatNumber(modDetail.mods_click_cnt) }}
                            </dd>
                        </div>
                        <div class="space-y-0.5">
                            <dt class="text-xs text-muted-foreground">收藏</dt>
                            <dd class="text-lg font-semibold tabular-nums">
                                {{ formatNumber(modDetail.mods_mark_cnt) }}
                            </dd>
                        </div>
                        <div class="space-y-0.5">
                            <dt class="text-xs text-muted-foreground">资源数</dt>
                            <dd class="text-lg font-semibold tabular-nums">
                                {{ modDetail.mods_resource.length }}
                            </dd>
                        </div>
                    </dl>

                    <div
                        class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
                    >
                        <span>
                            作者
                            <span class="text-foreground">
                                {{
                                    modDetail.user_nickName ||
                                    modDetail.mods_author ||
                                    "未知"
                                }}
                            </span>
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>
                            版本
                            <span class="text-foreground">
                                {{
                                    modDetail.mods_version ||
                                    latestResource?.mods_resource_version ||
                                    "未知"
                                }}
                            </span>
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>
                            发布于
                            <span class="text-foreground">
                                {{ formatDate(modDetail.mods_createTime) }}
                            </span>
                        </span>
                    </div>

                    <div class="mt-auto flex flex-wrap gap-2 pt-1">
                        <Button
                            v-if="latestResource"
                            :disabled="isQueueingResource(latestResource)"
                            @click="downloadResource(latestResource)"
                        >
                            <IconDownload class="size-4" />
                            {{ getPrimaryDownloadButtonLabel() }}
                        </Button>
                        <Button variant="outline" @click="openDownloadPage()">
                            <IconPanelRightOpen class="size-4" />
                            前往下载页
                        </Button>
                    </div>
                </div>

                <div class="space-y-3">
                    <div class="overflow-hidden rounded-xl border bg-muted">
                        <img
                            :src="coverImages[0] || EMPTY_POSTER"
                            :alt="modDetail.mods_title || 'Gloss Mod Detail'"
                            class="aspect-16/10 w-full object-cover"
                            @error="
                                (event) =>
                                    ((event.target as HTMLImageElement).src =
                                        EMPTY_POSTER)
                            "
                        />
                    </div>

                    <div
                        v-if="coverImages.length > 1"
                        class="grid grid-cols-3 gap-2 sm:grid-cols-4"
                    >
                        <div
                            v-for="(item, index) in coverImages.slice(1, 9)"
                            :key="`${item}-${index}`"
                            class="overflow-hidden rounded-lg border bg-muted"
                        >
                            <img
                                :src="item"
                                :alt="`${modDetail.mods_title || 'Gloss Mod'}-${index + 1}`"
                                loading="lazy"
                                class="aspect-16/10 w-full object-cover"
                                @error="
                                    (event) =>
                                        ((
                                            event.target as HTMLImageElement
                                        ).src = EMPTY_POSTER)
                                "
                            />
                        </div>
                    </div>
                </div>
            </section>

            <Separator />

            <section class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
                <div class="min-w-0 space-y-4">
                    <h2 class="text-sm font-medium">详细介绍</h2>
                    <RichModDesc :source="markdownSource" />
                </div>

                <div class="space-y-6">
                    <div class="space-y-3">
                        <div class="space-y-1">
                            <h2 class="text-sm font-medium">资源列表</h2>
                            <p class="text-xs leading-5 text-muted-foreground">
                                可以直接跳转下载页，或一键加入最新资源的下载任务。
                            </p>
                        </div>

                        <div class="divide-y rounded-xl border">
                            <div
                                v-for="resource in modDetail.mods_resource"
                                :key="resource.id"
                                class="space-y-2.5 p-4"
                            >
                                <div class="flex items-start gap-2">
                                    <div
                                        class="min-w-0 flex-1 text-sm font-medium"
                                    >
                                        {{ resource.mods_resource_name }}
                                    </div>
                                    <Badge
                                        v-if="resource.mods_resource_latest_version"
                                        variant="secondary"
                                        class="shrink-0 rounded-md font-normal"
                                    >
                                        最新
                                    </Badge>
                                </div>

                                <div
                                    class="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground"
                                >
                                    <span>
                                        {{
                                            resource.mods_resource_size || "未知"
                                        }}
                                    </span>
                                    <span aria-hidden="true">·</span>
                                    <span>
                                        {{
                                            resource.mods_resource_version ||
                                            modDetail.mods_version ||
                                            "未知"
                                        }}
                                    </span>
                                    <template
                                        v-if="resource.mods_resource_createTime"
                                    >
                                        <span aria-hidden="true">·</span>
                                        <span>
                                            {{
                                                formatDate(
                                                    resource.mods_resource_createTime,
                                                )
                                            }}
                                        </span>
                                    </template>
                                </div>

                                <p
                                    v-if="resource.mods_resource_desc"
                                    class="text-xs leading-5 text-muted-foreground"
                                >
                                    {{ resource.mods_resource_desc }}
                                </p>

                                <div class="flex flex-wrap gap-2 pt-0.5">
                                    <Button
                                        size="sm"
                                        :disabled="isQueueingResource(resource)"
                                        @click="downloadResource(resource)"
                                    >
                                        <IconDownload class="size-4" />
                                        {{
                                            isQueueingResource(resource)
                                                ? "加入中..."
                                                : "立即下载"
                                        }}
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        @click="openDownloadPage()"
                                    >
                                        <IconPanelRightOpen class="size-4" />
                                        下载页
                                    </Button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="space-y-3">
                        <h2 class="text-sm font-medium">附加信息</h2>
                        <dl class="space-y-2.5 text-sm">
                            <div class="flex items-start justify-between gap-4">
                                <dt class="text-muted-foreground">Mod ID</dt>
                                <dd class="text-right tabular-nums">
                                    {{ modDetail.id }}
                                </dd>
                            </div>
                            <div class="flex items-start justify-between gap-4">
                                <dt class="text-muted-foreground">作者</dt>
                                <dd class="text-right">
                                    {{
                                        modDetail.user_nickName ||
                                        modDetail.mods_author ||
                                        "未知"
                                    }}
                                </dd>
                            </div>
                            <div class="flex items-start justify-between gap-4">
                                <dt class="text-muted-foreground">创建时间</dt>
                                <dd class="text-right">
                                    {{ formatDate(modDetail.mods_createTime) }}
                                </dd>
                            </div>
                            <div class="flex items-start justify-between gap-4">
                                <dt class="text-muted-foreground">更新时间</dt>
                                <dd class="text-right">
                                    {{ formatDate(modDetail.mods_updateTime) }}
                                </dd>
                            </div>
                        </dl>
                    </div>
                </div>
            </section>
        </template>
    </div>
</template>

