/**
 * 管理相关
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ElMessage } from "element-plus-message";
import { FileHandler } from "@/lib/FileHandler";
import { basename, dirname, join } from "@tauri-apps/api/path";

// 后端批量安装条目（src-tauri/src/fsops.rs InstallItem，camelCase）
interface IInstallItem {
    file: string;
    src: string;
    dst: string;
    op: "copy" | "link" | "mkdir" | "write_text" | "remove";
    backup: "gmmback" | "linkback" | "none";
    content?: string;
}

interface IInstallFileState {
    file: string;
    ok: boolean;
    error?: string;
}

interface IInstallProgress {
    batchId: string;
    done: number;
    total: number;
}

interface IManagerContext {
    modStorage: string;
    gameStorage: string;
    closeSoftLinks: boolean;
}

export class Manager {
    public static passFiles = [
        "README.md",
        "manifest.json",
        "icon.png",
        "CHANGELOG.md",
        "LICENSE",
    ];
    // 进度监听：懒启动单例，后端 mod-install-progress 事件扇出到订阅者，调用方无感知
    private static progressUnlisten: Promise<() => void> | null = null;
    private static progressHandlers = new Set<(progress: IInstallProgress) => void>();

    public static onInstallProgress(handler: (progress: IInstallProgress) => void) {
        Manager.progressHandlers.add(handler);
        Manager.ensureProgressListener();
        return () => {
            Manager.progressHandlers.delete(handler);
        };
    }

    private static ensureProgressListener() {
        if (!Manager.progressUnlisten) {
            Manager.progressUnlisten = listen<IInstallProgress>(
                "mod-install-progress",
                (event) => {
                    for (const handler of Manager.progressHandlers) {
                        handler(event.payload);
                    }
                },
            );
        }
    }

    private static createBatchId() {
        if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
            return crypto.randomUUID();
        }
        return `${Date.now()}-${Math.floor(Math.random() * 1_000_000_000)}`;
    }

    /**
     * 一次 invoke 执行一批文件操作，按 file 建索引回填。
     * 后端不可达等整批异常时（旧语义逐项记 false），调用方传入的每项都记 false。
     */
    private static async runInstallBatch(
        items: IInstallItem[],
        allowedRoots: string[],
        linkFallbackCopy: boolean,
    ): Promise<Map<string, boolean>> {
        const states = new Map<string, boolean>();
        if (items.length === 0) {
            return states;
        }
        try {
            const result = await invoke<IInstallFileState[]>(
                "mod_install_batch",
                {
                    batchId: Manager.createBatchId(),
                    allowedRoots,
                    items,
                    linkFallbackCopy,
                },
            );
            for (const item of result) {
                states.set(item.file, item.ok);
            }
        } catch {
            for (const item of items) {
                states.set(item.file, false);
            }
        }
        return states;
    }


    private static context: Partial<IManagerContext> = {};

    private static normalizeExtensionName(extension: string) {
        return extension.replace(/^\./u, "").toLowerCase();
    }

    private static async matchFileExtension(
        filePath: string,
        extension: string,
    ) {
        return (
            (await FileHandler.getFileExtension(filePath)) ===
            Manager.normalizeExtensionName(extension)
        );
    }

    private static async getStoreContext(): Promise<Partial<IManagerContext>> {
        const manager = useManager();
        const settings = useSettings();
        const gameName = manager.managerGame?.gameName || "";
        const modStorage =
            settings.storagePath && gameName
                ? await join(settings.storagePath, "mods", gameName)
                : manager.managerRoot || "";

        return {
            modStorage,
            gameStorage: manager.managerGame?.gamePath || "",
            closeSoftLinks: settings.closeSoftLinks,
        };
    }

    private static async resolveModStorage(modId: number | string) {
        const modStorage = await Manager.getModStoragePath(modId);

        if (modStorage) {
            return modStorage;
        }

        ElMessage.warning(
            "未设置 Mod 储存目录，无法执行安装或卸载。请先选择当前游戏并配置储存路径。",
        );
        return null;
    }

    /**
     * 从页面层注入当前运行所需的路径上下文。
     */
    public static configureContext(context: Partial<IManagerContext>) {
        Manager.context = {
            ...Manager.context,
            ...context,
        };
    }

    /**
     * 获取当前运行上下文，优先使用管理器 store，旧上下文仅作为兼容兜底。
     */
    public static async getContext(): Promise<IManagerContext> {
        const storeContext = await Manager.getStoreContext();

        return {
            modStorage:
                storeContext.modStorage || Manager.context.modStorage || "",
            gameStorage:
                storeContext.gameStorage || Manager.context.gameStorage || "",
            closeSoftLinks:
                storeContext.closeSoftLinks ??
                Manager.context.closeSoftLinks ??
                true,
        };
    }

    /**
     * 获取指定 Mod 在缓存中的根目录。
     */
    public static async getModStoragePath(modId: number | string) {
        const { modStorage } = await Manager.getContext();

        if (!modStorage) {
            return "";
        }

        return await join(modStorage, String(modId));
    }

    private static async resolveInstallRoot(
        installPath: string,
        inGameStorage: boolean,
    ) {
        if (!inGameStorage) {
            return installPath;
        }

        const { gameStorage } = await Manager.getContext();

        if (!gameStorage) {
            ElMessage.warning(
                "未设置游戏目录，无法执行安装或卸载。请先选择当前游戏并确认游戏路径。",
            );
            return null;
        }

        return await join(gameStorage, installPath);
    }

    private static createFailureState(mod: IModInfo) {
        return mod.modFiles.map((file) => ({
            file,
            state: false,
        }));
    }

    /**
     * 保存Mod信息
     * @param modList 列表数据
     * @param savePath 储存目录
     * @param fileName 文件名称
     */
    public static async saveModInfo(
        modList: IModInfo[] | ITag[],
        savePath: string,
        fileName: string = "mod.json",
    ) {
        const configPath = await join(savePath, fileName);
        const config = JSON.stringify(JSON.parse(JSON.stringify(modList)));

        await FileHandler.writeFile(configPath, config);
    }

    // 获取Mod信息
    public static async getModInfo(
        savePath: string,
        fileName = "mod.json",
    ): Promise<IModInfo[] | ITag[]> {
        const configPath = await join(savePath, fileName);
        await FileHandler.createDirectory(savePath);
        const config = await FileHandler.readFileSync(configPath, "[]");
        return JSON.parse(config) as IModInfo[] | ITag[];
    }

    // 删除Mod文件
    public static async deleteMod(folderPath: string) {
        if (!(await FileHandler.fileExists(folderPath))) {
            return;
        }

        await FileHandler.deleteFolder(folderPath);
    }

    /**
     * 一般安装 (复制文件到指定目录)
     * @param mod
     * @param installPath 安装路径
     * @param keepPath 是否保留路径
     * @returns
     */
    public static async generalInstall(
        mod: IModInfo,
        installPath: string,
        keepPath: boolean = false,
        inGameStorage: boolean = true,
    ): Promise<IState[]> {
        const modStorage = await Manager.resolveModStorage(mod.id);

        if (modStorage === null) {
            return Manager.createFailureState(mod);
        }

        const targetRoot = await Manager.resolveInstallRoot(
            installPath,
            inGameStorage,
        );

        if (targetRoot === null) {
            return Manager.createFailureState(mod);
        }

        // 编排在 TS（目标计算），执行一次 invoke：缺失源由后端报 false，不触碰目标，与旧语义一致
        const slots: Array<{ file: string; item: IInstallItem | null }> = [];
        for (const item of mod.modFiles) {
            try {
                const source = await join(modStorage, item);
                const target = keepPath
                    ? await join(targetRoot, item)
                    : await join(targetRoot, await basename(item));
                slots.push({
                    file: item,
                    item: { file: item, src: source, dst: target, op: "copy", backup: "gmmback" },
                });
            } catch {
                slots.push({ file: item, item: null });
            }
        }
        const states = await Manager.runInstallBatch(
            slots.filter((slot) => slot.item !== null).map((slot) => slot.item!),
            [modStorage, targetRoot],
            false,
        );
        return slots.map((slot) => ({
            file: slot.file,
            state: slot.item === null ? false : (states.get(slot.file) ?? false),
        }));
    }

    // 一般卸载
    public static async generalUninstall(
        mod: IModInfo,
        installPath: string,
        keepPath: boolean = false,
        inGameStorage: boolean = true,
    ): Promise<IState[]> {
        const modStorage = await Manager.resolveModStorage(mod.id);

        if (modStorage === null) {
            return Manager.createFailureState(mod);
        }

        const targetRoot = await Manager.resolveInstallRoot(
            installPath,
            inGameStorage,
        );

        if (targetRoot === null) {
            return Manager.createFailureState(mod);
        }

        // 卸载保留源存在性检查：源缺失即 false 且不碰目标（照搬旧语义）；其余一次 invoke
        const slots: Array<{ file: string; item: IInstallItem | null }> = [];
        for (const item of mod.modFiles) {
            try {
                const source = await join(modStorage, item);
                if (!(await FileHandler.fileExists(source))) {
                    slots.push({ file: item, item: null });
                    continue;
                }
                const target = keepPath
                    ? await join(targetRoot, item)
                    : await join(targetRoot, await basename(item));
                slots.push({
                    file: item,
                    item: { file: item, src: source, dst: target, op: "remove", backup: "gmmback" },
                });
            } catch {
                slots.push({ file: item, item: null });
            }
        }
        const states = await Manager.runInstallBatch(
            slots.filter((slot) => slot.item !== null).map((slot) => slot.item!),
            [modStorage, targetRoot],
            false,
        );
        const result: IState[] = [];
        for (const slot of slots) {
            if (slot.item === null) {
                result.push({ file: slot.file, state: false });
                continue;
            }
            result.push({ file: slot.file, state: states.get(slot.file) ?? false });
            await Manager.deleteEmptyFolders(await dirname(slot.item.dst));
        }
        return result;
    }

    // 检查插件是否已经安装
    public static checkInstalled(name: string, webId: number) {
        void name;
        void webId;
        return true;
    }

    /**
     * 以某个文件夹为分割 安装/卸载 文件
     * @param mod mod
     * @param installPath 安装路径
     * @param folderName 文件夹名称
     * @param isInstall 是否安装
     * @param include 是否包含文件夹
     * @param spare 是否保留其他文件
     * @returns
     */
    public static async installByFolder(
        mod: IModInfo,
        installPath: string,
        folderName: string | string[],
        isInstall: boolean,
        include: boolean = false,
        spare: boolean = false,
    ) {
        const result: IState[] = [];

        const modStorage = await Manager.resolveModStorage(mod.id);

        if (modStorage === null) {
            return result;
        }

        const targetRoot = await Manager.resolveInstallRoot(installPath, true);

        if (targetRoot === null) {
            return result;
        }

        // 注意：resolveInstallRoot(installPath, true) 写死 inGameStorage=true 是既有特例，照搬
        // 编排在 TS（锚匹配/passFiles 跳过/spare 兜底），执行一次 invoke；缺失与未命中项直接跳过（不入 result，照搬）
        const slots: Array<{ file: string; item: IInstallItem | null; target: string }> = [];
        for (const item of mod.modFiles) {
            try {
                if (Manager.passFiles.includes(await basename(item))) {
                    continue;
                }

                const source = await join(modStorage, item);

                if (!(await FileHandler.fileExists(source))) {
                    continue;
                }

                let relativeInstallPath: string | null = null;

                if (Array.isArray(folderName)) {
                    for (const folder of folderName) {
                        const matchedPath = FileHandler.getFolderFromPath(
                            item,
                            folder,
                            include,
                        );

                        if (matchedPath !== null) {
                            relativeInstallPath = matchedPath;
                            break;
                        }
                    }
                } else {
                    relativeInstallPath = FileHandler.getFolderFromPath(
                        item,
                        folderName,
                        include,
                    );
                }

                const target = relativeInstallPath
                    ? await join(targetRoot, relativeInstallPath)
                    : spare
                      ? await join(targetRoot, item)
                      : "";

                if (!target) {
                    continue;
                }

                slots.push({
                    file: item,
                    item: {
                        file: item,
                        src: source,
                        dst: target,
                        op: isInstall ? "copy" : "remove",
                        backup: "gmmback",
                    },
                    target,
                });
            } catch (error) {
                ElMessage.error(`错误: ${error}`);
            }
        }
        const states = await Manager.runInstallBatch(
            slots.map((slot) => slot.item!),
            [modStorage, targetRoot],
            false,
        );
        for (const slot of slots) {
            const state = states.get(slot.file) ?? false;
            result.push({ file: slot.file, state });
            if (!isInstall) {
                await Manager.deleteEmptyFolders(await dirname(slot.target));
            }
        }
        return result;
    }

    /**
     * 以某个文件为基础 将其父级目录软链 进行 安装/卸载
     * @param mod mod
     * @param installPath 安装路径
     * @param fileName 文件名称
     * @param isInstall 是否是安装
     * @param isExtname 是否按拓展名匹配 = false
     * @param inGameStorage 是否在游戏目录 = true
     * @param isLink 是否是软链 = true
     * @param commonParent 过滤掉相同路径的文件夹 = false
     */
    public static async installByFile(
        mod: IModInfo,
        installPath: string,
        fileName: string,
        isInstall: boolean,
        isExtname: boolean = false,
        inGameStorage: boolean = true,
        isLink: boolean = true,
        commonParent: boolean = false,
    ) {
        const modStorage = await Manager.resolveModStorage(mod.id);

        if (modStorage === null) {
            return false;
        }

        const targetRoot = await Manager.resolveInstallRoot(
            installPath,
            inGameStorage,
        );

        if (targetRoot === null) {
            return false;
        }

        const { closeSoftLinks } = await Manager.getContext();

        let folders: string[] = [];

        for (const item of mod.modFiles) {
            const matched = isExtname
                ? await Manager.matchFileExtension(item, fileName)
                : await FileHandler.compareFileName(item, fileName);

            if (matched) {
                folders.push(await dirname(await join(modStorage, item)));
            }
        }

        folders = [...new Set(folders)];

        if (commonParent) {
            folders = await Manager.getCommonParentFolder(modStorage, folders);
        }

        // 锚定位/去重/commonParent 归并在 TS；搬运一次 invoke。
        // 文件夹拷贝由前端按 fs_walk 展开成单文件项（与 copyFolder per-file .gmmback 语义一致且可逐项记态）；
        // 返回值照搬旧语义：逐项失败忽略，整体恒 true（异常才抛）。
        const items: IInstallItem[] = [];
        const linkMode = isLink && !closeSoftLinks;
        for (const folder of folders) {
            const target = await join(targetRoot, await basename(folder));
            if (isInstall) {
                if (linkMode) {
                    items.push({ file: folder, src: folder, dst: target, op: "link", backup: "linkback" });
                } else {
                    const entries = await FileHandler.getAllFilesInFolder(folder, true, true);
                    for (const entry of entries) {
                        const relative = await FileHandler.relativePath(folder, entry);
                        items.push({
                            file: `${folder}/${relative}`,
                            src: entry,
                            dst: await join(target, relative),
                            op: "copy",
                            backup: "gmmback",
                        });
                    }
                }
            } else {
                if (linkMode) {
                    items.push({ file: target, src: folder, dst: target, op: "remove", backup: "linkback" });
                } else {
                    await FileHandler.deleteFolder(target);
                }
                if (closeSoftLinks) {
                    await Manager.deleteEmptyFolders(await dirname(target));
                }
            }
        }
        await Manager.runInstallBatch(items, [modStorage, targetRoot], closeSoftLinks);
        return true;
    }

    /**
     * 以某个文件为基础, 将该文件同级的所有文件安装/卸载 Mod
     * @param mod mod
     * @param installPath 安装路径
     * @param fileName 文件名 | 拓展名
     * @param isInstall 是否是安装
     * @param isExtname 是否按拓展名匹配
     * @param inGameStorage 是否在游戏目录
     * @param pass 跳过的文件列表 (小写)
     * @returns
     */
    public static async installByFileSibling(
        mod: IModInfo,
        installPath: string,
        fileName: string,
        isInstall: boolean,
        isExtname: boolean = false,
        inGameStorage: boolean = true,
        pass: string[] = [],
    ) {
        const modStorage = await Manager.resolveModStorage(mod.id);

        if (modStorage === null) {
            return false;
        }

        const targetRoot = await Manager.resolveInstallRoot(
            installPath,
            inGameStorage,
        );

        if (targetRoot === null) {
            return false;
        }

        let folders: Array<{
            folder: string;
            files: string[];
        }> = [];

        for (const item of mod.modFiles) {
            const matched = isExtname
                ? await Manager.matchFileExtension(item, fileName)
                : await FileHandler.compareFileName(item, fileName);

            if (!matched) {
                continue;
            }

            if (pass.includes((await basename(item)).toLowerCase())) {
                continue;
            }

            const folder = await dirname(await join(modStorage, item));

            folders.push({
                folder,
                files: await FileHandler.getAllFilesInFolder(
                    folder,
                    true,
                    true,
                ),
            });
        }

        folders = folders.filter((item, index) => {
            const matchedIndex = folders.findIndex(
                (folder) => folder.files.toString() === item.files.toString(),
            );

            return matchedIndex === index;
        });

        if (folders.length === 0) {
            ElMessage.error(`未找到文件: ${fileName}, 请不要随意修改MOD类型!`);
            return false;
        }

        // 锚定位/去重/未找到报错在 TS；搬运一次 invoke（卸载附带逐项清空调，照搬）
        const items: IInstallItem[] = [];
        const targets: string[] = [];
        for (const folder of folders) {
            for (const file of folder.files) {
                if (Manager.passFiles.includes(await basename(file))) {
                    continue;
                }

                const relativeFile = await FileHandler.relativePath(
                    folder.folder,
                    file,
                );
                const target = await join(targetRoot, relativeFile);

                items.push({
                    file: `${folder.folder}/${relativeFile}`,
                    src: file,
                    dst: target,
                    op: isInstall ? "copy" : "remove",
                    backup: "gmmback",
                });
                if (!isInstall) {
                    targets.push(target);
                }
            }
        }
        await Manager.runInstallBatch(items, [modStorage, targetRoot], false);
        if (!isInstall) {
            for (const target of targets) {
                await Manager.deleteEmptyFolders(await dirname(target));
            }
        }
        return true;
    }

    /**
     * 以某个文件夹为基础，将其父级目录软链 进行 安装/卸载
     * @param mod mod
     * @param installPath 安装路径
     * @param folderName  文件夹名称
     * @param isInstall  是否安装
     * @param inGameStorage 是否在游戏目录
     * @returns
     */
    public static async installByFolderParent(
        mod: IModInfo,
        installPath: string,
        folderName: string,
        isInstall: boolean,
        inGameStorage: boolean = true,
    ) {
        const modStorage = await Manager.resolveModStorage(mod.id);

        if (modStorage === null) {
            return false;
        }

        const targetRoot = await Manager.resolveInstallRoot(
            installPath,
            inGameStorage,
        );

        if (targetRoot === null) {
            return false;
        }

        let folders: string[] = [];

        for (const item of mod.modFiles) {
            const parts = FileHandler.pathToArray(item);
            const index = parts.findIndex(
                (part) => part.toLowerCase() === folderName.toLowerCase(),
            );

            if (index !== -1) {
                const targetPath = parts.slice(0, index).join("/");
                folders.push(await join(modStorage, targetPath));
            }
        }

        folders = [...new Set(folders)];

        // 锚切分在 TS；恒建链/删链（不受 closeSoftLinks 控制，照搬），一次 invoke
        const items: IInstallItem[] = [];
        const targets: string[] = [];
        for (const folder of folders) {
            const target = await join(targetRoot, await basename(folder));
            items.push({
                file: folder,
                src: folder,
                dst: target,
                op: isInstall ? "link" : "remove",
                backup: "linkback",
            });
            if (!isInstall) {
                targets.push(target);
            }
        }
        // installByFolderParent 恒链：linkFallbackCopy=false，不退化拷贝
        await Manager.runInstallBatch(items, [modStorage, targetRoot], false);
        if (!isInstall) {
            for (const target of targets) {
                await Manager.deleteEmptyFolders(await dirname(target));
            }
        }
        return true;
    }

    public static async getCommonParentFolder(
        modStorage: string,
        paths: string[],
    ) {
        const relativePaths = await Promise.all(
            paths.map((item) => FileHandler.relativePath(modStorage, item)),
        );
        const topLevelFolderNames = relativePaths
            .map((item) => FileHandler.pathToArray(item)[0])
            .filter((item): item is string => Boolean(item));

        return Promise.all(
            [...new Set(topLevelFolderNames)].map(
                async (item) => await join(modStorage, item),
            ),
        );
    }

    // 删除空文件夹
    private static async deleteEmptyFolders(folderPath: string) {
        let currentPath = folderPath;

        while (currentPath) {
            if (!(await FileHandler.fileExists(currentPath))) {
                return;
            }

            const entries = await FileHandler.getAllFilesInFolder(
                currentPath,
                true,
                false,
                true,
            );

            if (entries.length > 0) {
                return;
            }

            const deleted = await FileHandler.deleteFolder(currentPath);

            if (!deleted) {
                return;
            }

            const parentPath = await dirname(currentPath);

            if (!parentPath || parentPath === currentPath) {
                return;
            }

            currentPath = parentPath;
        }
    }
}
