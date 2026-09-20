// Thunderstore 列表/详情走 Rust 后端（内存缓存全量包列表，翻页搜索零请求）。
import { invoke } from "@tauri-apps/api/core";
// 统一走带超时与重试的封装，避免对端无响应时请求永久挂起。
import { requestWithRetry as httpFetch } from "@/lib/http-client";
import { PersistentStore } from "@/lib/persistent-store";
import { SecretStore } from "@/lib/secret-store";

export type ThirdPartyProvider =
    | "NexusMods"
    | "Thunderstore"
    | "ModIo"
    | "CurseForge"
    | "GameBanana";

export type ThirdPartyDescriptionFormat = "markdown" | "html" | "text";

export type ThirdPartyListSortKey =
    | "default"
    | "updatedAt"
    | "createdAt"
    | "downloads";

export interface IThirdPartyListQuery {
    page: number;
    pageSize: number;
    searchText: string;
    sort: ThirdPartyListSortKey;
    nexusModsFacets?: INexusModsFacetSelection;
}

export interface IThirdPartyModFile {
    id: string;
    name: string;
    // Nexus 等来源的真实文件名（含后缀），优先于显示名用于落盘。
    fileName?: string;
    version: string;
    size: number;
    createdAt: string;
    downloadUrl: string;
    detailsUrl: string;
    categoryName?: string;
}

export interface IThirdPartyModItem {
    source: ThirdPartyProvider;
    id: string;
    routeId: string;
    routeQuery: Record<string, string>;
    title: string;
    summary: string;
    author: string;
    version: string;
    website: string;
    cover: string;
    gallery: string[];
    downloads: number;
    likes: number;
    categories: string[];
    tags: string[];
    createdAt: string;
    updatedAt: string;
    nsfw: boolean;
    filesCount: number;
    primaryFile: IThirdPartyModFile | null;
}

export interface IThirdPartyModDetail extends IThirdPartyModItem {
    description: string;
    descriptionFormat: ThirdPartyDescriptionFormat;
    files: IThirdPartyModFile[];
}

export interface IThirdPartyModListResult {
    items: IThirdPartyModItem[];
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
    facets?: IThirdPartyModFacets;
    // Thunderstore 纯后端返回的缓存年龄（秒），其他 provider 无此字段。
    cacheAgeSecs?: number | null;
}

export interface IThirdPartyModFacetOption {
    label: string;
    value: string;
    count: number;
}

export interface IThirdPartyModFacets {
    categoryName: IThirdPartyModFacetOption[];
    languageName: IThirdPartyModFacetOption[];
    tag: IThirdPartyModFacetOption[];
}

export interface INexusModsFacetSelection {
    categoryName?: string;
    languageName?: string;
    tag?: string;
}

export interface IThirdPartyProviderOption {
    label: string;
    value: ThirdPartyProvider;
}

interface IModIoListResponse {
    data: IModIo[];
    result_total: number;
}

interface IModIoGameResponse {
    tag_options?: Array<{
        tags?: Array<{
            name?: string;
        }>;
    }>;
}

interface ICurseForgeListResponse {
    data: ICurseForgeMod[];
    pagination: {
        totalCount: number;
    };
}

interface ICurseForgeDetailResponse {
    data: ICurseForgeMod;
}

interface ICurseForgeDescriptionResponse {
    data: string;
}

interface IGameBananaListResponse {
    _aRecords: IGameBananaMod[];
    _aMetadata?: {
        _nRecordCount?: number;
    };
}

interface INexusGraphqlResponse {
    data?: {
        mods?: {
            facetsData?: INexusModsFacetData;
            nodes?: INexusMods[];
            totalCount?: number;
        };
    };
}

interface INexusModsFacetData {
    categoryName?: Record<string, number>;
    languageName?: Record<string, number>;
    tag?: Record<string, number>;
}

interface INexusModsV1Mod {
    author?: string;
    available?: boolean;
    category_id?: number;
    contains_adult_content?: boolean;
    created_time?: string;
    created_timestamp?: number;
    description?: string;
    domain_name?: string;
    endorsement_count?: number;
    game_id?: number;
    mod_downloads?: number;
    mod_id?: number;
    name?: string;
    picture_url?: string;
    status?: string;
    summary?: string;
    uid?: number | string;
    updated_time?: string;
    updated_timestamp?: number;
    uploaded_by?: string;
    uploaded_users_profile_url?: string;
    user?: {
        avatar?: string;
        member_id?: number;
        name?: string;
    };
    version?: string;
}

interface INexusModsFilesResponse {
    files?: INexusModsFile[];
}

interface IApiMessageResponse {
    message?: string;
}

interface INexusDownloadLinkResponseItem {
    URI: string;
}

interface INexusDownloadLinkResponseItem {
    URI: string;
}
export interface INexusModsDownloadAuthorization {
    key?: string;
    expires?: string;
}

// NexusMods 下载模式：api 走官方 API 解析；cookie 走登录 Cookie 直连（免排队/倒计时）。
export type NexusModsDownloadMode = "api" | "cookie";
export interface INexusModsDirectOptions {
    // 登录后 Cookie 原文（后端透传给站内接口，不经前端请求）。
    cookie?: string;
    // 下载模式，默认 api。
    mode?: NexusModsDownloadMode;
    // 下载代理（后端 reqwest 显式代理，如 http://127.0.0.1:7890）；不传则读 downloadProxy。
    proxy?: string | null;
}

export const THIRD_PARTY_PROVIDER_OPTIONS: IThirdPartyProviderOption[] = [
    { label: "NexusMods", value: "NexusMods" },
    { label: "Thunderstore", value: "Thunderstore" },
    { label: "Mod.io", value: "ModIo" },
    { label: "CurseForge", value: "CurseForge" },
    { label: "GameBanana", value: "GameBanana" },
];

const CURSE_FORGE_BASE_URL = "https://api.curseforge.com";
const GAMEBANANA_BASE_URL = "https://gamebanana.com/apiv11";
const MOD_IO_KEY = (import.meta.env.MODID_KEY ?? "").trim();
const MOD_IO_UID_KEY = (import.meta.env.MODID_UID_KEY ?? "").trim();
const CURSE_FORGE_KEY = (import.meta.env.CURSE_FORGE_KEY ?? "").trim();
export class NexusModsAuthorizationError extends Error {
    public constructor(message = "请先授权 NexusMods") {
        super(message);
        this.name = "NexusModsAuthorizationError";
    }
}

export function getThirdPartyProviderLabel(provider: ThirdPartyProvider) {
    return (
        THIRD_PARTY_PROVIDER_OPTIONS.find((item) => item.value === provider)
            ?.label ?? provider
    );
}

export function isThirdPartyProviderSupported(
    game: ISupportedGames | null | undefined,
    provider: ThirdPartyProvider,
) {
    if (!game) {
        return false;
    }

    switch (provider) {
        case "NexusMods":
            return Boolean(game.nexusMods?.game_domain_name);
        case "Thunderstore":
            return Boolean(game.Thunderstore?.community_identifier);
        case "ModIo":
            return Boolean(game.mod_io);
        case "CurseForge":
            return Boolean(game.curseforge);
        case "GameBanana":
            return Boolean(game.gamebanana);
    }
}

export async function validateNexusModsUser(apiKey: string) {
    const normalizedApiKey = apiKey.trim();

    if (!normalizedApiKey) {
        throw new NexusModsAuthorizationError();
    }

    const response = await httpFetch(
        "https://api.nexusmods.com/v1/users/validate.json",
        {
            method: "GET",
            headers: {
                Accept: "application/json",
                apikey: normalizedApiKey,
            },
        },
    );
    const payload = (await response.json()) as INexusModsUser;

    if (!response.ok || !payload?.key) {
        throw new Error("校验 NexusMods 授权失败。");
    }

    return payload;
}

export async function fetchThirdPartyMods(
    provider: ThirdPartyProvider,
    game: ISupportedGames,
    query: IThirdPartyListQuery,
    nexusUser?: INexusModsUser | null,
): Promise<IThirdPartyModListResult> {
    switch (provider) {
        case "NexusMods":
            return fetchNexusModsList(game, query, nexusUser);
        case "Thunderstore":
            return fetchThunderstoreList(game, query);
        case "ModIo":
            return fetchModIoList(game, query);
        case "CurseForge":
            return fetchCurseForgeList(game, query);
        case "GameBanana":
            return fetchGameBananaList(game, query);
    }
}

export async function fetchThirdPartyModDetail(
    provider: ThirdPartyProvider,
    game: ISupportedGames,
    routeId: string,
    routeQuery: Record<string, string>,
    nexusUser?: INexusModsUser | null,
) {
    switch (provider) {
        case "NexusMods":
            return fetchNexusModsDetail(game, routeId, nexusUser, routeQuery);
        case "Thunderstore":
            return fetchThunderstoreDetail(
                routeQuery.namespace,
                routeQuery.name,
            );
        case "ModIo":
            return fetchModIoDetail(
                Number(routeQuery.gameId || game.mod_io || 0),
                Number(routeId),
            );
        case "CurseForge":
            return fetchCurseForgeDetail(Number(routeId));
        case "GameBanana":
            return fetchGameBananaDetail(routeId);
    }
}

export async function resolveThirdPartyDownloadUrl(
    detail: IThirdPartyModDetail,
    fileId?: string,
    nexusUser?: INexusModsUser | null,
    nexusDownloadAuthorization?: INexusModsDownloadAuthorization | null,
    nexusDirect?: INexusModsDirectOptions | null,
) {
    // 凭据走 Stronghold 异步水合：启动热路径（NXM 深链/开页即重试）可能读到空值，
    // 先等水合完成再读，避免空 Cookie 误报"未配置"并回退到无权限的 API 模式。
    const resolveTag = `[resolve] modId=${detail.id} fileId=${fileId ?? ""}`;
    console.debug(`${resolveTag} stage=start mode=${nexusDirect?.mode ?? "api"}`);
    if (detail.source === "NexusMods" && nexusDirect?.mode === "cookie") {
        console.debug(`${resolveTag} stage=secret-ready-wait`);
        await SecretStore.ready("nexusModsCookie");
        console.debug(`${resolveTag} stage=secret-ready-done`);
    }
    if (detail.source !== "NexusMods") {
        const targetFile =
            detail.files.find((item) => item.id === fileId) ??
            detail.primaryFile ??
            null;

        return targetFile?.downloadUrl || "";
    }

    const targetFile =
        detail.files.find((item) => item.id === fileId) ?? detail.primaryFile;

    if (!targetFile) {
        return "";
    }

    const gameDomain = detail.routeQuery.gameDomain;
    if (!gameDomain) {
        return "";
    }

    // Cookie 直连优先：后端调站内接口直接拿 CDN 链接，失败抛错由调用方回退 API。
    if (nexusDirect?.mode === "cookie") {
        const cookie = nexusDirect.cookie?.trim() ?? "";
        if (!cookie) {
            throw new Error("未配置 NexusMods Cookie，请在设置页填写后重试。");
        }
    // 代理未显式传入时读全局下载代理：后端 reqwest 只认显式代理，直连 www.nexusmods.com 会被墙。
    const storedProxy = ((await PersistentStore.get<string>("downloadProxy", "")) ?? "").trim();
    console.debug(`${resolveTag} stage=cookie-invoke game=${gameDomain} proxy=${storedProxy ? "yes" : "no"}`);
        return invoke<string>("nexus_resolve_direct", {
            gameDomain,
            modId: detail.id,
            fileId: targetFile.id,
            cookie,
            isNmm: false,
            proxy: nexusDirect.proxy ?? (storedProxy || null),
            apiKey: nexusUser?.key?.trim() ? nexusUser.key.trim() : null,
        });
    }
    console.debug(`${resolveTag} stage=api-fallback`);

    return resolveNexusModsDownloadUrl(
        gameDomain,
        detail.id,
        targetFile.id,
        nexusUser,
        nexusDownloadAuthorization,
    );
}

export async function fetchModIoGameTags(gameId: number) {
    if (!MOD_IO_KEY || !MOD_IO_UID_KEY || !gameId) {
        return [] as string[];
    }

    const response = await httpFetch(
        `${getModIoBaseUrl()}/games/${gameId}?api_key=${encodeURIComponent(
            MOD_IO_KEY,
        )}`,
        {
            method: "GET",
            headers: {
                Accept: "application/json",
            },
        },
    );
    const payload = (await response.json()) as IModIoGameResponse;

    if (!response.ok) {
        return [] as string[];
    }

    return (
        payload.tag_options?.[0]?.tags
            ?.map((item) => item.name?.trim() ?? "")
            .filter(Boolean) ?? []
    );
}

function getModIoBaseUrl() {
    if (!MOD_IO_UID_KEY) {
        throw new Error("未读取到 MODID_UID_KEY，请检查 .env 配置。");
    }

    return `https://u-${MOD_IO_UID_KEY}.modapi.io/v1`;
}

function getNexusModsApiKey(
    nexusUser?: INexusModsUser | null,
    required = false,
) {
    const apiKey = nexusUser?.key?.trim() ?? "";

    if (!apiKey && required) {
        throw new NexusModsAuthorizationError();
    }

    return apiKey;
}

function normalizePage(page: number) {
    return Math.max(1, Math.round(page || 1));
}

function normalizePageSize(pageSize: number) {
    return Math.max(1, Math.round(pageSize || 1));
}

function toTimestamp(value?: string | number | null) {
    if (!value && value !== 0) {
        return 0;
    }

    const parsed = new Date(value).getTime();

    return Number.isFinite(parsed) ? parsed : 0;
}

function compareThirdPartyListItems(
    left: IThirdPartyModItem,
    right: IThirdPartyModItem,
    sortKey: Exclude<ThirdPartyListSortKey, "default">,
) {
    switch (sortKey) {
        case "updatedAt":
            return toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt);
        case "createdAt":
            return toTimestamp(right.createdAt) - toTimestamp(left.createdAt);
        case "downloads":
            return (right.downloads ?? 0) - (left.downloads ?? 0);
    }
}

function sortThirdPartyListItems(
    items: IThirdPartyModItem[],
    sortKey: Exclude<ThirdPartyListSortKey, "default">,
) {
    return items
        .map((item, index) => ({
            item,
            index,
        }))
        .sort((left, right) => {
            const result = compareThirdPartyListItems(
                left.item,
                right.item,
                sortKey,
            );

            return result !== 0 ? result : left.index - right.index;
        })
        .map(({ item }) => item);
}

function paginateThirdPartyItems(
    items: IThirdPartyModItem[],
    query: IThirdPartyListQuery,
) {
    const page = normalizePage(query.page);
    const pageSize = normalizePageSize(query.pageSize);
    const start = (page - 1) * pageSize;

    return {
        items: items.slice(start, start + pageSize),
        page,
        pageSize,
        totalCount: items.length,
        totalPages: items.length > 0 ? Math.ceil(items.length / pageSize) : 0,
    } satisfies Omit<IThirdPartyModListResult, "facets">;
}

function getNexusModsSortVariables(query: IThirdPartyListQuery) {
    switch (query.sort) {
        case "createdAt":
            return [{ createdAt: { direction: "DESC" as const } }];
        case "downloads":
            return [{ downloads: { direction: "DESC" as const } }];
        case "updatedAt":
        case "default":
        default:
            return [{ updatedAt: { direction: "DESC" as const } }];
    }
}

function getModIoSortValue(query: IThirdPartyListQuery) {
    switch (query.sort) {
        case "updatedAt":
            return "date_updated";
        case "createdAt":
            return "date_live";
        case "downloads":
        case "default":
        default:
            return "downloads";
    }
}

function getCurseForgeSortParams(query: IThirdPartyListQuery) {
    switch (query.sort) {
        case "createdAt":
            return {
                sortField: "11",
                sortOrder: "desc",
            };
        case "downloads":
            return {
                sortField: "6",
                sortOrder: "desc",
            };
        case "updatedAt":
        case "default":
        default:
            return {
                sortField: "3",
                sortOrder: "desc",
            };
    }
}

async function fetchAllGameBananaMods(gameId: number, searchText: string) {
    const items: IGameBananaMod[] = [];
    const pageSize = 200;
    let page = 1;
    let totalCount = 0;

    while (page === 1 || items.length < totalCount) {
        const params = new URLSearchParams({
            _nPage: String(page),
            _nPerpage: String(pageSize),
            _csvModelInclusions: "Mod",
            "_aFilters[Generic_Game]": String(gameId),
        });

        if (normalizeText(searchText)) {
            params.set(
                "_aFilters[Generic_Name]",
                `contains,${normalizeText(searchText)}`,
            );
        }

        const response = await httpFetch(
            `${GAMEBANANA_BASE_URL}/Mod/Index?${params.toString()}`,
            {
                method: "GET",
                headers: {
                    Accept: "application/json",
                },
            },
        );
        const payload = (await response.json()) as IGameBananaListResponse;

        if (!response.ok || !Array.isArray(payload._aRecords)) {
            throw new Error("获取 GameBanana 列表失败。");
        }

        items.push(...payload._aRecords);
        totalCount = payload._aMetadata?._nRecordCount ?? items.length;

        if (!payload._aRecords.length) {
            break;
        }

        page += 1;
    }

    return items;
}

function buildIsoDate(input?: string | number | null) {
    if (!input && input !== 0) {
        return "";
    }

    if (typeof input === "number") {
        return new Date(input * 1000).toISOString();
    }

    const parsed = new Date(input);
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function normalizeText(value?: string | null) {
    return (value ?? "").trim();
}

function normalizeCurseForgeDownloadUrl(url?: string | null) {
    const normalized = normalizeText(url);

    if (!normalized) {
        return "";
    }

    return normalized.replace("edge.forgecdn.net", "mediafilez.forgecdn.net");
}

function buildGameBananaMediaUrl(media?: IGameBananaMedia) {
    if (!media?._sBaseUrl) {
        return "";
    }

    const fileName =
        media._sFile530 || media._sFile220 || media._sFile100 || media._sFile;

    return fileName ? `${media._sBaseUrl}/${fileName}` : "";
}

function emptyListResult(
    query: IThirdPartyListQuery,
): IThirdPartyModListResult {
    return {
        items: [],
        page: normalizePage(query.page),
        pageSize: normalizePageSize(query.pageSize),
        totalCount: 0,
        totalPages: 0,
        facets: emptyThirdPartyModFacets(),
    };
}

function emptyThirdPartyModFacets(): IThirdPartyModFacets {
    return {
        categoryName: [],
        languageName: [],
        tag: [],
    };
}

function normalizeFacetOptions(source?: Record<string, number>) {
    return Object.entries(source ?? {})
        .map(([value, count]) => {
            return {
                label: value,
                value,
                count: Math.max(0, Number(count) || 0),
            } satisfies IThirdPartyModFacetOption;
        })
        .filter((item) => item.value)
        .sort((left, right) => {
            const countDifference = right.count - left.count;

            return countDifference || left.label.localeCompare(right.label);
        });
}

function normalizeNexusModsFacets(
    facetsData?: INexusModsFacetData,
): IThirdPartyModFacets {
    return {
        categoryName: normalizeFacetOptions(facetsData?.categoryName),
        languageName: normalizeFacetOptions(facetsData?.languageName),
        tag: normalizeFacetOptions(facetsData?.tag),
    };
}

function buildNexusModsFacetVariables(selection?: INexusModsFacetSelection) {
    const categoryName = normalizeText(selection?.categoryName);
    const languageName = normalizeText(selection?.languageName);
    const tag = normalizeText(selection?.tag);

    return {
        categoryName: categoryName ? [categoryName] : [],
        languageName: languageName ? [languageName] : [],
        tag: tag ? [tag] : [],
    };
}

function buildNexusModsWebsite(
    gameDomain: string,
    modId: string,
    fileId?: string,
) {
    const url = new URL(
        `https://www.nexusmods.com/${gameDomain}/mods/${modId}`,
    );

    if (fileId) {
        url.searchParams.set("tab", "files");
        url.searchParams.set("file_id", fileId);
        url.searchParams.set("nmm", "1");
    }

    return url.toString();
}

function getNexusModsHeaders(
    nexusUser?: INexusModsUser | null,
    requireAuthorization = false,
) {
    const headers: Record<string, string> = {
        Accept: "application/json",
    };
    const apiKey = getNexusModsApiKey(nexusUser, requireAuthorization);

    if (apiKey) {
        headers.apikey = apiKey;
    }

    return headers;
}

function buildNexusModsErrorMessage(payload: unknown, fallbackMessage: string) {
    const message =
        typeof payload === "object" &&
        payload !== null &&
        "message" in payload &&
        typeof payload.message === "string"
            ? normalizeText(payload.message)
            : "";

    return message || fallbackMessage;
}

async function fetchNexusModsApiJson<T>(
    path: string,
    nexusUser?: INexusModsUser | null,
) {
    // A：凭据水合等待。启动热路径 nexusUser.key 可能还是空（Stronghold 未读完），
    // 先等水合完成；等完仍空才是真未授权，避免误报“请先授权”。
    console.debug(`[auth] fetchNexusModsApiJson ${path} keyLen=${nexusUser?.key?.trim().length ?? 0}`);
    if (!nexusUser?.key?.trim()) {
        await SecretStore.ready("nexusModsToken");
        console.debug(`[auth] after-ready keyLen=${nexusUser?.key?.trim().length ?? 0}`);
    }
    // 避免裸调后把 Nexus 的英文原文透给用户。
    const response = await httpFetch(`https://api.nexusmods.com${path}`, {
        method: "GET",
        headers: getNexusModsHeaders(nexusUser, true),
    });
    const payload = (await response.json()) as T | IApiMessageResponse;
    console.debug(`[auth] api status=${response.status} path=${path} msg=${buildNexusModsErrorMessage(payload, "")}`);
    if (response.status === 401 || response.status === 403) {
        throw new NexusModsAuthorizationError();
    }

    if (!response.ok) {
        throw new Error(
            buildNexusModsErrorMessage(payload, "请求 NexusMods 接口失败。"),
        );
    }

    return payload as T;
}

function normalizeNexusModsAuthor(item: INexusModsV1Mod) {
    return normalizeText(
        item.author || item.uploaded_by || item.user?.name || "",
    );
}

function normalizeNexusModsBaseItem(
    item: INexusModsV1Mod,
    gameDomain: string,
    files: IThirdPartyModFile[],
): IThirdPartyModItem {
    const modId = normalizeText(String(item.mod_id ?? ""));
    const normalizedGameDomain = normalizeText(item.domain_name || gameDomain);
    const primaryFile = files[0] ?? null;

    return {
        source: "NexusMods",
        id: modId,
        routeId: modId,
        routeQuery: {
            source: "NexusMods",
            gameDomain: normalizedGameDomain,
        },
        title: normalizeText(item.name || ""),
        summary: normalizeText(item.summary || ""),
        author: normalizeNexusModsAuthor(item),
        version: normalizeText(item.version || ""),
        website: buildNexusModsWebsite(normalizedGameDomain, modId),
        cover: normalizeText(item.picture_url || ""),
        gallery: [normalizeText(item.picture_url || "")].filter(Boolean),
        downloads: Math.max(0, Number(item.mod_downloads ?? 0)),
        likes: Math.max(0, Number(item.endorsement_count ?? 0)),
        categories: [],
        tags: [],
        createdAt:
            normalizeText(item.created_time || "") ||
            buildIsoDate(item.created_timestamp) ||
            "",
        updatedAt:
            normalizeText(item.updated_time || "") ||
            buildIsoDate(item.updated_timestamp) ||
            "",
        nsfw: Boolean(item.contains_adult_content),
        filesCount: files.length,
        primaryFile,
    };
}

function normalizeNexusModsDetailPayload(
    item: INexusModsV1Mod,
    files: INexusModsFile[],
    gameDomain: string,
): IThirdPartyModDetail {
    const modId = normalizeText(String(item.mod_id ?? ""));
    const normalizedFiles = normalizeNexusModsFiles(files, gameDomain, modId);
    const baseItem = normalizeNexusModsBaseItem(
        item,
        gameDomain,
        normalizedFiles,
    );

    return {
        ...baseItem,
        description: item.description || item.summary || "",
        descriptionFormat: item.description ? "html" : "text",
        files: normalizedFiles,
    } satisfies IThirdPartyModDetail;
}

// 单文件接口回填真实 file_name：collection/pending 重建的最小 detail 没有 fileName，
// 建任务前调一次 /files/{fileId}.json 拿权威 file_name（含后缀），失败返回空由调用方回退。
export async function fetchNexusModsSingleFileName(
    gameDomain: string,
    modId: string,
    fileId: string,
    nexusUser?: INexusModsUser | null,
): Promise<string> {
    try {
        const payload = await fetchNexusModsApiJson<INexusModsFile>(
            `/v1/games/${gameDomain}/mods/${modId}/files/${fileId}.json`,
            nexusUser,
        );
        return (payload?.file_name || "").trim();
    } catch {
        // 403 Mod not available 等：返回空，调用方走原有回退链路，不阻塞建任务。
        return "";
    }
}

 // collection 已知 modId/fileId 时的最小 detail：直调直链，跳过 files 清单接口。
 // files.json 对部分 mod 返回 403 Mod not available（API 不可见但网页可下）。
export function buildMinimalNexusModDetail(
    gameDomain: string,
    modId: string,
    fileId: string,
    name: string,
    version: string,
): IThirdPartyModDetail {
    const file: IThirdPartyModFile = {
        id: fileId,
        name,
        version,
        size: 0,
        createdAt: "",
        downloadUrl: "",
        detailsUrl: "",
    };
    return {
        source: "NexusMods",
        id: modId,
        routeId: modId,
        routeQuery: { gameDomain },
        title: name,
        summary: "",
        author: "",
        version,
        website: buildNexusModsWebsite(gameDomain, modId, fileId),
        cover: "",
        gallery: [],
        downloads: 0,
        likes: 0,
        categories: [],
        tags: [],
        createdAt: "",
        updatedAt: "",
        nsfw: false,
        filesCount: 1,
        description: "",
        descriptionFormat: "text",
        primaryFile: file,
        files: [file],
    };
}
// Collection 补介绍：只读 mods/{id}.json（不碰 files.json，避免 403 连坐）。
// 失败返回 null，调用方继续用最小 detail 建任务，不阻塞下载。
export async function fetchNexusModsModMeta(
    gameDomain: string,
    modId: string,
    nexusUser?: INexusModsUser | null,
): Promise<Pick<IThirdPartyModDetail, "summary" | "description" | "author" | "cover" | "title"> | null> {
    try {
        const payload = await fetchNexusModsApiJson<INexusModsV1Mod>(
            `/v1/games/${gameDomain}/mods/${modId}.json`,
            nexusUser,
        );
        return {
            title: normalizeText(payload.name || ""),
            summary: normalizeText(payload.summary || ""),
            description: normalizeText(payload.description || ""),
            author: normalizeNexusModsAuthor(payload),
            cover: normalizeText(payload.picture_url || ""),
        };
    } catch {
        return null;
    }
}

async function fetchNexusModsDetailById(
    gameDomain: string,
    modId: string,
    nexusUser?: INexusModsUser | null,
    ignoreFilesError = false,
) {
    const detailPayload = await fetchNexusModsApiJson<INexusModsV1Mod>(
        `/v1/games/${gameDomain}/mods/${modId}.json`,
        nexusUser,
    );
    let filesPayload: INexusModsFilesResponse = {};

    try {
        filesPayload = await fetchNexusModsApiJson<INexusModsFilesResponse>(
            `/v1/games/${gameDomain}/mods/${modId}/files.json`,
            nexusUser,
        );
    } catch (error: unknown) {
        if (!ignoreFilesError) {
            throw error;
        }
    }

    return normalizeNexusModsDetailPayload(
        detailPayload,
        filesPayload.files ?? [],
        gameDomain,
    );
}

async function fetchNexusModsList(
    game: ISupportedGames,
    query: IThirdPartyListQuery,
    nexusUser?: INexusModsUser | null,
) {
    const gameDomain = game.nexusMods?.game_domain_name?.trim() ?? "";
    if (!gameDomain) {
        return emptyListResult(query);
    }
    const page = normalizePage(query.page);
    const pageSize = normalizePageSize(query.pageSize);
    const gql = `
        query ModsListing(
            $count: Int = 0
            $facets: ModsFacet
            $filter: ModsFilter
            $offset: Int
            $sort: [ModsSort!]
        ) {
            mods(
                count: $count
                facets: $facets
                filter: $filter
                offset: $offset
                sort: $sort
                viewUserBlockedContent: false
            ) {
                facetsData
                nodes {
                    adultContent
                    createdAt
                    downloads
                    endorsements
                    fileSize
                    game {
                        domainName
                        id
                        name
                    }
                    modCategory {
                        categoryId
                        name
                    }
                    modId
                    name
                    status
                    summary
                    thumbnailUrl
                    uid
                    updatedAt
                    uploader {
                        avatar
                        memberId
                        name
                    }
                    viewerDownloaded
                    viewerEndorsed
                    viewerTracked
                    viewerUpdateAvailable
                }
                totalCount
            }
        }
    `;
    const variables: {
        count: number;
        facets: {
            categoryName: string[];
            languageName: string[];
            tag: string[];
        };
        offset: number;
        sort: Array<Record<string, { direction: "DESC" }>>;
        filter: {
            gameDomainName: {
                op: "EQUALS";
                value: string;
            };
            name?: {
                op: "WILDCARD";
                value: string;
            };
        };
    } = {
        count: pageSize,
        // facetsData 是 NexusMods 返回的列表级聚合分类，用于驱动分类筛选。
        facets: buildNexusModsFacetVariables(query.nexusModsFacets),
        offset: (page - 1) * pageSize,
        sort: getNexusModsSortVariables(query),
        filter: {
            gameDomainName: {
                op: "EQUALS",
                value: gameDomain,
            },
        },
    };

    if (normalizeText(query.searchText)) {
        variables.filter.name = {
            op: "WILDCARD",
            value: normalizeText(query.searchText),
        };
    }

    const response = await httpFetch(
        "https://api-router.nexusmods.com/graphql",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...getNexusModsHeaders(nexusUser),
            },
            body: JSON.stringify({
                query: gql,
                variables,
            }),
        },
    );
    const payload = (await response.json()) as INexusGraphqlResponse;

    if (!response.ok) {
        throw new Error("获取 NexusMods 列表失败。");
    }

    const items = payload.data?.mods?.nodes ?? [];
    const totalCount = payload.data?.mods?.totalCount ?? 0;
    const facets = normalizeNexusModsFacets(payload.data?.mods?.facetsData);

    return {
        items: items.map((item) => {
            const modId =
                String(item.modId).split("_")[0] ?? String(item.modId);

            return {
                source: "NexusMods",
                id: modId,
                routeId: modId,
                routeQuery: {
                    source: "NexusMods",
                    gameDomain: item.game.domainName,
                },
                title: item.name,
                summary: item.summary ?? "",
                author: item.uploader?.name ?? "",
                version: "",
                website: buildNexusModsWebsite(item.game.domainName, modId),
                cover: item.thumbnailUrl ?? item.picture_url ?? "",
                gallery: [
                    item.thumbnailUrl ?? "",
                    item.picture_url ?? "",
                ].filter(Boolean),
                downloads: item.downloads ?? 0,
                likes: item.endorsements ?? 0,
                categories: [item.modCategory?.name ?? ""].filter(Boolean),
                tags: [],
                createdAt: item.createdAt ?? "",
                updatedAt: item.updatedAt ?? "",
                nsfw: Boolean(item.adultContent),
                filesCount: 0,
                primaryFile: null,
            } satisfies IThirdPartyModItem;
        }),
        page,
        pageSize,
        totalCount,
        totalPages: totalCount > 0 ? Math.ceil(totalCount / pageSize) : 0,
        facets,
    } satisfies IThirdPartyModListResult;
}

async function fetchNexusModsDetail(
    game: ISupportedGames,
    routeId: string,
    nexusUser?: INexusModsUser | null,
    routeQuery?: Record<string, string>,
) {
    // game 经后端 JSON 往返可能丢失 nexusMods 嵌套字段，用调用方透传的 gameDomain 兜底。
    const gameDomain =
        game.nexusMods?.game_domain_name?.trim() ||
        routeQuery?.gameDomain?.trim() ||
        "";
    const modId =
        normalizeText(routeId).split("_")[0] ?? normalizeText(routeId);

    if (!gameDomain || !modId) {
        throw new Error("缺少 NexusMods 所需的游戏或 Mod 标识。");
    }

    return fetchNexusModsDetailById(gameDomain, modId, nexusUser);
}

function normalizeNexusModsFiles(
    files: INexusModsFile[],
    gameDomain: string,
    modId: string,
) {
    const prioritized = files.filter((item) => {
        return ["MAIN", "OPTIONAL"].includes(item.category_name);
    });
    const list = prioritized.length > 0 ? prioritized : [...files];

    return list
        .sort((left, right) => {
            const getCategoryWeight = (categoryName?: string) => {
                switch (categoryName) {
                    case "MAIN":
                        return 0;
                    case "OPTIONAL":
                        return 1;
                    default:
                        return 2;
                }
            };
            const categoryDifference =
                getCategoryWeight(left.category_name) -
                getCategoryWeight(right.category_name);

            return (
                categoryDifference ||
                (right.uploaded_timestamp ?? 0) - (left.uploaded_timestamp ?? 0)
            );
        })
        .map((item) => {
            return {
                id: String(item.file_id),
                name: item.name || item.file_name,
                fileName: item.file_name || "",
                version: item.version || item.mod_version || "",
                size: item.size_in_bytes || item.size_kb * 1024 || 0,
                createdAt:
                    item.uploaded_time ||
                    buildIsoDate(item.uploaded_timestamp) ||
                    "",
                downloadUrl: buildNexusModsWebsite(
                    gameDomain,
                    modId,
                    String(item.file_id),
                ),
                detailsUrl: buildNexusModsWebsite(
                    gameDomain,
                    modId,
                    String(item.file_id),
                ),
                categoryName: item.category_name,
            } satisfies IThirdPartyModFile;
        });
}

async function resolveNexusModsDownloadUrl(
    gameDomain: string,
    modId: string,
    fileId: string,
    nexusUser?: INexusModsUser | null,
    nexusDownloadAuthorization?: INexusModsDownloadAuthorization | null,
) {
    const downloadLinkUrl = new URL(
        `https://api.nexusmods.com/v1/games/${gameDomain}/mods/${modId}/files/${fileId}/download_link.json`,
    );

    // NXM 协议回调会携带临时 key，非会员下载需要把它传给 NexusMods。
    const nexusDownloadKey = normalizeText(nexusDownloadAuthorization?.key);
    const nexusDownloadExpires = normalizeText(
        nexusDownloadAuthorization?.expires,
    );

    if (nexusDownloadKey) {
        downloadLinkUrl.searchParams.set("key", nexusDownloadKey);

        if (nexusDownloadExpires) {
            downloadLinkUrl.searchParams.set("expires", nexusDownloadExpires);
        }
    }

    const response = await httpFetch(downloadLinkUrl.toString(), {
        method: "GET",
        headers: getNexusModsHeaders(nexusUser, true),
    });
    const payload = (await response.json()) as
        | INexusDownloadLinkResponseItem[]
        | IApiMessageResponse;

    if (!response.ok) {
        const message = buildNexusModsErrorMessage(
            payload,
            "获取 NexusMods 下载地址失败。",
        );

        if (response.status === 401) {
            throw new NexusModsAuthorizationError();
        }

        if (response.status === 403) {
            return buildNexusModsWebsite(gameDomain, modId, fileId);
        }

        throw new Error(message);
    }

    if (!Array.isArray(payload) || !payload[0]?.URI) {
        return buildNexusModsWebsite(gameDomain, modId, fileId);
    }

    return payload[0].URI;
}

async function fetchThunderstoreList(
    game: ISupportedGames,
    query: IThirdPartyListQuery,
) {
    const community = game.Thunderstore?.community_identifier?.trim() ?? "";
    if (!community) {
        return emptyListResult(query);
    }

    // 纯后端：过滤/排序/分页/归一化全在 Rust 侧，前端只做渲染。
    const invokeParams = {
        community,
        page: query.page,
        pageSize: query.pageSize,
        searchText: query.searchText,
        sort: query.sort,
    };
    console.debug("[thunderstore] invoke thunderstore_list", invokeParams);
    const startedAt = Date.now();
    try {
        const result = await invoke<IThirdPartyModListResult>("thunderstore_list", {
            params: invokeParams,
        });
        console.debug("[thunderstore] thunderstore_list ok", {
            elapsedMs: Date.now() - startedAt,
            page: result.page,
            totalPages: result.totalPages,
            totalCount: result.totalCount,
            itemCount: result.items?.length ?? 0,
        });
        return {
            items: result.items ?? [],
            page: result.page,
            pageSize: result.pageSize,
            totalCount: result.totalCount,
            totalPages: result.totalPages,
            cacheAgeSecs:
                typeof result.cacheAgeSecs === "number" ? result.cacheAgeSecs : null,
        } satisfies IThirdPartyModListResult;
    } catch (error) {
        console.error("[thunderstore] thunderstore_list failed", {
            elapsedMs: Date.now() - startedAt,
            params: invokeParams,
            error,
        });
        throw error;
    }
}

async function fetchThunderstoreDetail(namespace?: string, name?: string) {
    const normalizedNamespace = normalizeText(namespace);
    const normalizedName = normalizeText(name);

    if (!normalizedNamespace || !normalizedName) {
        throw new Error("缺少 Thunderstore 包标识。");
    }

    // 纯后端：归一化在 Rust 侧完成，前端直接渲染。
    const detail = await invoke<IThirdPartyModDetail>("thunderstore_detail", {
        namespace: normalizedNamespace,
        name: normalizedName,
    });

    if (!detail?.routeId) {
        throw new Error("读取 Thunderstore 详情失败。");
    }

    return detail;
}

export interface IThunderstoreCacheStatus {
    cached: boolean;
    ageSecs: number | null;
}

// 查询后端 Thunderstore 列表缓存状态（未缓存返回 cached:false）。
export async function fetchThunderstoreCacheStatus(
    community: string,
): Promise<IThunderstoreCacheStatus> {
    interface IThunderstoreCacheStatusPayload {
        cached?: unknown;
        ageSecs?: unknown;
    }
    const status = await invoke<IThunderstoreCacheStatusPayload>(
        "thunderstore_cache_status",
        { community: community.trim() },
    );
    return {
        cached: status.cached === true,
        ageSecs: typeof status.ageSecs === "number" ? status.ageSecs : null,
    };
}

// 手动刷新：强制回源并覆盖后端缓存，返回刷新后的全量包数（供提示用）。
export async function refreshThunderstoreCache(
    community: string,
): Promise<number> {
    return invoke<number>("thunderstore_refresh", {
        community: community.trim(),
    });
}

async function fetchModIoList(
    game: ISupportedGames,
    query: IThirdPartyListQuery,
) {
    const gameId = Number(game.mod_io ?? 0);
    if (!gameId) {
        return emptyListResult(query);
    }
    if (!MOD_IO_KEY) {
        throw new Error("未读取到 MODID_KEY，请检查 .env 配置。");
    }

    const params = new URLSearchParams({
        api_key: MOD_IO_KEY,
        maturity_option: "0",
        _sort: getModIoSortValue(query),
        _limit: String(normalizePageSize(query.pageSize)),
        _offset: String(
            (normalizePage(query.page) - 1) * normalizePageSize(query.pageSize),
        ),
    });
    if (normalizeText(query.searchText)) {
        params.set("_q", normalizeText(query.searchText));
    }

    const response = await httpFetch(
        `${getModIoBaseUrl()}/games/${gameId}/mods?${params.toString()}`,
        {
            method: "GET",
            headers: {
                Accept: "application/json",
            },
        },
    );
    const payload = (await response.json()) as IModIoListResponse;

    if (!response.ok || !Array.isArray(payload.data)) {
        throw new Error("获取 Mod.io 列表失败。");
    }

    return {
        items: payload.data.map((item) => normalizeModIoMod(item, gameId)),
        page: normalizePage(query.page),
        pageSize: normalizePageSize(query.pageSize),
        totalCount: payload.result_total ?? payload.data.length,
        totalPages:
            (payload.result_total ?? 0) > 0
                ? Math.ceil(
                      (payload.result_total ?? 0) /
                          normalizePageSize(query.pageSize),
                  )
                : 0,
    } satisfies IThirdPartyModListResult;
}

function normalizeModIoMod(item: IModIo, gameId: number) {
    const primaryFile = item.modfile
        ? ({
              id: String(item.modfile.id),
              name: item.modfile.filename,
              version: item.modfile.version ?? "",
              size: item.modfile.filesize ?? 0,
              createdAt: buildIsoDate(item.modfile.date_added),
              downloadUrl: item.modfile.download?.binary_url ?? "",
              detailsUrl: item.profile_url ?? "",
          } satisfies IThirdPartyModFile)
        : null;

    return {
        source: "ModIo" as const,
        id: String(item.id),
        routeId: String(item.id),
        routeQuery: {
            source: "ModIo",
            gameId: String(gameId),
        },
        title: item.name,
        summary: item.summary ?? item.description_plaintext ?? "",
        author:
            item.submitted_by?.display_name_portal ||
            item.submitted_by?.username ||
            "",
        version: item.modfile?.version ?? "",
        website: item.profile_url ?? item.homepage_url ?? "",
        cover:
            item.logo?.thumb_640x360 ||
            item.logo?.thumb_320x180 ||
            item.logo?.original ||
            "",
        gallery: [
            item.logo?.original ?? "",
            ...(item.media?.images ?? []).map((media) => {
                return media.original || media.thumb_1280x720 || "";
            }),
        ].filter(Boolean),
        downloads: item.stats?.downloads_total ?? 0,
        likes: item.stats?.ratings_positive ?? 0,
        categories: [],
        tags: (item.tags ?? []).map((tag) => tag.name).filter(Boolean),
        createdAt: buildIsoDate(item.date_added),
        updatedAt: buildIsoDate(item.date_updated),
        nsfw: (item.maturity_option ?? 0) > 0,
        filesCount: item.modfile ? 1 : 0,
        primaryFile,
    } satisfies IThirdPartyModItem;
}

async function fetchModIoDetail(gameId: number, modId: number) {
    if (!gameId || !modId) {
        throw new Error("缺少 Mod.io 所需的游戏或 Mod 标识。");
    }
    if (!MOD_IO_KEY) {
        throw new Error("未读取到 MODID_KEY，请检查 .env 配置。");
    }

    const baseUrl = getModIoBaseUrl();
    const encodedKey = encodeURIComponent(MOD_IO_KEY);
    const [detailResponse, filesResponse] = await Promise.all([
        httpFetch(
            `${baseUrl}/games/${gameId}/mods/${modId}?api_key=${encodedKey}`,
            {
                method: "GET",
                headers: {
                    Accept: "application/json",
                },
            },
        ),
        httpFetch(
            `${baseUrl}/games/${gameId}/mods/${modId}/files?api_key=${encodedKey}`,
            {
                method: "GET",
                headers: {
                    Accept: "application/json",
                },
            },
        ),
    ]);
    const detail = (await detailResponse.json()) as IModIo;
    const filesPayload = (await filesResponse.json()) as {
        data?: IModIoModfile[];
    };

    if (!detailResponse.ok || !detail?.id) {
        throw new Error("读取 Mod.io 详情失败。");
    }

    if (!detail.modfile && filesPayload.data?.[0]) {
        detail.modfile = filesPayload.data[0];
    }

    const normalized = normalizeModIoMod(detail, gameId);
    const files = (filesPayload.data ?? [])
        .map((item) => {
            return {
                id: String(item.id),
                name: item.filename,
                version: item.version ?? "",
                size: item.filesize ?? 0,
                createdAt: buildIsoDate(item.date_added),
                downloadUrl: item.download?.binary_url ?? "",
                detailsUrl: detail.profile_url ?? "",
            } satisfies IThirdPartyModFile;
        })
        .filter((item) => item.downloadUrl);

    const description =
        detail.description || detail.description_plaintext || "";
    const descriptionFormat: ThirdPartyDescriptionFormat = description.includes(
        "<",
    )
        ? "html"
        : "text";

    return {
        ...normalized,
        filesCount: files.length,
        primaryFile: files[0] ?? normalized.primaryFile,
        description,
        descriptionFormat,
        files,
    } satisfies IThirdPartyModDetail;
}

async function fetchCurseForgeList(
    game: ISupportedGames,
    query: IThirdPartyListQuery,
) {
    const gameId = Number(game.curseforge ?? 0);
    if (!gameId) {
        return emptyListResult(query);
    }
    if (!CURSE_FORGE_KEY) {
        throw new Error("未读取到 CURSE_FORGE_KEY，请检查 .env 配置。");
    }

    const sortParams = getCurseForgeSortParams(query);
    const params = new URLSearchParams({
        gameId: String(gameId),
        sortField: sortParams.sortField,
        sortOrder: sortParams.sortOrder,
        pageSize: String(normalizePageSize(query.pageSize)),
        index: String(
            (normalizePage(query.page) - 1) * normalizePageSize(query.pageSize),
        ),
    });
    if (normalizeText(query.searchText)) {
        params.set("searchFilter", normalizeText(query.searchText));
    }

    const response = await httpFetch(
        `${CURSE_FORGE_BASE_URL}/v1/mods/search?${params.toString()}`,
        {
            method: "GET",
            headers: {
                Accept: "application/json",
                "x-api-key": CURSE_FORGE_KEY,
            },
        },
    );
    const payload = (await response.json()) as ICurseForgeListResponse;

    if (!response.ok || !Array.isArray(payload.data)) {
        throw new Error("获取 CurseForge 列表失败。");
    }

    return {
        items: payload.data.map((item) => normalizeCurseForgeMod(item)),
        page: normalizePage(query.page),
        pageSize: normalizePageSize(query.pageSize),
        totalCount: payload.pagination?.totalCount ?? payload.data.length,
        totalPages:
            (payload.pagination?.totalCount ?? 0) > 0
                ? Math.ceil(
                      (payload.pagination?.totalCount ?? 0) /
                          normalizePageSize(query.pageSize),
                  )
                : 0,
    } satisfies IThirdPartyModListResult;
}

function normalizeCurseForgeMod(item: ICurseForgeMod) {
    const latestFile = item.latestFiles.find((file) => {
        return Boolean(file.isAvailable && file.downloadUrl);
    });
    const primaryFile = latestFile
        ? ({
              id: String(latestFile.id),
              name: latestFile.displayName || latestFile.fileName,
              version: latestFile.displayName || latestFile.fileName,
              size: latestFile.fileLength ?? 0,
              createdAt: latestFile.fileDate ?? "",
              downloadUrl: normalizeCurseForgeDownloadUrl(
                  latestFile.downloadUrl,
              ),
              detailsUrl: item.links?.websiteUrl ?? "",
          } satisfies IThirdPartyModFile)
        : null;

    return {
        source: "CurseForge" as const,
        id: String(item.id),
        routeId: String(item.id),
        routeQuery: {
            source: "CurseForge",
        },
        title: item.name,
        summary: item.summary ?? "",
        author: item.authors?.[0]?.name ?? "",
        version: latestFile?.displayName || latestFile?.fileName || "",
        website: item.links?.websiteUrl ?? "",
        cover: item.logo?.thumbnailUrl || item.logo?.url || "",
        gallery: [
            item.logo?.url ?? "",
            ...(item.screenshots ?? []).map((screenshot) => screenshot.url),
        ].filter(Boolean),
        downloads: item.downloadCount ?? 0,
        likes: item.thumbsUpCount ?? 0,
        categories: (item.categories ?? []).map((category) => category.name),
        tags: [],
        createdAt: item.dateCreated ?? "",
        updatedAt: item.dateModified ?? "",
        nsfw: false,
        filesCount: item.latestFiles.length,
        primaryFile,
    } satisfies IThirdPartyModItem;
}

async function fetchCurseForgeDetail(modId: number) {
    if (!modId) {
        throw new Error("缺少有效的 CurseForge Mod ID。");
    }
    if (!CURSE_FORGE_KEY) {
        throw new Error("未读取到 CURSE_FORGE_KEY，请检查 .env 配置。");
    }

    const [detailResponse, descriptionResponse] = await Promise.all([
        httpFetch(`${CURSE_FORGE_BASE_URL}/v1/mods/${modId}`, {
            method: "GET",
            headers: {
                Accept: "application/json",
                "x-api-key": CURSE_FORGE_KEY,
            },
        }),
        httpFetch(`${CURSE_FORGE_BASE_URL}/v1/mods/${modId}/description`, {
            method: "GET",
            headers: {
                Accept: "application/json",
                "x-api-key": CURSE_FORGE_KEY,
            },
        }),
    ]);
    const detailPayload =
        (await detailResponse.json()) as ICurseForgeDetailResponse;
    const descriptionPayload =
        (await descriptionResponse.json()) as ICurseForgeDescriptionResponse;

    if (!detailResponse.ok || !detailPayload.data?.id) {
        throw new Error("读取 CurseForge 详情失败。");
    }

    const normalized = normalizeCurseForgeMod(detailPayload.data);
    const files = detailPayload.data.latestFiles
        .filter((file) => Boolean(file.isAvailable && file.downloadUrl))
        .map((file) => {
            return {
                id: String(file.id),
                name: file.displayName || file.fileName,
                version: file.displayName || file.fileName,
                size: file.fileLength ?? 0,
                createdAt: file.fileDate ?? "",
                downloadUrl: normalizeCurseForgeDownloadUrl(file.downloadUrl),
                detailsUrl: normalized.website,
            } satisfies IThirdPartyModFile;
        });

    return {
        ...normalized,
        filesCount: files.length,
        primaryFile: files[0] ?? normalized.primaryFile,
        description: descriptionPayload.data ?? normalized.summary,
        descriptionFormat: "html",
        files,
    } satisfies IThirdPartyModDetail;
}

async function fetchGameBananaList(
    game: ISupportedGames,
    query: IThirdPartyListQuery,
) {
    const gameId = Number(game.gamebanana ?? 0);
    if (!gameId) {
        return emptyListResult(query);
    }

    if (query.sort !== "default") {
        const allItems = await fetchAllGameBananaMods(gameId, query.searchText);
        const normalizedItems = allItems.map((item) => {
            return normalizeGameBananaMod(item);
        });
        const sortedItems = sortThirdPartyListItems(
            normalizedItems,
            query.sort,
        );

        return paginateThirdPartyItems(sortedItems, query);
    }

    const params = new URLSearchParams({
        _nPage: String(normalizePage(query.page)),
        _nPerpage: String(normalizePageSize(query.pageSize)),
        _csvModelInclusions: "Mod",
        "_aFilters[Generic_Game]": String(gameId),
    });
    if (normalizeText(query.searchText)) {
        params.set(
            "_aFilters[Generic_Name]",
            `contains,${normalizeText(query.searchText)}`,
        );
    }

    const response = await httpFetch(
        `${GAMEBANANA_BASE_URL}/Mod/Index?${params.toString()}`,
        {
            method: "GET",
            headers: {
                Accept: "application/json",
            },
        },
    );
    const payload = (await response.json()) as IGameBananaListResponse;

    if (!response.ok || !Array.isArray(payload._aRecords)) {
        throw new Error("获取 GameBanana 列表失败。");
    }

    const totalCount =
        payload._aMetadata?._nRecordCount ?? payload._aRecords.length;
    return {
        items: payload._aRecords.map((item) => normalizeGameBananaMod(item)),
        page: normalizePage(query.page),
        pageSize: normalizePageSize(query.pageSize),
        totalCount,
        totalPages:
            totalCount > 0
                ? Math.ceil(totalCount / normalizePageSize(query.pageSize))
                : 0,
    } satisfies IThirdPartyModListResult;
}

function normalizeGameBananaMod(item: IGameBananaMod) {
    const primaryImage = item._aPreviewMedia?._aImages?.[0];
    const primaryFile = item._aFiles?.[0]
        ? ({
              id: String(item._aFiles[0]._idRow),
              name: item._aFiles[0]._sFile,
              version: item._sVersion ?? "",
              size: item._aFiles[0]._nFilesize ?? 0,
              createdAt: buildIsoDate(item._aFiles[0]._tsDateAdded),
              downloadUrl:
                  item._sDownloadUrl || item._aFiles[0]._sDownloadUrl || "",
              detailsUrl: item._sProfileUrl,
          } satisfies IThirdPartyModFile)
        : null;

    return {
        source: "GameBanana" as const,
        id: String(item._idRow),
        routeId: String(item._idRow),
        routeQuery: {
            source: "GameBanana",
        },
        title: item._sName,
        summary: item._sText || "",
        author: item._aSubmitter?._sName ?? "",
        version: item._sVersion ?? "",
        website: item._sProfileUrl,
        cover: buildGameBananaMediaUrl(primaryImage),
        gallery: (item._aPreviewMedia?._aImages ?? [])
            .map((media) => buildGameBananaMediaUrl(media))
            .filter(Boolean),
        downloads: item._nDownloadCount ?? 0,
        likes: item._nLikeCount ?? 0,
        categories: [
            item._aRootCategory?._sName ?? "",
            item._aSuperCategory?._sName ?? "",
            item._aCategory?._sName ?? "",
        ].filter(Boolean),
        tags: (item._aTags ?? []).map((tag) => tag._sTitle).filter(Boolean),
        createdAt: buildIsoDate(item._tsDateAdded),
        updatedAt: buildIsoDate(item._tsDateModified),
        nsfw: item._sInitialVisibility !== "show",
        filesCount: item._aFiles?.length ?? 0,
        primaryFile,
    } satisfies IThirdPartyModItem;
}

async function fetchGameBananaDetail(routeId: string) {
    const modId = normalizeText(routeId);
    if (!modId) {
        throw new Error("缺少有效的 GameBanana Mod ID。");
    }

    const response = await httpFetch(
        `${GAMEBANANA_BASE_URL}/Mod/${modId}/ProfilePage`,
        {
            method: "GET",
            headers: {
                Accept: "application/json",
            },
        },
    );
    const payload = (await response.json()) as IGameBananaMod;

    if (!response.ok || !payload?._idRow) {
        throw new Error("读取 GameBanana 详情失败。");
    }

    const normalized = normalizeGameBananaMod(payload);
    const files = (payload._aFiles ?? []).map((item) => {
        return {
            id: String(item._idRow),
            name: item._sFile,
            version: payload._sVersion ?? "",
            size: item._nFilesize ?? 0,
            createdAt: buildIsoDate(item._tsDateAdded),
            downloadUrl: item._sDownloadUrl,
            detailsUrl: payload._sProfileUrl,
        } satisfies IThirdPartyModFile;
    });

    return {
        ...normalized,
        filesCount: files.length,
        primaryFile: files[0] ?? normalized.primaryFile,
        description: payload._sText || normalized.summary,
        descriptionFormat: "html",
        files,
    } satisfies IThirdPartyModDetail;
}
