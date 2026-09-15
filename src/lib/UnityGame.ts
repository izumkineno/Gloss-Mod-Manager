/**
 * Unity 引擎 通用安装
 */

import { ElMessage } from "element-plus-message";
import { Manager } from "@/lib/Manager";
import { join } from "@tauri-apps/api/path";
import {
    UNITY_CLASSIFY_RULES,
    UNITY_ILCPP2_CLASSIFY_RULES,
    classifyModType,
} from "@/lib/mod-classify-rules";

export class UnityGame {
    static modType = async () =>
        [
            {
                id: 1,
                name: "BepInEx",
                installPath: "",
                async install(mod) {
                    return Manager.installByFileSibling(
                        mod,
                        this.installPath ?? "",
                        "winhttp.dll",
                        true,
                    );
                },
                async uninstall(mod) {
                    return Manager.installByFileSibling(
                        mod,
                        this.installPath ?? "",
                        "winhttp.dll",
                        false,
                    );
                },
            },
            {
                id: 2,
                name: "plugins",
                installPath: await join("BepInEx", "plugins"),
                async install(mod) {
                    return Manager.installByFolder(
                        mod,
                        this.installPath ?? "",
                        "plugins",
                        true,
                        false,
                        true,
                    );
                },
                async uninstall(mod) {
                    return Manager.installByFolder(
                        mod,
                        this.installPath ?? "",
                        "plugins",
                        false,
                        false,
                        true,
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
                        false,
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
                    ElMessage.warning("未知类型, 请手动安装");
                    return false;
                },
                async uninstall(_mod) {
                    return true;
                },
            },
        ] as ISupportedGames["modType"];

    static async checkModType(mod: IModInfo) {
        return classifyModType(mod.modFiles, UNITY_CLASSIFY_RULES, 99);
    }
}

export class UnityGameILCPP2 {
    static modType: ISupportedGames["modType"] = [
        {
            id: 1,
            name: "MelonLoader",
            installPath: "",
            async install(mod) {
                return Manager.installByFileSibling(
                    mod,
                    this.installPath ?? "",
                    "version.dll",
                    true,
                );
            },
            async uninstall(mod) {
                return Manager.installByFileSibling(
                    mod,
                    this.installPath ?? "",
                    "version.dll",
                    false,
                );
            },
        },
        {
            id: 2,
            name: "mods",
            installPath: "mods",
            async install(mod) {
                return Manager.installByFileSibling(
                    mod,
                    this.installPath ?? "",
                    "dll",
                    true,
                    true,
                );
            },
            async uninstall(mod) {
                return Manager.installByFileSibling(
                    mod,
                    this.installPath ?? "",
                    "dll",
                    false,
                    true,
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
                    false,
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
                ElMessage.warning("未知类型, 请手动安装");
                return false;
            },
            async uninstall(_mod) {
                return true;
            },
        },
    ];

    static async checkModType(mod: IModInfo) {
        return classifyModType(mod.modFiles, UNITY_ILCPP2_CLASSIFY_RULES, 99);
    }
}
