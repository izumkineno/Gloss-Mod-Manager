// Mod 查找与详情展示（Wave 3.6 机械抽取）：ID 解析/详情加载/资源地址/详情文本。
// 与 download.vue 原实现逐行一致，只挪位置；不改行为、不改视觉。
import { computed, ref } from "vue";
import { fetch as httpFetch } from "@tauri-apps/plugin-http";
import { resolveGlossModKey } from "@/lib/gloss-mod-api";
import { getErrorMessage } from "./task-display";
import { GLOSS_MOD_API_BASE_URL, resolveGlossAssetUrl } from "./resource-task";

// Mod ID 解析：纯数字直返，否则从链接/文本中提取 mod/数字 或 3 位以上数字。
export function extractModId(input: string): string {
    const trimmed = input.trim();

    if (!trimmed) {
        return "";
    }

    if (/^\d+$/u.test(trimmed)) {
        return trimmed;
    }

    const match = trimmed.match(/mod\/(\d+)|(?:^|\D)(\d{3,})(?:\D|$)/u);

    return match?.[1] ?? match?.[2] ?? "";
}

// 富文本详情转段落：br 换行、去标签、压空白、过滤空段。
export function formatDetailText(value?: string): string[] {
    if (!value) {
        return [];
    }

    return value
        .replace(/<br\s*\/?>/giu, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/\r+/g, "\n")
        .split(/\n+/)
        .map((item) => item.replace(/\s+/g, " ").trim())
        .filter(Boolean);
}

export interface ModLookupDeps {
    glossModKey: string;
}

// Mod 查找 composable：输入/加载/错误/选中 Mod/详情段落（含竞态序号）。
export function useModLookup(deps: ModLookupDeps) {
    const modLookupInput = ref("");
    const modLookupLoading = ref(false);
    const modLookupError = ref("");
    const selectedMod = ref<IMod | null>(null);

    let detailSequence = 0;

    const detailParagraphs = computed(() =>
        formatDetailText(
            selectedMod.value?.mods_content || selectedMod.value?.mods_desc,
        ),
    );

    // Mod 详情加载：序号防竞态，失败置错误文案。
    async function loadModDetail(explicitModId?: string): Promise<IMod | null> {
        const modId = explicitModId ?? extractModId(modLookupInput.value);
        if (!modId) {
            modLookupError.value = "请输入有效的 3DM Mod ID 或详情链接。";
            selectedMod.value = null;
            return null;
        }

        const effectiveKey = resolveGlossModKey(deps.glossModKey);
        if (!effectiveKey) {
            modLookupError.value = "未填写 3DM Mods Key，请前往设置页填写。";
            selectedMod.value = null;
            return null;
        }

        const currentSequence = ++detailSequence;
        modLookupLoading.value = true;
        modLookupError.value = "";

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
            interface IGlossApiResponse<T> {
                success: boolean;
                msg: string;
                data: T | null;
            }
            const payload = (await response.json()) as IGlossApiResponse<IMod>;

            if (currentSequence !== detailSequence) {
                return null;
            }

            if (!response.ok || !payload.success || !payload.data) {
                throw new Error(payload.msg || "读取 Mod 详情失败");
            }

            selectedMod.value = payload.data;
            modLookupInput.value = String(payload.data.id);
            return payload.data;
        } catch (error: unknown) {
            if (currentSequence !== detailSequence) {
                return null;
            }

            selectedMod.value = null;
            modLookupError.value = getErrorMessage(error);
            return null;
        } finally {
            if (currentSequence === detailSequence) {
                modLookupLoading.value = false;
            }
        }
    }

    return {
        modLookupInput,
        modLookupLoading,
        modLookupError,
        selectedMod,
        detailParagraphs,
        loadModDetail,
        resolveGlossAssetUrl,
    };
}
