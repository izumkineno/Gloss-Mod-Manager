// 手动建任务与引擎设置（Wave 3.6 机械抽取）：目录就绪/手动直建/下载设置保存。
// 与 download.vue 原实现逐行一致，只挪位置；probe 链路（ensureFileName）只挪调用位置零改动。
import { computed, ref } from "vue";
import { documentDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { ElMessage } from "element-plus-message";
import { FileHandler } from "@/lib/FileHandler";
import { PersistentStore } from "@/lib/persistent-store";
import { ensureFileName, ensureServer, getDefaultSettings, normalizeSettings } from "../meta/engine";
import { getDownloadFacade } from "../facade";
import type { IDownloaderEnsureOptions, IDownloaderSettings } from "../types";
import type { IGlossDownloadTaskMeta } from "@/lib/gloss-download";
import { getErrorMessage } from "./task-display";

export interface EngineDeps {
    storagePath: string;
    setTaskMeta: (gid: string, metadata: IGlossDownloadTaskMeta) => void;
    refreshTaskLists: (silent?: boolean) => Promise<void>;
    selectTask: (gid: string) => void;
}

// 下载目录与引擎设置状态（持久化键与原页面一致）。
export function useEngineSettings() {
    const disableSymlinkInstall = PersistentStore.useValue<boolean>(
        "disableSymlinkInstall",
        false,
    );
    const downloadDirectory = PersistentStore.useValue<string>(
        "downloadDirectory",
        "",
    );
    const downloadProxy = PersistentStore.useValue<string>("downloadProxy", "");
    const downloaderSettings = PersistentStore.useValue<IDownloaderSettings>(
        "nativeDownloaderSettings",
        getDefaultSettings(),
    );
    const defaultDownloadDirectory = ref("");

    const normalizedDownloaderSettings = computed(() =>
        normalizeSettings(downloaderSettings.value),
    );
    const resolvedDownloadDirectory = computed(
        () => downloadDirectory.value || defaultDownloadDirectory.value,
    );

    // 引擎建连参数：输出目录 + 分片配置。
    function buildEngineEnsureOptions(
        outputDirectory?: string,
    ): IDownloaderEnsureOptions {
        const engineSettings = normalizedDownloaderSettings.value;

        return {
            outputDirectory: outputDirectory || resolvedDownloadDirectory.value,
            split: engineSettings.split,
            maxConnectionPerServer: engineSettings.maxConnectionPerServer,
            minSplitSize: engineSettings.minSplitSize,
        };
    }

    // 默认下载目录：储存路径/downloads，无储存路径回退到文档目录。
    async function refreshDefaultDownloadDirectory(storagePath: string): Promise<void> {
        const baseDirectory =
            storagePath ||
            (await join(await documentDir(), "Gloss Mod Manager"));

        defaultDownloadDirectory.value = await join(baseDirectory, "downloads");
    }

    // 下载目录就绪：保证目录存在并返回路径。
    async function ensureDownloadDirectoryReady(): Promise<string> {
        if (!resolvedDownloadDirectory.value) {
            throw new Error("未能解析下载目录，请先选择一个目录。");
        }

        await FileHandler.createDirectory(resolvedDownloadDirectory.value);

        return resolvedDownloadDirectory.value;
    }

    // 内置引擎无需建连：只保证目录存在即 ready（ensureServer 为空实现，保留调用作兼容）。
    async function ensureEngineReady(): Promise<string> {
        const outputDirectory = await ensureDownloadDirectoryReady();

        await ensureServer(buildEngineEnsureOptions(outputDirectory));

        return outputDirectory;
    }

    // 目录选择弹窗：更新后刷新任务。
    async function selectDownloadDirectory(refresh: () => Promise<void>): Promise<void> {
        const selected = await open({
            directory: true,
            defaultPath: resolvedDownloadDirectory.value,
            title: "选择下载目录",
        });

        if (!selected) {
            return;
        }

        downloadDirectory.value = selected;
        await refresh();
        ElMessage.success("下载目录已更新。");
    }

    // 系统文件管理器打开下载目录。
    async function openDownloadDirectory(): Promise<void> {
        const directory = await ensureDownloadDirectoryReady();
        await FileHandler.openFolder(directory);
    }

    return {
        disableSymlinkInstall,
        downloadDirectory,
        downloadProxy,
        downloaderSettings,
        defaultDownloadDirectory,
        normalizedDownloaderSettings,
        resolvedDownloadDirectory,
        buildEngineEnsureOptions,
        refreshDefaultDownloadDirectory,
        ensureDownloadDirectoryReady,
        ensureEngineReady,
        selectDownloadDirectory,
        openDownloadDirectory,
    };
}

// 手动建任务弹窗状态。
export function useManualDownload() {
    const showManualDownloadDialog = ref(false);
    const manualDownloadUrl = ref("");
    const manualDownloadFileName = ref("");
    const manualDownloadCreating = ref(false);

    function openManualDownloadDialog(): void {
        manualDownloadUrl.value = "";
        manualDownloadFileName.value = "";
        showManualDownloadDialog.value = true;
    }

    return {
        showManualDownloadDialog,
        manualDownloadUrl,
        manualDownloadFileName,
        manualDownloadCreating,
        openManualDownloadDialog,
    };
}

// 手动链接直建任务：文件名空则内置探测补全（Content-Disposition > URL 尾段）。
export async function createManualDownloadTask(
    manual: ReturnType<typeof useManualDownload>,
    engine: Pick<ReturnType<typeof useEngineSettings>, "ensureEngineReady" | "downloadProxy">,
    deps: EngineDeps,
): Promise<void> {
    const url = manual.manualDownloadUrl.value.trim();

    if (!url) {
        ElMessage.warning("请先填写下载链接。");
        return;
    }

    manual.manualDownloadCreating.value = true;

    try {
        const outputDirectory = await engine.ensureEngineReady();
        const trimmedProxy = (engine.downloadProxy.value ?? "").trim();
        let fileName = manual.manualDownloadFileName.value.trim();
        fileName = await ensureFileName(url, fileName, {}, trimmedProxy || null);

        if (!fileName) {
            throw new Error("无法确定文件名，请手动填写。");
        }

        // Wave 3：手动建任务走 facade.enqueue。
        const gid = await getDownloadFacade().enqueue({ url, dir: outputDirectory, fileName });
        const now = new Date().toISOString();

        deps.setTaskMeta(gid, {
            sourceType: "Customize",
            modTitle: fileName,
            fileName,
            downloadUrl: url,
            createdAt: now,
            taskStatus: "waiting",
            updatedAt: now,
        });

        ElMessage.success(`已添加 ${fileName} 到下载队列。`);
        manual.showManualDownloadDialog.value = false;
        manual.manualDownloadUrl.value = "";
        manual.manualDownloadFileName.value = "";
        await deps.refreshTaskLists();
        deps.selectTask(gid);
    } catch (error: unknown) {
        ElMessage.error(getErrorMessage(error));
    } finally {
        manual.manualDownloadCreating.value = false;
    }
}

// 下载设置弹窗状态。
export function useDownloaderSettingsDialog() {
    const showDownloaderSettingsDialog = ref(false);
    const downloaderSettingsDraft = ref<IDownloaderSettings>(
        getDefaultSettings(),
    );
    const downloadProxyDraft = ref("");

    function openDownloaderSettingsDialog(
        downloaderSettings: { value: IDownloaderSettings },
        downloadProxy: { value: string },
    ): void {
        downloaderSettingsDraft.value = normalizeSettings(downloaderSettings.value);
        downloadProxyDraft.value = downloadProxy.value ?? "";
        showDownloaderSettingsDialog.value = true;
    }

    // 内置引擎无服务端：保存即对后续新建任务生效，无需重启。
    async function saveDownloaderSettings(
        downloaderSettings: { value: IDownloaderSettings },
        downloadProxy: { value: string },
    ): Promise<void> {
        downloaderSettings.value = normalizeSettings(downloaderSettingsDraft.value);
        downloadProxy.value = (downloadProxyDraft.value ?? "").trim();
        showDownloaderSettingsDialog.value = false;
        ElMessage.success("下载配置已保存，对后续新建任务生效。");
    }

    return {
        showDownloaderSettingsDialog,
        downloaderSettingsDraft,
        downloadProxyDraft,
        openDownloaderSettingsDialog,
        saveDownloaderSettings,
    };
}
