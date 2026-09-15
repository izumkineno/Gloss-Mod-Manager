import { basename, join } from "@tauri-apps/api/path";
import { ElMessage } from "element-plus-message";
import { FileHandler } from "@/lib/FileHandler";
import { Manager } from "@/lib/Manager";
import type { IClassifyMatcher } from "@/lib/mod-classify-rules";
import { classifyModType } from "@/lib/mod-classify-rules";

let dictionaryList: string[] = [];

async function loadDictionary() {
    if (dictionaryList.length > 0) {
        return dictionaryList;
    }

    const response = await fetch("/res/EldenRingDictionary.txt");
    const data = await response.text();
    dictionaryList = data
        .split(/\r?\n/u)
        .map((item) => item.trim())
        .filter((item) => item !== "");
    return dictionaryList;
}

/**
 * @description 艾尔登法环支持
 */
async function handleMod(
    mod: IModInfo,
    installPath: string,
    isInstall: boolean,
) {
    try {
        if (isInstall && !Manager.checkInstalled("ModEngine2", 197418)) {
            return false;
        }

        const dictionary = await loadDictionary();
        const modStorage = await Manager.getModStoragePath(mod.id);
        const { gameStorage } = await Manager.getContext();

        if (!modStorage || !gameStorage) {
            return false;
        }

        const result: IState[] = [];
        for (const file of mod.modFiles) {
            try {
                const source = await join(modStorage, file);
                if (!(await FileHandler.isFile(source))) {
                    continue;
                }

                const name = await basename(file);
                const matchedPath = dictionary.find((item) =>
                    item.includes(name),
                );
                if (!matchedPath) {
                    continue;
                }

                const target = await join(
                    gameStorage,
                    installPath,
                    matchedPath,
                );
                if (isInstall) {
                    const state = await FileHandler.copyFile(source, target);
                    result.push({ file, state });
                } else {
                    const state = await FileHandler.deleteFile(target);
                    result.push({ file, state });
                }
            } catch {
                result.push({ file, state: false });
            }
        }

        return result;
    } catch (error) {
        ElMessage.error(`错误: ${error}`);
        return false;
    }
}

export const supportedGames = async () =>
    ({
        GlossGameId: 275,
        steamAppID: 1245620,
        nexusMods: {
            game_domain_name: "eldenring",
            game_id: 4333,
        },
        installdir: await join("Elden Ring", "Game"),
        gameName: "ELDEN RING",
        gameExe: "eldenring.exe",
        archivePath: await join(
            await FileHandler.GetAppData(),
            "Roaming",
            "EldenRing",
        ),
        startExe: [
            {
                name: "启动 激活 Mod",
                exePath: "launchmod_eldenring.bat",
            },
            {
                name: "Steam 启动",
                cmd: "steam://rungameid/1245620",
            },
        ],
        gameCoverImg:
            "https://assets-mod.3dmgame.com/static/upload/game/620b6924d8c0d.png",
        modType: [
            {
                id: 1,
                name: "通用类型",
                installPath: await join("mods"),
                async install(mod) {
                    return handleMod(mod, this.installPath ?? "", true);
                },
                async uninstall(mod) {
                    return handleMod(mod, this.installPath ?? "", false);
                },
            },
            {
                id: 2,
                name: "Engine 2",
                installPath: "",
                async install(mod) {
                    return Manager.installByFileSibling(
                        mod,
                        this.installPath ?? "",
                        "modengine2_launcher.exe",
                        true,
                    );
                },
                async uninstall(mod) {
                    return Manager.installByFileSibling(
                        mod,
                        this.installPath ?? "",
                        "modengine2_launcher.exe",
                        false,
                    );
                },
            },
            {
                id: 3,
                name: "游戏根目录",
                installPath: "",
                async install(mod) {
                    return Manager.generalInstall(
                        mod,
                        this.installPath ?? "",
                        true,
                    );
                },
                async uninstall(mod) {
                    return Manager.generalUninstall(
                        mod,
                        this.installPath ?? "",
                        false,
                    );
                },
            },
            {
                id: 99,
                name: "未知",
                installPath: "",
                async install(_mod) {
                    ElMessage.warning("未知类型，请手动安装");
                    return false;
                },
                async uninstall(_mod) {
                    return true;
                },
            },
        ],
        async checkModType(mod) {
            const dictionary = await loadDictionary();
            // 字典条目为路径，归一化为 basename 匹配器；后端双侧小写，大小写无关
            const dictionaryMatchers: IClassifyMatcher[] = [];
            for (const dictionaryItem of dictionary) {
                dictionaryMatchers.push({
                    kind: "basename",
                    value: await basename(dictionaryItem),
                });
            }
            return classifyModType(
                mod.modFiles,
                [
                    {
                        id: 2,
                        anyOf: [{ kind: "basename", value: "modengine2_launcher.exe" }],
                    },
                    { id: 1, anyOf: dictionaryMatchers },
                ],
                99,
            );
        },
    }) as ISupportedGames;
