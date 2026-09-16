import { invoke } from "@tauri-apps/api/core";
import { documentDir, join } from "@tauri-apps/api/path";
import { PersistentStore } from "@/lib/persistent-store";
import type {
    IDownloaderGlobalStat,
    IDownloaderEnsureOptions,
    IDownloaderTask,
    IDownloaderSettings,
} from "@/lib/download-task-types";

// 进程内下载门面（传输层为 Rust 侧 simple_downloader，见 src-tauri/src/downloader.rs）。
// 任务语义：active/waiting/paused/error/complete；不再启动任何 sidecar。
export class Downloader {
    public static getDefaultSettings(): IDownloaderSettings {
        return {
            split: 8,
            maxConnectionPerServer: 8,
            minSplitSize: "1M",
        };
    }

    public static normalizeSettings(
        settings: Partial<IDownloaderSettings> = {},
    ): IDownloaderSettings {
        const defaults = Downloader.getDefaultSettings();

        return {
            split: Math.max(1, Math.round(settings.split ?? defaults.split)),
            maxConnectionPerServer: Math.max(
                1,
                Math.round(
                    settings.maxConnectionPerServer ??
                        defaults.maxConnectionPerServer,
                ),
            ),
            minSplitSize:
                (settings.minSplitSize ?? defaults.minSplitSize).trim() ||
                defaults.minSplitSize,
        };
    }

    public static async getStoredSettings() {
        const settings = await PersistentStore.get<
            Partial<IDownloaderSettings>
        >("nativeDownloaderSettings", Downloader.getDefaultSettings());

        return Downloader.normalizeSettings(settings ?? undefined);
    }

    public static async resolveDownloadDirectory() {
        const explicitDirectory = (
            await PersistentStore.get<string>("downloadDirectory", "")
        )?.trim();

        if (explicitDirectory) {
            return explicitDirectory;
        }

        const storagePath = (
            await PersistentStore.get<string>("storagePath", "")
        )?.trim();
        const baseDirectory =
            storagePath ||
            (await join(await documentDir(), "Gloss Mod Manager"));

        return await join(baseDirectory, "downloads", "mods");
    }

    // 进程内下载器无需启动服务端，保留签名以兼容调用方。
    public static async ensureServer(
        _options: IDownloaderEnsureOptions = {},
    ): Promise<void> {
        return;
    }

    public static async autoStartFromSettings(): Promise<void> {
        return;
    }

    public static async stopServer(): Promise<void> {
        return;
    }

    public static async restartServer(
        _options: IDownloaderEnsureOptions = {},
    ): Promise<void> {
        return;
    }

    public static async getVersion(_ensureServer: boolean = true) {
        return { version: "native-1.0", enabledFeatures: [] as string[] };
    }

    public static async getGlobalStat() {
        return invoke<IDownloaderGlobalStat>("dl_global_stat");
    }

    public static async tellActive() {
        return invoke<IDownloaderTask[]>("dl_tell_active");
    }

    public static async tellWaiting(offset: number = 0, count: number = 100) {
        return invoke<IDownloaderTask[]>("dl_tell_waiting", {
            offset,
            num: count,
        });
    }

    public static async tellStopped(offset: number = 0, count: number = 100) {
        return invoke<IDownloaderTask[]>("dl_tell_stopped", {
            offset,
            num: count,
        });
    }

    public static async tellStatus(gid: string) {
        return invoke<IDownloaderTask>("dl_tell_status", { gid });
    }

    // 入参键（dir/out/referer/user-agent/proxy 等）→ dl_enqueue 参数（仅消费实际使用的键）。
    public static async addUri(
        uris: string[],
        options: Record<string, string> = {},
    ) {
        const url = (uris[0] ?? "").trim();

        if (!url) {
            throw new Error("下载地址为空");
        }

        const dir =
            (options.dir ?? "").trim() ||
            (await Downloader.resolveDownloadDirectory());
        let fileName = (options.out ?? "").trim();

        const headers: Record<string, string> = {};

        if (options["user-agent"]) {
            headers["User-Agent"] = options["user-agent"];
        }

        if (options.referer) {
            headers["Referer"] = options.referer;
        }

        if (options.cookie) {
            headers["Cookie"] = options.cookie;
        }

        const proxy = (options["all-proxy"] ?? "").trim() || null;

        // 未指定 out 时从服务器获取文件名（Content-Disposition > 预签名参数 > URL 尾段）。
        if (!fileName) {
            const probed = await Downloader.probeFilename(url, headers, proxy);
            fileName = (probed.name ?? "").trim();
        }

        if (!fileName) {
            throw new Error("输出文件名为空");
        }

        const workers = Math.max(1, Math.round(Number(options.split) || 8));

        return invoke<string>("dl_enqueue", {
            url,
            dir,
            fileName,
            headers,
            workers,
            proxy,
        });
    }
    // 从服务器获取文件名：HEAD 优先、Range 0-0 回退；headers/proxy 与下载链路一致。
    public static async probeFilename(
        url: string,
        headers: Record<string, string> = {},
        proxy: string | null = null,
    ) {
        return invoke<{
            name: string;
            source: string;
            contentType?: string;
            totalBytes?: number;
        }>("dl_probe_filename", { url, headers, proxy });
    }
    // 文件名缺后缀时从服务器探测补全（Content-Disposition > 预签名参数 > URL 尾段 > Content-Type）。
    // 已带后缀直接返回，不发请求；探测失败回退原名，不抛错。
    public static async ensureFileName(
        url: string,
        fileName: string,
        headers: Record<string, string> = {},
        proxy: string | null = null,
    ) {
        const current = (fileName ?? "").trim();
        // 纯数字尾巴（如版本号 .0.4）不是后缀，必须继续探测。
        const tail = /\.([A-Za-z0-9]{1,16})$/u.exec(current)?.[1] ?? "";
        const hasExtension =
            /\.(tar\.(?:gz|xz|bz2)|zip|7z|rar|tar|gz|xz|bz2|exe|dll|pak|bin)$/iu.test(
                current,
            ) || (tail !== "" && /[A-Za-z]/u.test(tail));
        if (hasExtension) {
            return current;
        }
        try {
            const probed = await Downloader.probeFilename(url, headers, proxy);
            const probedName = (probed?.name ?? "").trim();
            if (probedName) return probedName;
        } catch {
            // 探测失败回退原名，不阻塞建任务。
        }
        return current;
    }

    public static async pause(gid: string, _force: boolean = false) {
        await invoke("dl_pause", { gid });
        return gid;
    }

    public static async unpause(gid: string) {
        await invoke("dl_resume", { gid });
        return gid;
    }

    // 停止任务但保留文件（文件清理仍由调用方负责）。
    public static async remove(gid: string, _force: boolean = false) {
        await invoke("dl_cancel", { gid, deleteFile: false });
        return gid;
    }

    public static async removeDownloadResult(gid: string) {
        await invoke("dl_forget", { gid });
        return gid;
    }

    public static async purgeDownloadResult() {
        const stopped = await Downloader.tellStopped(0, 1000);

        for (const task of stopped) {
            try {
                await invoke("dl_forget", { gid: task.gid });
            } catch {
                // 任务在遍历期间被清理属于正常竞态，直接跳过。
            }
        }

        return "OK";
    }

    public static async changeOption(
        gid: string,
        options: Record<string, string>,
    ) {
        const headers: Record<string, string> = {};

        if (options["user-agent"]) {
            headers["User-Agent"] = options["user-agent"];
        }

        if (options.referer) {
            headers["Referer"] = options.referer;
        }

        if (options.cookie) {
            headers["Cookie"] = options.cookie;
        }

        const workers = Math.max(1, Math.round(Number(options.split) || 8));
        const proxy = (options["all-proxy"] ?? "").trim() || null;

        await invoke("dl_change_option", { gid, headers, workers, proxy });
        return gid;
    }
}
