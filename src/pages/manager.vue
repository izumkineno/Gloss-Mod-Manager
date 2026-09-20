<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";
import { ElMessage } from "element-plus-message";
import { queueGlossModDownloadWithSelection } from "@/lib/download-file-selection";
import { installGmmPackage } from "@/lib/gmm-package";
import { checkGlossModUpdates } from "@/lib/gloss-mod-api";
import { useLaunchStore } from "@/stores/launch";
import {
    ARCHIVE_EXTENSIONS,
    importLocalModSources,
} from "@/lib/local-mod-import";
import ManagerPreloadList from "@/components/Manager/ManagerPreloadList.vue";
import {
    CheckCheck,
    CheckSquare,
    Download,
    FolderOpen,
    FolderPlus,
    Gamepad2,
    LayoutGrid,
    List as ListIcon,
    Package,
    RefreshCw,
    Search,
    Settings2,
    Shuffle,
    SquarePen,
    Trash2,
    Upload,
} from "lucide-vue-next";

interface IBatchEditForm {
    modAuthor: string;
    modType: number | string | "";
    modVersion: string;
    modWebsite: string;
    tagsText: string;
}

interface IDroppedImportSource {
    path: string;
    sourceType: "archive" | "folder" | "file" | "gmm";
}

interface IManagerGmmDialogExpose {
    openImportDialog: (filePath?: string) => Promise<void>;
    openExportDialog: () => void;
}

const manager = useManager();
const launchStore = useLaunchStore();
const router = useRouter();
const { managerGame, selectionMode, selectionIds } = storeToRefs(manager);
const settings = useSettings();
const { managerGridEnabled, storagePath } = storeToRefs(settings);
const disableSymlinkInstall = PersistentStore.useValue<boolean>(
    "disableSymlinkInstall",
    false,
);

const importLoading = ref(false);
const actioningIds = ref<number[]>([]);
const updateChecking = ref(false);
const fileDropActive = ref(false);
const dragImportRootRef = ref<HTMLElement | null>(null);
const managerGmmDialogRef = ref<IManagerGmmDialogExpose | null>(null);

const showBatchEditDialog = ref(false);
const batchEditForm = reactive<IBatchEditForm>({
    modAuthor: "",
    modType: "",
    modVersion: "",
    modWebsite: "",
    tagsText: "",
});

let unlistenNativeDragDrop: (() => void) | null = null;

function getErrorMessage(error: unknown) {
    if (error instanceof Error && error.message.trim()) {
        return error.message;
    }

    return "导入 Mod 失败，请查看控制台日志。";
}

async function consumePendingManagerLaunchActions() {
    while (true) {
        const action = launchStore.takeNextManagerAction();

        if (!action) {
            return;
        }

        if (action.type !== "open-gmm-import") {
            continue;
        }

        await managerGmmDialogRef.value?.openImportDialog(action.filePath);
    }
}

watch(manager.filteredMods, (mods) => {
    void mods;
    manager.retainVisibleSelection();
});

watch(
    [managerGame, storagePath, disableSymlinkInstall],
    async () => {
        await manager.refreshRuntimeData({
            storagePath: storagePath.value,
            closeSoftLinks: disableSymlinkInstall.value,
        });
    },
    { immediate: true },
);

function normalizeSlashes(filePath: string) {
    return filePath.replace(/\\+/gu, "/");
}

function getBaseName(filePath: string) {
    const normalized = normalizeSlashes(filePath);
    return normalized.split("/").pop() ?? filePath;
}

function getFileExtension(filePath: string) {
    const fileName = getBaseName(filePath);
    const index = fileName.lastIndexOf(".");

    if (index === -1) {
        return "";
    }

    return fileName.slice(index).toLowerCase();
}

function normalizeNativeDragPosition(position: { x: number; y: number }) {
    const scaleFactor = window.devicePixelRatio || 1;

    return {
        x: position.x / scaleFactor,
        y: position.y / scaleFactor,
    };
}

function isInDragImportZone(position: { x: number; y: number }) {
    const dragImportRoot = dragImportRootRef.value;

    if (!dragImportRoot) {
        return false;
    }

    const logicalPosition = normalizeNativeDragPosition(position);
    const bounds = dragImportRoot.getBoundingClientRect();

    return (
        logicalPosition.x >= bounds.left &&
        logicalPosition.x <= bounds.right &&
        logicalPosition.y >= bounds.top &&
        logicalPosition.y <= bounds.bottom
    );
}

function resolveDroppedSourceType(filePath: string, isDirectory: boolean) {
    if (isDirectory) {
        return "folder" as const;
    }

    const extension = getFileExtension(filePath);

    if (extension === ".gmm") {
        return "gmm" as const;
    }

    return ARCHIVE_EXTENSIONS.includes(
        extension.slice(1) as (typeof ARCHIVE_EXTENSIONS)[number],
    )
        ? ("archive" as const)
        : ("file" as const);
}

async function createDroppedImportSources(paths: string[]) {
    const uniquePaths = [
        ...new Set(paths.map((item) => item.trim()).filter(Boolean)),
    ];

    return Promise.all(
        uniquePaths.map(async (path) => {
            const isDirectory = await FileHandler.isDir(path);

            return {
                path,
                sourceType: resolveDroppedSourceType(path, isDirectory),
            } satisfies IDroppedImportSource;
        }),
    );
}

function resetFileDragState() {
    fileDropActive.value = false;
}

async function applyBatchEdit() {
    await manager.applyBatchEdit({
        modIds: selectionIds.value,
        modAuthor: batchEditForm.modAuthor,
        modType: batchEditForm.modType,
        modVersion: batchEditForm.modVersion,
        modWebsite: batchEditForm.modWebsite,
        tagsText: batchEditForm.tagsText,
    });
    showBatchEditDialog.value = false;
    ElMessage.success("已更新所选 Mod 信息。");
}

function getTypeDefinition(mod: IModInfo) {
    return manager.availableTypes.find(
        (item) => String(item.id) === String(mod.modType ?? ""),
    );
}

async function executeTypeInstall(
    type: IType,
    installConfig: ITypeInstall,
    mod: IModInfo,
    isInstall: boolean,
) {
    const resolvedIsInstall = installConfig.isInstall ?? isInstall;

    switch (installConfig.UseFunction) {
        case "generalInstall":
            return Manager.generalInstall(
                mod,
                type.installPath,
                installConfig.keepPath,
                installConfig.inGameStorage,
            );
        case "generalUninstall":
            return Manager.generalUninstall(
                mod,
                type.installPath,
                installConfig.keepPath,
                installConfig.inGameStorage,
            );
        case "installByFolder":
            return Manager.installByFolder(
                mod,
                type.installPath,
                installConfig.folderName ?? "",
                resolvedIsInstall,
                installConfig.include,
                installConfig.spare,
            );
        case "installByFile":
            return Manager.installByFile(
                mod,
                type.installPath,
                installConfig.fileName ?? "",
                resolvedIsInstall,
                installConfig.isExtname,
                installConfig.inGameStorage,
            );
        case "installByFileSibling":
            return Manager.installByFileSibling(
                mod,
                type.installPath,
                installConfig.fileName ?? "",
                resolvedIsInstall,
                installConfig.isExtname,
                installConfig.inGameStorage,
                installConfig.pass,
            );
        case "installByFolderParent":
            return Manager.installByFolderParent(
                mod,
                type.installPath,
                installConfig.folderName ?? "",
                resolvedIsInstall,
                installConfig.inGameStorage,
            );
        default:
            return false;
    }
}

function isOperationSuccessful(result: IState[] | boolean) {
    if (typeof result === "boolean") {
        return result;
    }

    return result.every((item) => item.state);
}

function startAction(modId: number) {
    if (!actioningIds.value.includes(modId)) {
        actioningIds.value = [...actioningIds.value, modId];
    }
}

function finishAction(modId: number) {
    actioningIds.value = actioningIds.value.filter((item) => item !== modId);
}

async function toggleInstall(mod: IModInfo, install: boolean) {
    const type = getTypeDefinition(mod);

    if (!type) {
        ElMessage.warning("当前 Mod 没有可用的类型定义，请先检查类型设置。");
        return;
    }

    const handler = install ? type.install : type.uninstall;
    startAction(mod.id);

    try {
        const result =
            typeof handler === "function"
                ? await handler.call(type, mod)
                : await executeTypeInstall(type, handler, mod, install);

        if (!isOperationSuccessful(result)) {
            // 报出首个失败文件 + 后端原话，替代通用兜底文案
            const firstFailure =
                typeof result === "boolean"
                    ? undefined
                    : result.find((item) => !item.state);
            const detail = firstFailure?.error?.trim();
            const failedCount =
                typeof result === "boolean" ? 0 : result.filter((item) => !item.state).length;
            const suffix =
                typeof result === "boolean" || failedCount <= 1
                    ? ""
                    : `（等 ${failedCount} 个文件）`;
            const failedFile = firstFailure?.file ?? "未知文件";
            const reason = detail ? `：${detail}` : "";
            const fallback = install
                ? "（无后端错误信息，请看控制台日志）"
                : "（目标文件可能被占用）";
            ElMessage.error(
                install
                    ? `安装 ${mod.modName} 失败：${failedFile}${suffix}${reason || fallback}`
                    : `卸载 ${mod.modName} 失败：${failedFile}${suffix}${reason || fallback}`,
            );
            return;
        }

        mod.isInstalled = install;
        await manager.saveManagerData();
        ElMessage.success(
            install ? `已安装 ${mod.modName}` : `已卸载 ${mod.modName}`,
        );
    } catch (error: unknown) {
        console.error("执行 Mod 操作失败");
        console.error(error);
        ElMessage.error(
            install
                ? `安装 ${mod.modName} 失败，请查看控制台日志。`
                : `卸载 ${mod.modName} 失败，请查看控制台日志。`,
        );
    } finally {
        finishAction(mod.id);
    }
}

async function importGmmFile() {
    await managerGmmDialogRef.value?.openImportDialog();
}

function openGmmExportDialog() {
    managerGmmDialogRef.value?.openExportDialog();
}

// ── 更新检查 ────────────────────────────────────────────────────────────────
async function checkForUpdates() {
    const glossMods = manager.managerModList.filter(
        (m) => typeof m.webId === "number" && m.webId > 0,
    );

    if (glossMods.length === 0) {
        ElMessage.info("当前没有来自 Gloss Mod 的 Mod 可检查更新。");
        return;
    }

    updateChecking.value = true;

    try {
        const webIds = glossMods
            .map((m) => m.webId)
            .filter((id): id is number => typeof id === "number" && id > 0);
        const updates = await checkGlossModUpdates(webIds, settings.glossModKey);

        if (updates.length === 0) {
            ElMessage.success("所有 Mod 已是最新版本。");
            return;
        }

        let queuedCount = 0;
        let skippedCount = 0;
        let existingCount = 0;

        for (const update of updates) {
            const localMod = glossMods.find((m) => m.webId === update.id);

            if (localMod) {
                const result = await queueGlossModDownloadWithSelection({
                    modId: update.id,
                    replaceLocalModId: localMod.id,
                    managerModList: manager.managerModList,
                    apiKey: settings.glossModKey,
                });

                if (!result) {
                    skippedCount += 1;
                    continue;
                }

                if (["created", "resumed", "retried"].includes(result.status)) {
                    queuedCount += 1;
                    continue;
                }

                existingCount += 1;
            }
        }

        if (queuedCount === 0 && existingCount === 0 && skippedCount > 0) {
            ElMessage.info("已取消本次更新下载选择。");
            return;
        }

        const summaryParts = [] as string[];

        if (queuedCount > 0) {
            summaryParts.push(`已加入 ${queuedCount} 个更新下载`);
        }

        if (existingCount > 0) {
            summaryParts.push(`${existingCount} 个已存在或已在本地`);
        }

        if (skippedCount > 0) {
            summaryParts.push(`跳过 ${skippedCount} 个`);
        }

        const summaryMessage =
            summaryParts.length > 0
                ? `${summaryParts.join("，")}。`
                : "没有可处理的更新任务。";

        if (queuedCount > 0) {
            ElMessage.success(summaryMessage);
            return;
        }

        ElMessage.info(summaryMessage);
    } catch (error: unknown) {
        console.error("检查更新失败");
        console.error(error);
        ElMessage.error("检查更新失败，请查看控制台日志。");
    } finally {
        updateChecking.value = false;
    }
}

// ── 批量操作（安装/卸载/移除） ─────────────────────────────────────────────
async function batchInstall(install: boolean) {
    const targets = manager.managerModList.filter((m) =>
        selectionIds.value.includes(m.id),
    );

    for (const mod of targets) {
        await toggleInstall(mod, install);
    }
}

async function batchRemove() {
    // 批量移除：复用 removeModRecord，逐个删除磁盘缓存目录 + 列表记录（与单条删除同语义，避免留孤儿目录）。
    const ids = [...selectionIds.value];
    const failures: string[] = [];
    for (const id of ids) {
        try {
            await manager.removeModRecord(id);
        } catch {
            // 单个失败不中断：记录名称继续删其余，最后统一提示。
            failures.push(manager.managerModList.find((m) => m.id === id)?.modName ?? String(id));
        }
    }
    selectionIds.value = [];
    manager.selectionMode = false;
    const removed = ids.length - failures.length;
    if (failures.length === 0) {
        ElMessage.success(`已移除 ${removed} 个 Mod（含本地缓存目录）。`);
    } else {
        ElMessage.error(`已移除 ${removed} 个，${failures.length} 个删除失败：${failures.join("、")}。`);
    }
}

async function openModRootFolder() {
    if (!manager.managerRoot) {
        ElMessage.warning("请先配置储存路径并选择游戏。");
        return;
    }

    await FileHandler.openFolder(manager.managerRoot);
}

async function openGameFolder() {
    if (!manager.managerGame?.gamePath) {
        ElMessage.warning("当前游戏还没有配置安装目录。");
        return;
    }

    await FileHandler.openFolder(manager.managerGame?.gamePath ?? "");
}

async function importModFolder() {
    if (!manager.managerGame || !manager.managerRoot) {
        ElMessage.warning("请先选择游戏并配置储存路径。");
        return;
    }

    const selected = await open({
        directory: true,
        multiple: true,
        title: "选择要导入的 Mod 文件夹",
    });

    if (!selected) {
        return;
    }

    const folders = Array.isArray(selected) ? selected : [selected];
    await importSources(folders, "folder");
}

async function importModArchive() {
    if (!manager.managerGame || !manager.managerRoot) {
        ElMessage.warning("请先选择游戏并配置储存路径。");
        return;
    }

    const selected = await open({
        directory: false,
        multiple: true,
        title: "选择要导入的压缩包",
        filters: [
            {
                name: "压缩包",
                extensions: [...ARCHIVE_EXTENSIONS],
            },
        ],
    });

    if (!selected) {
        return;
    }

    const files = Array.isArray(selected) ? selected : [selected];
    await importSources(files, "archive");
}

async function importSources(
    sources: string[],
    sourceType: "archive" | "folder" | "file",
) {
    if (!manager.managerRoot) {
        return;
    }

    importLoading.value = true;

    try {
        const result = await importLocalModSources(
            sources.map((source) => ({
                path: source,
                sourceType,
                // FOMOD 包走安装向导：无 ModuleConfig.xml 时回调不触发，走整包。
                fomodSelection: (config) => useFomodWizardStore().startWizard(config),
            })),
        );

        ElMessage.success(
            result.importedCount > 0
                ? `成功导入 ${result.importedCount} 个 Mod。`
                : "没有导入任何 Mod，请检查源文件内容。",
        );
    } catch (error: unknown) {
        console.error("导入 Mod 失败");
        console.error(error);
        ElMessage.error(getErrorMessage(error));
    } finally {
        importLoading.value = false;
    }
}

async function importDroppedSources(sources: IDroppedImportSource[]) {
    const gmmFiles = sources
        .filter((item) => item.sourceType === "gmm")
        .map((item) => item.path);
    const archiveFiles = sources
        .filter((item) => item.sourceType === "archive")
        .map((item) => item.path);
    const folders = sources
        .filter((item) => item.sourceType === "folder")
        .map((item) => item.path);
    const looseFiles = sources
        .filter((item) => item.sourceType === "file")
        .map((item) => item.path);

    try {
        if (
            gmmFiles.length === 1 &&
            archiveFiles.length === 0 &&
            folders.length === 0 &&
            looseFiles.length === 0
        ) {
            await managerGmmDialogRef.value?.openImportDialog(gmmFiles[0]);
            return;
        }

        if (gmmFiles.length > 0) {
            importLoading.value = true;

            for (const filePath of gmmFiles) {
                await installGmmPackage({ filePath });
            }

            ElMessage.success(`成功导入 ${gmmFiles.length} 个 GMM 包。`);
        }

        if (archiveFiles.length > 0) {
            await importSources(archiveFiles, "archive");
        }

        if (folders.length > 0) {
            await importSources(folders, "folder");
        }

        if (looseFiles.length > 0) {
            await importSources(looseFiles, "file");
        }
    } finally {
        importLoading.value = false;
    }
}

async function handleNativeFileDrop(paths: string[]) {
    if (!manager.managerRoot || !manager.managerGame) {
        ElMessage.warning("请先选择游戏并配置储存路径。");
        return;
    }

    try {
        const droppedSources = await createDroppedImportSources(paths);

        if (droppedSources.length === 0) {
            ElMessage.warning("未能读取拖拽内容，请改用按钮选择文件或文件夹。");
            return;
        }

        await importDroppedSources(droppedSources);
    } catch (error: unknown) {
        console.error("处理拖拽导入内容失败");
        console.error(error);
        ElMessage.error("处理拖拽导入失败，请查看控制台日志。");
    }
}

onMounted(async () => {
    unlistenNativeDragDrop = await getCurrentWebviewWindow().onDragDropEvent(
        ({ payload }) => {
            if (payload.type === "leave") {
                resetFileDragState();
                return;
            }

            const inImportZone = isInDragImportZone(payload.position);

            if (payload.type === "enter" || payload.type === "over") {
                fileDropActive.value = inImportZone;
                return;
            }

            resetFileDragState();

            if (!inImportZone) {
                return;
            }

            void handleNativeFileDrop(payload.paths);
        },
    );

    await consumePendingManagerLaunchActions();
});

onUnmounted(() => {
    unlistenNativeDragDrop?.();
    unlistenNativeDragDrop = null;
});

watch(
    () => launchStore.pendingManagerActions.length,
    () => {
        void consumePendingManagerLaunchActions();
    },
);

function getTypeCount(typeId: number | string | 0) {
    if (typeId === 0) {
        return manager.managerModList.length;
    }

    return manager.managerModList.filter(
        (mod) => String(mod.modType ?? "") === String(typeId),
    ).length;
}

function openSettingsPage() {
    void router.push("/settings");
}

function openGamesPage() {
    void router.push("/games");
}
</script>
<template>
    <div ref="dragImportRootRef" class="relative flex h-[calc(100vh-120px)] flex-col gap-4 overflow-hidden">
        <Card v-if="!storagePath">
            <CardHeader>
                <CardTitle>先配置储存路径</CardTitle>
                <CardDescription>
                    管理页会从储存路径下的 mods/游戏名 目录读取本地 Mod 数据。
                </CardDescription>
            </CardHeader>
            <CardContent class="flex flex-wrap items-center gap-3">
                <Button @click="openSettingsPage">
                    <Settings2 class="h-4 w-4" />
                    前往设置
                </Button>
                <p class="text-sm text-muted-foreground">
                    当前未检测到储存路径，配置后即可开始管理本地 Mod。
                </p>
            </CardContent>
        </Card>

        <Card v-else-if="!manager.managerGame">
            <CardHeader>
                <CardTitle>先选择一个游戏</CardTitle>
                <CardDescription>
                    选择游戏后，管理页会自动读取对应的 Mod 目录并恢复本地列表。
                </CardDescription>
            </CardHeader>
            <CardContent class="flex flex-wrap items-center gap-3">
                <Button variant="outline" @click="openGamesPage">
                    <Gamepad2 class="h-4 w-4" />
                    打开游戏库
                </Button>
            </CardContent>
        </Card>

        <template v-else>
            <div class="flex min-h-0 flex-1 items-stretch gap-4 overflow-hidden">
                <div class="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden">
                    <Card class="flex min-h-0 flex-1 flex-col overflow-hidden">
                <CardContent class="flex shrink-0 flex-col gap-2 border-b py-3">
                    <div class="flex flex-wrap items-center gap-2">
                        <div class="flex flex-wrap items-center gap-2">
                            <DropdownMenu>
                                <DropdownMenuTrigger>
                                    <Button variant="secondary" size="sm">
                                        <FolderPlus class="h-4 w-4" />导入
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="start">
                                    <DropdownMenuItem @click="importModFolder">
                                        <FolderPlus class="h-4 w-4" />
                                        导入文件夹
                                    </DropdownMenuItem>
                                    <DropdownMenuItem @click="importModArchive">
                                        <FolderPlus class="h-4 w-4" />
                                        导入压缩包
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem @click="importGmmFile">
                                        <Package class="h-4 w-4" />
                                        导入 GMM 包
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                            <StartGame :game="manager.managerGame" />
                            <DropdownMenu>
                                <DropdownMenuTrigger>
                                    <Button variant="outline" size="sm">
                                        <IconMenu class="h-4 w-4" />
                                        更多
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" class="w-56">
                                    <DropdownMenuItem @click="manager.loadManagerData()">
                                        <RefreshCw class="h-4 w-4" />
                                        刷新
                                    </DropdownMenuItem>
                                    <DropdownMenuItem :disabled="updateChecking" @click="checkForUpdates">
                                        <Download class="h-4 w-4" />
                                        {{ updateChecking ? "检查中…" : "检查更新" }}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem @click="manager.selectionMode = !manager.selectionMode">
                                        <CheckSquare class="h-4 w-4" />
                                        多选
                                    </DropdownMenuItem>
                                    <DropdownMenuItem @click="managerGridEnabled = !managerGridEnabled">
                                        <component :is="managerGridEnabled ? ListIcon : LayoutGrid" class="h-4 w-4" />
                                        {{ managerGridEnabled ? "列表" : "网格" }}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem @click="manager.detailPanelOpen = !manager.detailPanelOpen">
                                        <SquarePen class="h-4 w-4" />
                                        {{ manager.detailPanelOpen ? "关闭详情栏" : "打开详情栏" }}
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem @click="openModRootFolder">
                                        <FolderOpen class="h-4 w-4" />
                                        打开 Mod 目录
                                    </DropdownMenuItem>
                                    <DropdownMenuItem @click="openGameFolder">
                                        <FolderOpen class="h-4 w-4" />
                                        打开游戏目录
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem :disabled="!manager.managerModList.length" @click="openGmmExportDialog">
                                        <Upload class="h-4 w-4" />
                                        导出 GMM 包
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                        <span class="shrink-0 text-xs text-muted-foreground">共 {{ manager.filteredMods.length }} 个 Mod</span>
                        <InputGroup>
                            <InputGroupInput
                                v-model="manager.search"
                                placeholder="搜索名称、作者、版本、标签或类型"
                            />
                            <InputGroupAddon>
                                <Search />
                            </InputGroupAddon>
                        </InputGroup>
                    </div>
                    <div class="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 text-sm no-scrollbar">
                        <Button
                            class="h-7 shrink-0 px-2.5 text-xs"
                            :variant="
                                manager.selectedType === 0
                                    ? 'default'
                                    : 'outline'
                            "
                            size="sm"
                            @click="manager.selectedType = 0"
                        >
                            全部 ({{ getTypeCount(0) }})
                        </Button>
                        <Button
                            class="shrink-0"
                            v-for="item in manager.availableTypes"
                            :key="item.id"
                            :variant="
                                manager.selectedType === item.id
                                    ? 'default'
                                    : 'outline'
                            "
                            size="sm"
                            @click="manager.selectedType = item.id"
                        >
                            {{ item.name }} ({{ getTypeCount(item.id) }})
                        </Button>
                        <CustomTypeDialog />
                    </div>
                    <ManagerTags />
                </CardContent>
                <div class="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
                    <ManagerPreloadList />
                    <ManagerList />
                    </div>
                    </Card>
                </div>
                <ModDetailPanel />
            </div>
            <Card v-if="manager.loadError">
                <CardContent
                    class="flex items-center justify-between gap-4 py-6"
                >
                    <p class="text-sm text-destructive">
                        {{ manager.loadError }}
                    </p>
                    <Button variant="outline" @click="manager.loadManagerData()"
                        >重试</Button
                    >
                </CardContent>
            </Card>
            <div
                v-else-if="manager.filteredMods.length === 0"
                class="rounded-lg border border-dashed px-6 py-16 text-center text-sm text-muted-foreground"
            >
                <p>当前没有匹配的 Mod。</p>
                <p class="mt-2">
                    你可以调整筛选条件，或从上方导入文件夹/压缩包来创建本地 Mod
                    条目。
                </p>
            </div>
            <!-- 多选操作工具栏 -->
            <div
                v-if="selectionMode"
                class="sticky bottom-4 z-10 flex flex-wrap items-center gap-2 rounded-lg border bg-background/90 px-4 py-2 shadow-md backdrop-blur"
            >
                <span class="text-sm text-muted-foreground">
                    已选 {{ selectionIds.length }} /
                    {{ manager.filteredMods.length }}
                </span>
                <Button
                    size="sm"
                    variant="ghost"
                    @click="manager.selectAllVisible()"
                >
                    <CheckCheck class="h-4 w-4" />
                    全选
                </Button>
                <Button
                    size="sm"
                    variant="ghost"
                    @click="manager.clearSelection()"
                >
                    取消
                </Button>
                <Button
                    size="sm"
                    variant="outline"
                    :disabled="!selectionIds.length"
                    @click="batchInstall(true)"
                >
                    <Shuffle class="h-4 w-4" />
                    批量安装
                </Button>
                <Button
                    size="sm"
                    variant="outline"
                    :disabled="!selectionIds.length"
                    @click="batchInstall(false)"
                >
                    批量卸载
                </Button>
                <Button
                    size="sm"
                    variant="outline"
                    :disabled="!selectionIds.length"
                    @click="showBatchEditDialog = true"
                >
                    <SquarePen class="h-4 w-4" />
                    批量编辑
                </Button>
                <Button
                    size="sm"
                    variant="destructive"
                    :disabled="!selectionIds.length"
                    @click="batchRemove"
                >
                    <Trash2 class="h-4 w-4" />
                    批量移除
                </Button>
            </div>

            <!-- 批量编辑 Dialog -->
            <Dialog v-model:open="showBatchEditDialog">
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>批量编辑 Mod 信息</DialogTitle>
                        <DialogDescription>
                            仅填写需要修改的字段，留空表示不修改。
                        </DialogDescription>
                    </DialogHeader>
                    <div class="grid gap-3 py-2">
                        <div class="grid grid-cols-1 items-center gap-3 sm:grid-cols-4">
                            <Label class="text-left sm:text-right">作者</Label>
                            <Input
                                v-model="batchEditForm.modAuthor"
                                class="sm:col-span-3"
                                placeholder="留空表示不修改"
                            />
                        </div>
                        <div class="grid grid-cols-1 items-center gap-3 sm:grid-cols-4">
                            <Label class="text-left sm:text-right">版本</Label>
                            <Input
                                v-model="batchEditForm.modVersion"
                                class="sm:col-span-3"
                                placeholder="留空表示不修改"
                            />
                        </div>
                        <div class="grid grid-cols-1 items-center gap-3 sm:grid-cols-4">
                            <Label class="text-left sm:text-right">网站</Label>
                            <Input
                                v-model="batchEditForm.modWebsite"
                                class="sm:col-span-3"
                                placeholder="留空表示不修改"
                            />
                        </div>
                        <div class="grid grid-cols-1 items-center gap-3 sm:grid-cols-4">
                            <Label class="text-left sm:text-right">标签</Label>
                            <Input
                                v-model="batchEditForm.tagsText"
                                class="sm:col-span-3"
                                placeholder="逗号分隔，留空表示不修改"
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            @click="showBatchEditDialog = false"
                            >取消</Button
                        >
                        <Button @click="applyBatchEdit">确定</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
            <ManagerGmmDialog ref="managerGmmDialogRef" />

            <Transition name="import-overlay">
                <div
                    v-if="fileDropActive"
                    class="pointer-events-none fixed inset-4 z-40 rounded-3xl border border-primary/30 bg-primary/6 shadow-[0_0_0_1px_hsl(var(--primary)/0.08),0_24px_80px_-32px_hsl(var(--primary)/0.45)]"
                />
            </Transition>
            <Transition name="import-hint">
                <div
                    v-if="fileDropActive"
                    class="pointer-events-none fixed left-6 bottom-6 z-50"
                >
                    <div
                        class="flex items-center gap-3 rounded-2xl border border-primary/25 bg-background/95 px-4 py-3 shadow-2xl backdrop-blur-md"
                    >
                        <div
                            class="manager-import-hint-icon flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground"
                        >
                            <Upload class="h-5 w-5" />
                        </div>
                        <div class="flex flex-col">
                            <span class="text-sm font-semibold text-foreground">
                                拖拽到这里导入
                            </span>
                            <span class="text-xs text-muted-foreground">
                                支持单文件、压缩包、文件夹与 GMM 包
                            </span>
                        </div>
                    </div>
                </div>
            </Transition>
        </template>
    </div>
</template>
<style scoped>
.import-overlay-enter-active,
.import-overlay-leave-active,
.import-hint-enter-active,
.import-hint-leave-active {
    transition:
        opacity 0.2s ease,
        transform 0.2s ease;
}

.import-overlay-enter-from,
.import-overlay-leave-to {
    opacity: 0;
    transform: scale(0.985);
}

.import-hint-enter-from,
.import-hint-leave-to {
    opacity: 0;
    transform: translateY(12px) scale(0.96);
}

.manager-import-hint-icon {
    animation: manager-import-pulse 1.6s ease-in-out infinite;
}

@keyframes manager-import-pulse {
    0%,
    100% {
        transform: scale(1);
        box-shadow: 0 0 0 0 hsl(var(--primary) / 0.3);
    }

    50% {
        transform: scale(1.06);
        box-shadow: 0 0 0 10px hsl(var(--primary) / 0);
    }
}
</style>
