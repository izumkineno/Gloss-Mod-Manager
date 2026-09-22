/**
 * 管理相关
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ElMessage } from "element-plus-message";
import { FileHandler } from "@/lib/FileHandler";
import { Log } from "@/lib/log";
import { dirname, join } from "@tauri-apps/api/path";

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
    ): Promise<Map<string, { ok: boolean; error?: string }>> {
        const states = new Map<string, { ok: boolean; error?: string }>();
        if (items.length === 0) {
            return states;
        }
        const caller = new Error().stack?.split("\n")[2]?.trim() ?? "unknown";
        const startedAt = Date.now();
        try {
            const result = await invoke<IInstallFileState[]>(
                "mod_install_batch",
                {
                    // 后端签名 mod_install_batch(req: InstallBatch)，整包必须包在 req 下
                    req: {
                        batchId: Manager.createBatchId(),
                        allowedRoots,
                        items,
                        linkFallbackCopy,
                    },
                },
            );
            for (const item of result) {
                states.set(item.file, { ok: item.ok, error: item.error });
            }
            const failed = result.filter((item) => !item.ok).length;
            void Log.info(`[安装] batch 完成：调用方=${caller} 总数=${items.length} 失败=${failed} 耗时=${Date.now() - startedAt}ms`);
            const firstFailed = result.find((item) => !item.ok);
            if (firstFailed) {
                void Log.warn(`[安装] 首个失败项：file=${firstFailed.file} error=${firstFailed.error ?? "unknown"}`);
            }
        } catch (error) {
            // 后端不可达等整批异常：每项记 false，并带上整批异常原话
            const message = error instanceof Error ? error.message : String(error);
            for (const item of items) {
                states.set(item.file, { ok: false, error: message });
            }
            void Log.error(`[安装] batch 整批异常：调用方=${caller} 总数=${items.length} 耗时=${Date.now() - startedAt}ms error=${message}`);
        }
        return states;
    }


    private static context: Partial<IManagerContext> = {};


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
        const startedAt = Date.now();
        void Log.info(`[安装] generalInstall 开始：mod=${mod.modName} 文件数=${mod.modFiles.length} keepPath=${keepPath}`);
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
        // 路径拼接纯字符串完成：join/basename 每次都是 IPC，700 文件时数千次往返；分隔符用 /，后端 lexical 归一化
        const sep = modStorage.includes("\\") || targetRoot.includes("\\") ? "\\" : "/";
        const trimEnd = (p: string) => (p.endsWith("/") || p.endsWith("\\") ? p.slice(0, -1) : p);
        const base = (p: string) => p.split(/[/\\]/).pop() ?? p;
        const root = trimEnd(modStorage);
        const out = trimEnd(targetRoot);
        const slots: Array<{ file: string; item: IInstallItem | null }> = [];
        for (const item of mod.modFiles) {
            const rel = item.replace(/^[/\\]+/, "");
            const norm = rel.replace(/\//g, sep);
            const source = `${root}${sep}${norm}`;
            const target = keepPath ? `${out}${sep}${norm}` : `${out}${sep}${base(item)}`;
            slots.push({
                file: item,
                item: { file: item, src: source, dst: target, op: "copy", backup: "gmmback" },
            });
        }
        const states = await Manager.runInstallBatch(
            slots.filter((slot) => slot.item !== null).map((slot) => slot.item!),
            [modStorage, targetRoot],
            false,
        );
        const okCount = slots.filter((slot) => states.get(slot.file)?.ok).length;
        void Log.info(`[安装] generalInstall 完成：mod=${mod.modName} 成功=${okCount}/${slots.length} 总耗时=${Date.now() - startedAt}ms`);
        return slots.map((slot) => {
            const entry = states.get(slot.file);
            return {
                file: slot.file,
                state: slot.item === null ? false : (entry?.ok ?? false),
                error: entry?.error,
            };
        });
    }

    // 多 mod 批量卸载：一次 context + 纯字符串拼全量 slots + 一次 batch invoke。
    // file key 用 `modId/rel` 隔离（同名文件跨 mod 不冲突），返回按 mod 分组。
    public static async generalBatchUninstall(
        mods: Array<{ mod: IModInfo; installPath: string; keepPath?: boolean; inGameStorage?: boolean }>,
    ): Promise<Map<number, IState[]>> {
        const startedAt = Date.now();
        const grouped = new Map<number, IState[]>();
        if (mods.length === 0) return grouped;
        void Log.info(`[卸载] batch卸载开始：mods=${mods.length} 文件总数=${mods.reduce((n, m) => n + m.mod.modFiles.length, 0)}`);
        const { modStorage, gameStorage } = await Manager.getContext();
        if (!modStorage) {
            ElMessage.warning("未设置 Mod 储存目录，无法执行安装或卸载。请先选择当前游戏并配置储存路径。");
            for (const { mod } of mods) grouped.set(Number(mod.id), Manager.createFailureState(mod));
            return grouped;
        }
        if (!gameStorage) {
            ElMessage.warning("未设置游戏目录，无法执行安装或卸载。请先选择当前游戏并确认游戏路径。");
        }
        // 按 (installPath, inGameStorage) 分组算 targetRoot：同组共享，减少 getContext 调用（已一次取好，纯字符串）。
        const rootCache = new Map<string, string | null>();
        const rootOf = (installPath: string, inGame: boolean): string | null => {
            // 绝对路径（盘符/前导斜杠）直接用，与 tauri join 语义一致；相对才拼 gameStorage。
            if (/^[a-zA-Z]:[/\\]/.test(installPath) || installPath.startsWith("/") || installPath.startsWith("\\")) {
                return installPath;
            }
            const key = `${inGame ? "g" : "p"}:${installPath}`;
            if (!rootCache.has(key)) {
                rootCache.set(key, !inGame ? installPath : gameStorage ? `${gameStorage.replace(/[/\\]+$/, "")}/${installPath.replace(/^[/\\]+/, "")}` : null);
            }
            return rootCache.get(key) ?? null;
        };
        const usep = modStorage.includes("\\") ? "\\" : "/";
        const utrim = (p: string) => (p.endsWith("/") || p.endsWith("\\") ? p.slice(0, -1) : p);
        const ubase = (p: string) => p.split(/[/\\]/).pop() ?? p;
        const uroot = utrim(modStorage);
        const items: IInstallItem[] = [];
        const allowedRoots = new Set<string>([modStorage]);
        const keyOf = (modId: number | string, file: string) => `${modId}/${file}`;
        for (const { mod, installPath, keepPath = false, inGameStorage = true } of mods) {
            const targetRoot = rootOf(installPath, inGameStorage);
            if (targetRoot === null) {
                grouped.set(Number(mod.id), Manager.createFailureState(mod));
                continue;
            }
            allowedRoots.add(targetRoot);
            const uout = utrim(targetRoot);
            const mroot = `${uroot}${usep}${mod.id}`;
            for (const file of mod.modFiles) {
                const rel = file.replace(/^[/\\]+/, "");
                const norm = rel.replace(/\//g, usep);
                const target = keepPath ? `${uout}${usep}${norm}` : `${uout}${usep}${ubase(file)}`;
                items.push({ file: keyOf(mod.id, file), src: `${mroot}${usep}${norm}`, dst: target, op: "remove", backup: "gmmback" });
            }
        }
        const states = await Manager.runInstallBatch(items, [...allowedRoots], false);
        for (const { mod } of mods) {
            if (grouped.has(Number(mod.id))) continue;
            grouped.set(Number(mod.id), mod.modFiles.map((file) => {
                const entry = states.get(keyOf(mod.id, file));
                return { file, state: entry?.ok ?? false, error: entry?.error };
            }));
        }
        const okMods = [...grouped.values()].filter((list) => list.every((s) => s.state)).length;
        void Log.info(`[卸载] batch卸载完成：mods=${mods.length} 全成功=${okMods} 总耗时=${Date.now() - startedAt}ms`);
        return grouped;
    }

    // 一般卸载
    public static async generalUninstall(
        mod: IModInfo,
        installPath: string,
        keepPath: boolean = false,
        inGameStorage: boolean = true,
    ): Promise<IState[]> {
        const startedAt = Date.now();
        void Log.info(`[卸载] generalUninstall 开始：mod=${mod.modName} 文件数=${mod.modFiles.length}`);
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
        // 源检查已搬进后端 op_remove：前端不再逐文件 fileExists（700 文件=700 次 IPC 往返），只拼路径、一次 invoke
        const usep = modStorage.includes("\\") || targetRoot.includes("\\") ? "\\" : "/";
        const utrim = (p: string) => (p.endsWith("/") || p.endsWith("\\") ? p.slice(0, -1) : p);
        const ubase = (p: string) => p.split(/[/\\]/).pop() ?? p;
        const uroot = utrim(modStorage);
        const uout = utrim(targetRoot);
        const slots: Array<{ file: string; item: IInstallItem | null }> = [];
        for (const item of mod.modFiles) {
            const rel = item.replace(/^[/\\]+/, "");
            const norm = rel.replace(/\//g, usep);
            const source = `${uroot}${usep}${norm}`;
            const target = keepPath ? `${uout}${usep}${norm}` : `${uout}${usep}${ubase(item)}`;
            slots.push({
                file: item,
                item: { file: item, src: source, dst: target, op: "remove", backup: "gmmback" },
            });
        }
        const states = await Manager.runInstallBatch(
            slots.filter((slot) => slot.item !== null).map((slot) => slot.item!),
            [modStorage, targetRoot],
            false,
        );
        const result: IState[] = [];
        // 空目录收尾丢后台：每个 deleteEmptyFolders 都是数次串行 invoke，
        // 700 文件时数千次 IPC 会堵死前端事件循环，进度事件排不上（卡住→突然 100%）。
        // 后台运行时按目录去重，失败静默（残留空目录无害，下次卸载顺手带走）。
        const cleanupDirs = new Set<string>();
        for (const slot of slots) {
            if (slot.item === null) {
                result.push({ file: slot.file, state: false });
                continue;
            }
            const entry = states.get(slot.file);
            result.push({ file: slot.file, state: entry?.ok ?? false, error: entry?.error });
            if (entry?.ok) {
                // 纯字符串 dirname：dst 去尾段
                const dir = slot.item.dst.split(/[/\\]/).slice(0, -1).join(usep);
                if (dir) {
                    cleanupDirs.add(dir);
                }
            }
        }
        if (cleanupDirs.size > 0) {
            void (async () => {
                for (const dir of cleanupDirs) {
                    try {
                        await Manager.deleteEmptyFolders(dir);
                    } catch {
                        // 后台收尾失败静默。
                    }
                }
            })();
        }
        const okCount = result.filter((item) => item.state).length;
        void Log.info(`[卸载] generalUninstall 完成：mod=${mod.modName} 成功=${okCount}/${result.length} 总耗时=${Date.now() - startedAt}ms 后台收尾目录=${cleanupDirs.size}`);
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
        // 编排零 IPC：mod.modFiles 即存在性来源（导入时 collectRelative 登记），不再逐文件 join/fileExists；
        // basename/dirname/join 全换纯字符串拼接，分隔符用 /（后端 lexical 归一），与 generalInstall 同模式
        const fsep = modStorage.includes("\\") || targetRoot.includes("\\") ? "\\" : "/";
        const ftrim = (p: string) => (p.endsWith("/") || p.endsWith("\\") ? p.slice(0, -1) : p);
        const fbase = (p: string) => p.split(/[/\\]/).pop() ?? p;
        const froot = ftrim(modStorage);
        const fout = ftrim(targetRoot);
        const toOut = (rel: string) => `${fout}${fsep}${rel.replace(/\//g, fsep)}`;
        const slots: Array<{ file: string; item: IInstallItem | null; target: string }> = [];
        for (const item of mod.modFiles) {
            try {
                if (Manager.passFiles.includes(fbase(item))) {
                    continue;
                }

                const rel = item.replace(/^[/\\]+/, "");
                const source = `${froot}${fsep}${rel.replace(/\//g, fsep)}`;

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
                    ? toOut(relativeInstallPath)
                    : spare
                      ? toOut(rel)
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
            const entry = states.get(slot.file);
            result.push({ file: slot.file, state: entry?.ok ?? false, error: entry?.error });
            // 空目录收尾丢后台：deleteEmptyFolders 每层 4 次串行 IPC，前台 await 会堵死进度事件
            if (!isInstall && entry?.ok) {
                const dir = slot.target.split(/[/\\]/).slice(0, -1).join(fsep);
                if (dir) {
                    void Manager.deleteEmptyFolders(dir).catch(() => {});
                }
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

        // 零 IPC 编排：字符串匹配代替 compareFileName/basename IPC，dirname/join 纯字符串拼接
        const normExt = fileName.replace(/^\./u, "").toLowerCase();
        const wantBase = fileName.toLowerCase();
        const tailOf = (p: string) => p.split(/[/\\]/).pop() ?? p;
        const extOf = (p: string) => {
            const tail = tailOf(p);
            const dot = tail.lastIndexOf(".");
            return dot > 0 && dot < tail.length - 1 ? tail.slice(dot + 1).toLowerCase() : "";
        };
        const fsep2 = modStorage.includes("\\") || targetRoot.includes("\\") ? "\\" : "/";
        const ftrim2 = (p: string) => (p.endsWith("/") || p.endsWith("\\") ? p.slice(0, -1) : p);
        const sroot = ftrim2(modStorage);
        const sout = ftrim2(targetRoot);
        let folders: string[] = [];

        for (const item of mod.modFiles) {
            const matched = isExtname ? extOf(item) === normExt : tailOf(item).toLowerCase() === wantBase;

            if (matched) {
                // dirname(modStorage/item) 纯字符串：modStorage + item 去尾段
                const dirRel = item.split(/[/\\]/).slice(0, -1).join("/");
                folders.push(dirRel ? `${sroot}${fsep2}${dirRel.replace(/\//g, fsep2)}` : sroot);
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
        const pendingCleanup: string[] = [];
        for (const folder of folders) {
            const target = `${sout}${fsep2}${tailOf(folder)}`;
            if (isInstall) {
                if (linkMode) {
                    items.push({ file: folder, src: folder, dst: target, op: "link", backup: "linkback" });
                } else {
                    const entries = await FileHandler.getAllFilesInFolder(folder, true, true);
                    // entries 为 folder 下全路径：纯字符串切前缀代替 relativePath/join IPC
                    const nprefix = `${folder.replace(/[/\\]+$/u, "")}${fsep2}`;
                    const nprefixAlt = folder.replace(/[/\\]+$/u, "").replace(/\\/g, "/") + "/";
                    for (const entry of entries) {
                        const normEntry = entry.replace(/\\/g, "/");
                        let relative = normEntry.startsWith(nprefixAlt)
                            ? normEntry.slice(nprefixAlt.length)
                            : entry.startsWith(nprefix)
                              ? entry.slice(nprefix.length)
                              : tailOf(entry);
                        items.push({
                            file: `${folder}/${relative}`,
                            src: entry,
                            dst: `${target}${fsep2}${relative.replace(/\//g, fsep2)}`,
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
                    pendingCleanup.push(target.split(/[/\\]/).slice(0, -1).join(fsep2));
                }
            }
        }
        await Manager.runInstallBatch(items, [modStorage, targetRoot], closeSoftLinks);
        // 卸载空目录收尾丢后台，不堵主流程
        for (const dir of new Set(pendingCleanup)) {
            if (dir) {
                void Manager.deleteEmptyFolders(dir).catch(() => {});
            }
        }
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

        // 零 IPC：匹配/dirname 全纯字符串；去重照搬旧语义（files 内容 toString 比较）
        const sibExt = fileName.replace(/^\./u, "").toLowerCase();
        const sibWant = fileName.toLowerCase();
        const sibTail = (p: string) => p.split(/[/\\]/).pop() ?? p;
        const sibExtOf = (p: string) => {
            const tail = sibTail(p);
            const dot = tail.lastIndexOf(".");
            return dot > 0 && dot < tail.length - 1 ? tail.slice(dot + 1).toLowerCase() : "";
        };
        const sibSep = modStorage.includes("\\") || targetRoot.includes("\\") ? "\\" : "/";
        const sibTrim = (p: string) => (p.endsWith("/") || p.endsWith("\\") ? p.slice(0, -1) : p);
        const sibRoot = sibTrim(modStorage);
        let folders: Array<{ folder: string; files: string[] }> = [];
        for (const item of mod.modFiles) {
            const matched = isExtname ? sibExtOf(item) === sibExt : sibTail(item).toLowerCase() === sibWant;

            if (!matched) {
                continue;
            }

            if (pass.includes(sibTail(item).toLowerCase())) {
                continue;
            }

            const dirRel = item.split(/[/\\]/).slice(0, -1).join("/");
            const folder = dirRel ? `${sibRoot}${sibSep}${dirRel.replace(/\//g, sibSep)}` : sibRoot;
            folders.push({
                folder,
                files: await FileHandler.getAllFilesInFolder(folder, true, true),
            });
        }

        folders = folders.filter((entry, index) => {
            const matchedIndex = folders.findIndex(
                (other) => other.files.toString() === entry.files.toString(),
            );
            return matchedIndex === index;
        });


        if (folders.length === 0) {
            ElMessage.error(`未找到文件: ${fileName}, 请不要随意修改MOD类型!`);
            return false;
        }
        // 锚定位/去重/未找到报错在 TS；搬运一次 invoke（卸载清空调丢后台，照搬）
        const sibOut = sibTrim(targetRoot);
        const items: IInstallItem[] = [];
        const targets: string[] = [];
        for (const folder of folders) {
            // folder.files 为 folder 下全路径：纯字符串切前缀
            const fprefix = `${folder.folder.replace(/[/\\]+$/u, "")}${sibSep}`;
            const fprefixAlt = folder.folder.replace(/[/\\]+$/u, "").replace(/\\/g, "/") + "/";
            for (const file of folder.files) {
                if (Manager.passFiles.includes(sibTail(file))) {
                    continue;
                }

                const normFile = file.replace(/\\/g, "/");
                const relativeFile = normFile.startsWith(fprefixAlt)
                    ? normFile.slice(fprefixAlt.length)
                    : file.startsWith(fprefix)
                      ? file.slice(fprefix.length)
                      : sibTail(file);
                const target = `${sibOut}${sibSep}${relativeFile.replace(/\//g, sibSep)}`;

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
                const dir = target.split(/[/\\]/).slice(0, -1).join(sibSep);
                if (dir) {
                    void Manager.deleteEmptyFolders(dir).catch(() => {});
                }
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

        const psep = modStorage.includes("\\") || targetRoot.includes("\\") ? "\\" : "/";
        const ptrim = (p: string) => (p.endsWith("/") || p.endsWith("\\") ? p.slice(0, -1) : p);
        const proot = ptrim(modStorage);
        const pout = ptrim(targetRoot);
        let folders: string[] = [];

        for (const item of mod.modFiles) {
            const parts = FileHandler.pathToArray(item);
            const index = parts.findIndex(
                (part) => part.toLowerCase() === folderName.toLowerCase(),
            );

            if (index !== -1) {
                const targetPath = parts.slice(0, index).join("/");
                folders.push(targetPath ? `${proot}${psep}${targetPath.replace(/\//g, psep)}` : proot);
            }
        }

        folders = [...new Set(folders)];

        // 锚切分在 TS；恒建链/删链（不受 closeSoftLinks 控制，照搬），一次 invoke
        const items: IInstallItem[] = [];
        const targets: string[] = [];
        for (const folder of folders) {
            const tail = folder.split(/[/\\]/).pop() ?? folder;
            const target = `${pout}${psep}${tail}`;
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
                const dir = target.split(/[/\\]/).slice(0, -1).join(psep);
                if (dir) {
                    void Manager.deleteEmptyFolders(dir).catch(() => {});
                }
            }
        }
        return true;
    }

    public static async getCommonParentFolder(
        modStorage: string,
        paths: string[],
    ) {
        // 纯字符串：paths 恒为 modStorage 下全路径，切前缀取顶层目录名
        const normRoot = modStorage.replace(/[/\\]+$/u, "").replace(/\\/g, "/").toLowerCase();
        const csep = modStorage.includes("\\") ? "\\" : "/";
        const croot = modStorage.replace(/[/\\]+$/u, "");
        const topNames = new Set<string>();
        for (const item of paths) {
            const norm = item.replace(/\\/g, "/");
            const lower = norm.toLowerCase();
            const rel = lower.startsWith(`${normRoot}/`) ? norm.slice(normRoot.length + 1) : norm.replace(/^\/+/u, "");
            const top = rel.split("/")[0];
            if (top) {
                topNames.add(top);
            }
        }
        return [...topNames].map((name) => `${croot}${csep}${name.replace(/\//g, csep)}`);
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
