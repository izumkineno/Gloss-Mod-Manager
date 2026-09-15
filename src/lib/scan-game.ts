import { invoke } from "@tauri-apps/api/core";

// Steam 扫描下沉（src-tauri/src/fsops.rs）：一次 reg 查询 + 一次 VDF 解析，
// 替代逐游戏 reg spawn + 前端 parse + console 噪音。TS 只留薄门面与安装路径缓存。
export class ScanGame {
    private static cachedInstallPath: string | null | undefined;

    // 获取steam安装目录（进程内缓存，一次 reg 查询）。
    public static async getSteamInstallPath() {
        if (ScanGame.cachedInstallPath !== undefined) {
            return ScanGame.cachedInstallPath;
        }

        try {
            ScanGame.cachedInstallPath = await invoke<string | null>(
                "scan_steam_install_path",
            );
        } catch {
            ScanGame.cachedInstallPath = null;
        }

        return ScanGame.cachedInstallPath;
    }

    // 获取游戏安装目录（单次 invoke：后端一次 reg + 一次 VDF 解析）。
    public static async getSteamGamePath(
        steamAppID: number,
        installdir: string = "",
    ) {
        try {
            const gamePath = await invoke<string | null>("scan_steam_game", {
                appId: steamAppID,
                installdir,
            });

            return gamePath ?? undefined;
        } catch {
            return undefined;
        }
    }

    public static async GetLastSteamId32() {
        try {
            return await invoke<string>("scan_steam_last_user");
        } catch {
            return "";
        }
    }
}
