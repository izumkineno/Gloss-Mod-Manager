import {
    extractJsonMiddleware,
    generateText,
    NoObjectGeneratedError,
    Output,
    wrapLanguageModel,
} from "ai";
import { z } from "zod";
import { languageOptions, type AppLocale } from "@/lang/locales";
import { AiChat } from "@/lib/AiChat";

const MAX_DESCRIPTION_LENGTH = 12000;
const TRANSLATION_PROMPT_VERSION = 2;

export interface IExploreTranslationSourceItem {
    id: string;
    title?: string;
    summary?: string;
    description?: string;
    typeName?: string;
    categories?: string[];
    tags?: string[];
    resourceName?: string;
}

export interface IExploreTranslationEntry {
    id: string;
    title: string;
    summary: string;
    description: string;
    typeName: string;
    categories: string[];
    tags: string[];
    resourceName: string;
}

export interface IExploreTranslationRequest {
    baseUrl: string;
    apiKey: string;
    modelId?: string;
    targetLocale: AppLocale;
    source: string;
    items: IExploreTranslationSourceItem[];
    abortSignal?: AbortSignal;
    // 独立小模型通道：用极简 prompt 逐字段直译，不套复杂 JSON 指令。
    simplePrompt?: boolean;
    // 流式输出：每译完一条（独立通道为每字段）即回调，调用方写入响应式 map 边译边显。
    onEntry?: (id: string, entry: IExploreTranslationEntry) => void;
}

interface IPreparedTranslationItem extends IExploreTranslationEntry {
    cacheKey: string;
}

const translatedStringSchema = z
    .preprocess((value) => {
        if (value === null || value === undefined) {
            return "";
        }

        return typeof value === "string" ? value : String(value);
    }, z.string())
    .catch("");

const translatedStringArraySchema = z
    .preprocess((value) => {
        if (Array.isArray(value)) {
            return value.map((item) => {
                return typeof item === "string" ? item : String(item ?? "");
            });
        }

        if (typeof value === "string" && value.trim()) {
            return [value];
        }

        return [];
    }, z.array(z.string()))
    .catch([]);

const translationEntrySchema = z.object({
    id: translatedStringSchema.describe(
        "Input item id. Must be copied exactly.",
    ),
    title: translatedStringSchema,
    summary: translatedStringSchema,
    description: translatedStringSchema,
    typeName: translatedStringSchema,
    categories: translatedStringArraySchema,
    tags: translatedStringArraySchema,
    resourceName: translatedStringSchema,
});

const translationResultSchema = z.preprocess(
    (value) => {
        if (Array.isArray(value)) {
            return {
                items: value,
            };
        }

        return value;
    },
    z.object({
        items: z.array(translationEntrySchema),
    }),
);

const translationCache = new Map<string, IExploreTranslationEntry>();

function toErrorMessage(error: unknown, fallbackMessage: string) {
    if (NoObjectGeneratedError.isInstance(error)) {
        return "AI 未返回有效的翻译 JSON，请稍后重试或更换模型。";
    }

    if (error instanceof Error && error.message.trim()) {
        return error.message;
    }

    if (typeof error === "string" && error.trim()) {
        return error;
    }

    return fallbackMessage;
}

function normalizeText(value?: string) {
    return (value ?? "").replace(/\s+/gu, " ").trim();
}

function normalizeLongText(value?: string) {
    const normalized = (value ?? "").trim();

    if (normalized.length <= MAX_DESCRIPTION_LENGTH) {
        return normalized;
    }

    return normalized.slice(0, MAX_DESCRIPTION_LENGTH);
}

function normalizeTextArray(value?: string[]) {
    return (value ?? []).map((item) => normalizeText(item)).filter(Boolean);
}

function hasTranslatableText(item: IExploreTranslationEntry) {
    return Boolean(
        item.title ||
        item.summary ||
        item.description ||
        item.typeName ||
        item.resourceName ||
        item.categories.length ||
        item.tags.length,
    );
}

function createCacheKey(
    targetLocale: AppLocale,
    source: string,
    item: IExploreTranslationEntry,
) {
    return JSON.stringify({
        promptVersion: TRANSLATION_PROMPT_VERSION,
        targetLocale,
        source,
        id: item.id,
        title: item.title,
        summary: item.summary,
        description: item.description,
        typeName: item.typeName,
        categories: item.categories,
        tags: item.tags,
        resourceName: item.resourceName,
    });
}

function prepareTranslationItem(
    targetLocale: AppLocale,
    source: string,
    item: IExploreTranslationSourceItem,
): IPreparedTranslationItem | null {
    const normalizedItem: IExploreTranslationEntry = {
        id: normalizeText(item.id),
        title: normalizeText(item.title),
        summary: normalizeText(item.summary),
        description: normalizeLongText(item.description),
        typeName: normalizeText(item.typeName),
        categories: normalizeTextArray(item.categories),
        tags: normalizeTextArray(item.tags),
        resourceName: normalizeText(item.resourceName),
    };

    if (!normalizedItem.id || !hasTranslatableText(normalizedItem)) {
        return null;
    }

    return {
        ...normalizedItem,
        cacheKey: createCacheKey(targetLocale, source, normalizedItem),
    };
}

function normalizeTranslatedEntry(
    entry: z.infer<typeof translationEntrySchema> | undefined,
    fallback: IPreparedTranslationItem,
): IExploreTranslationEntry {
    return {
        id: fallback.id,
        title: normalizeText(entry?.title) || fallback.title,
        summary: normalizeText(entry?.summary) || fallback.summary,
        description: (entry?.description ?? "").trim() || fallback.description,
        typeName: normalizeText(entry?.typeName) || fallback.typeName,
        categories: normalizeTextArray(entry?.categories),
        tags: normalizeTextArray(entry?.tags),
        resourceName:
            normalizeText(entry?.resourceName) || fallback.resourceName,
    };
}

function getTargetLanguage(locale: AppLocale) {
    return (
        languageOptions.find((item) => item.value === locale) ??
        languageOptions[0]
    );
}


async function resolveModel(baseUrl: string, apiKey: string, modelId?: string) {
    const service = new AiChat(baseUrl, apiKey);
    const normalizedModelId = normalizeText(modelId);

    if (normalizedModelId) {
        // 指定了模型时不会走 getModels，仍要显式解析一次真实的 base URL。
        await service.ensureProviderBaseUrl();

        return {
            service,
            modelId: normalizedModelId,
        };
    }

    const models = await service.getModels();
    const firstModelId = models[0]?.id?.trim() ?? "";

    if (!firstModelId) {
        throw new Error("未找到可用的 AI 模型，请检查 AI 配置。");
    }

    return {
        service,
        modelId: firstModelId,
    };
}

function buildTranslationPrompt(
    source: string,
    targetLocale: AppLocale,
    items: IPreparedTranslationItem[],
) {
    const targetLanguage = getTargetLanguage(targetLocale);
    const payload = {
        source,
        targetLocale,
        targetLanguage: targetLanguage.nativeName,
        items: items.map(({ cacheKey: _cacheKey, ...item }) => item),
    };

    return [
        `请把下面 JSON 中的 Mod 展示文本翻译为 ${targetLanguage.nativeName}（${targetLocale.replace("_", "-")}）。`,
        '必须返回 JSON 对象，格式为 { "items": [...] }，不要返回裸数组或额外说明。',
        "只翻译 title、summary、description、typeName、categories、tags、resourceName 这些展示文本。",
        "title 必须按标题语义翻译，保留游戏名、人名、Mod 名等专有名词片段即可，不要因为包含专有名词就整句原样返回。",
        "description 即使包含 HTML、BBCode 或 Markdown，也要翻译其中可读的自然语言内容，可以保留换行，不要保留标签或代码块。",
        "id 必须逐字复制；items 数量、顺序、数组字段长度和顺序必须与输入一致。",
        "如果某个字段为空、是版本号/文件扩展名/纯专有名词，或已经是目标语言，请原样返回。",
        "不要把英文标题、介绍整段原样返回，除非整段没有可翻译的自然语言含义。",
        "输入 JSON：",
        JSON.stringify(payload),
    ].join("\n");
}

// 部分自建/聚合通道（如 hy-mt2）不支持 responseFormat+structuredOutputs，
// Output.object 会直接 NoObjectGeneratedError。这里先走结构化，失败则回退纯文本 + 本地解析。
function parseTranslationText(
    text: string,
): z.infer<typeof translationEntrySchema>[] | null {
    const candidates: string[] = [text];
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/iu);
    if (fenced?.[1]) {
        candidates.unshift(fenced[1]);
    }
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        candidates.unshift(text.slice(firstBrace, lastBrace + 1));
    }
    for (const candidate of candidates) {
        try {
            const parsed: unknown = JSON.parse(candidate);
            const normalized = translationResultSchema.parse(parsed);
            return normalized.items;
        } catch {
            continue;
        }
    }
    return null;
}
// 极简通道（独立小模型）：逐字段一句话直译，不套 JSON schema 指令。
// 字段为空/纯专有名词/已是目标语言时要求原样返回；返回原文即视为未译。
async function translateChunkSimple(
    request: IExploreTranslationRequest,
    items: IPreparedTranslationItem[],
) {
    const { service, modelId } = await resolveModel(
        request.baseUrl,
        request.apiKey,
        request.modelId,
    );
    const targetLanguage = getTargetLanguage(request.targetLocale);
    const chatModel = service.Agent.chatModel(modelId);
    const out: Record<string, IExploreTranslationEntry> = {};
    for (const item of items) {
        if (request.abortSignal?.aborted) {
            break;
        }
        const translated: IExploreTranslationEntry = { ...item };
        const textFields = [
            "title",
            "summary",
            "description",
            "typeName",
            "resourceName",
        ] as const;
        for (const field of textFields) {
            const original = item[field];
            if (!original.trim()) {
                continue;
            }
            const { text } = await generateText({
                model: chatModel,
                instructions: `将以下文本翻译为${targetLanguage.nativeName}，注意只需要输出翻译后的结果，不要额外解释：`,
                prompt: original,
                temperature: 0,
                maxRetries: 1,
                timeout: 60000,
                abortSignal: request.abortSignal,
            });
            const cleaned = text.trim();
            // 原样返回/空返回视为未译，保留原文。
            if (cleaned && cleaned !== original.trim()) {
                translated[field] = cleaned;
                // 边译边显：字段一出即回调，卡片标题先变中文。
                request.onEntry?.(item.id, { ...translated });
            }
        }
        for (const field of ["categories", "tags"] as const) {
            const list = item[field];
            if (list.length === 0) {
                continue;
            }
            const { text } = await generateText({
                model: chatModel,
                instructions: `将以下文本翻译为${targetLanguage.nativeName}，注意只需要输出翻译后的结果，不要额外解释：`,
                prompt: list.join("\n"),
                temperature: 0,
                maxRetries: 1,
                timeout: 60000,
                abortSignal: request.abortSignal,
            });
            const lines = text
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean);
            if (lines.length === list.length) {
                translated[field] = lines;
                request.onEntry?.(item.id, { ...translated });
            }
        }
        translationCache.set(item.cacheKey, translated);
        out[item.id] = translated;
        request.onEntry?.(item.id, { ...translated });
    }
    return out;
}
async function translateChunk(
    request: IExploreTranslationRequest,
    items: IPreparedTranslationItem[],
) {
    // 极简通道：逐字段直译，返回原文 key→译文的扁平对象，小模型照做即可。
    if (request.simplePrompt) {
        return translateChunkSimple(request, items);
    }
    const { service, modelId } = await resolveModel(
        request.baseUrl,
        request.apiKey,
        request.modelId,
    );
    const prompt = buildTranslationPrompt(
        request.source,
        request.targetLocale,
        items,
    );
    const instructions =
        "你是 Gloss Mod Manager 的 Mod 元数据翻译器。只返回符合 schema 的 JSON，不要改写任何功能字段。";
    let resultItems: z.infer<typeof translationEntrySchema>[];
    try {
        const model = wrapLanguageModel({
            model: service.Agent.chatModel(modelId),
            middleware: extractJsonMiddleware(),
        });
        const result = await generateText({
            model,
            output: Output.object({
                name: "ExploreModTranslations",
                description:
                    "Translated display-only text for mod browsing cards.",
                schema: translationResultSchema,
            }),
            instructions,
            prompt,
            temperature: 0,
            maxRetries: 1,
            timeout: 60000,
            abortSignal: request.abortSignal,
        });
        resultItems = result.output.items;
    } catch (error) {
        console.debug("[翻译取证] 结构化失败，进回退", {
            isNoObject: NoObjectGeneratedError.isInstance(error),
            message: error instanceof Error ? error.message.slice(0, 200) : String(error),
        });
        // 结构化通道失败（如 responseFormat 不支持）时回退纯文本。
        if (!NoObjectGeneratedError.isInstance(error)) {
            throw error;
        }
        const fallback = await generateText({
            model: service.Agent.chatModel(modelId),
            instructions,
            prompt,
            temperature: 0,
            maxRetries: 1,
            timeout: 60000,
            abortSignal: request.abortSignal,
        });
        console.debug("[翻译取证] 纯文本回退原文", fallback.text.slice(0, 500));
        const parsed = parseTranslationText(fallback.text);
        console.debug("[翻译取证] 回退解析", { ok: Boolean(parsed), count: parsed?.length ?? 0 });
        if (!parsed) {
            throw error;
        }
        resultItems = parsed;
    }
    const resultMap = new Map(resultItems.map((item) => [item.id, item]));
    return Object.fromEntries(
        items.map((item, index) => {
            const translated = normalizeTranslatedEntry(
                resultMap.get(item.id) ?? resultItems[index],
                item,
            );

            translationCache.set(item.cacheKey, translated);

            return [item.id, translated];
        }),
    ) as Record<string, IExploreTranslationEntry>;
}

export async function translateExploreItems(
    request: IExploreTranslationRequest,
) {
    const normalizedBaseUrl = request.baseUrl.trim();

    // key 可空：本地无鉴权通道（如 Ollama）仅需 Base Url。
    if (!normalizedBaseUrl) {
        throw new Error("请先在设置页完成 AI 配置。");
    }

    const preparedItems = request.items
        .map((item) =>
            prepareTranslationItem(request.targetLocale, request.source, item),
        )
        .filter((item): item is IPreparedTranslationItem => Boolean(item));
    const translatedMap: Record<string, IExploreTranslationEntry> = {};
    const pendingItems: IPreparedTranslationItem[] = [];

    for (const item of preparedItems) {
        const cached = translationCache.get(item.cacheKey);

        if (cached) {
            translatedMap[item.id] = cached;
            continue;
        }

        pendingItems.push(item);
    }

    // 逐条发送：弱模型一次只译一条，避免批量 JSON 被截断/错位；单条失败只丢该条。
    for (const item of pendingItems) {
        if (request.abortSignal?.aborted) {
            break;
        }
        try {
            Object.assign(translatedMap, await translateChunk(request, [item]));
        } catch (error) {
            console.debug("[翻译取证] 单条失败跳过", { id: item.id });
            if (request.abortSignal?.aborted) {
                break;
            }
            throw error;
        }
    }

    return translatedMap;
}

export function getExploreTranslationErrorMessage(
    error: unknown,
    fallbackMessage = "AI 翻译失败。",
) {
    return toErrorMessage(error, fallbackMessage);
}
