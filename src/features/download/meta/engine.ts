// 下载器前置帮助（Wave 3 薄层）：目录/设置/probe 文件名。
// probe 系 nexus cookie 受保护链路，原样迁移零改动；任务操作一律走 facade。
import { invoke } from "@tauri-apps/api/core";
import { documentDir, join } from "@tauri-apps/api/path";
import { PersistentStore } from "@/lib/persistent-store";
import type { IDownloaderEnsureOptions, IDownloaderSettings } from "../types";

export function getDefaultSettings(): IDownloaderSettings {
    return {
        split: 8,
        maxConnectionPerServer: 8,
        minSplitSize: "1M",
    };
}

export function normalizeSettings(settings: Partial<IDownloaderSettings> = {}): IDownloaderSettings {
    const defaults = getDefaultSettings();

    return {
        split: Math.max(1, Math.round(settings.split ?? defaults.split)),
        maxConnectionPerServer: Math.max(
            1,
            Math.round(settings.maxConnectionPerServer ?? defaults.maxConnectionPerServer),
        ),
        minSplitSize: (settings.minSplitSize ?? defaults.minSplitSize).trim() || defaults.minSplitSize,
    };
}

export async function getStoredSettings(): Promise<IDownloaderSettings> {
    const settings = await PersistentStore.get<Partial<IDownloaderSettings>>(
        "nativeDownloaderSettings",
        getDefaultSettings(),
    );

    return normalizeSettings(settings ?? undefined);
}

export async function resolveDownloadDirectory(): Promise<string> {
    const explicitDirectory = (await PersistentStore.get<string>("downloadDirectory", ""))?.trim();

    if (explicitDirectory) {
        return explicitDirectory;
    }

    const storagePath = (await PersistentStore.get<string>("storagePath", ""))?.trim();
    const baseDirectory = storagePath || (await join(await documentDir(), "Gloss Mod Manager"));

    return await join(baseDirectory, "downloads", "mods");
}

// 进程内下载器无需启动服务端，保留签名以兼容调用方。
export async function ensureServer(_options: IDownloaderEnsureOptions = {}): Promise<void> {
    return;
}

// 从服务器获取文件名：HEAD 优先、Range 0-0 回退；headers/proxy 与下载链路一致（受保护）。
export async function probeFilename(
    url: string,
    headers: Record<string, string> = {},
    proxy: string | null = null,
): Promise<{ name: string; source: string; contentType?: string; totalBytes?: number }> {
    return invoke("dl_probe_filename", { url, headers, proxy });
}

export async function ensureFileName(
    url: string,
    fileName: string,
    headers: Record<string, string> = {},
    proxy: string | null = null,
): Promise<string> {
    const current = (fileName ?? "").trim();
    const tail = /\.([A-Za-z0-9]{1,16})$/u.exec(current)?.[1] ?? "";
    const hasExtension =
        /\.(tar\.(?:gz|xz|bz2)|zip|7z|rar|tar|gz|xz|bz2|exe|dll|pak|bin)$/iu.test(current) ||
        (tail !== "" && /[A-Za-z]/u.test(tail));
    if (hasExtension) {
        return current;
    }
    try {
        const probed = await probeFilename(url, headers, proxy);
        const probedName = (probed?.name ?? "").trim();
        if (probedName) {
            return probedName;
        }
    } catch {
        // 探测失败回退原名，不阻塞建任务。
    }
    return current;
}
