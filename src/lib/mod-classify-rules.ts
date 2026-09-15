import { invoke } from "@tauri-apps/api/core";

// 后端 mod_classify 规则表（src-tauri/src/fsops.rs）：规则内 OR，规则按序首个命中返回。
// 语义对齐前端旧实现：basename 大小写无关相等；ext 去点小写；segment 精确（含大小写）；
// segment_ci 小写；contains 尾段小写子串；suffix 整路径小写后缀。

export interface IClassifyMatcher {
    kind: "basename" | "ext" | "segment" | "segment_ci" | "contains" | "suffix";
    value: string;
}

export interface IClassifyRule {
    id: number;
    anyOf: IClassifyMatcher[];
}

export async function classifyModType(
    files: string[],
    rules: IClassifyRule[],
    fallback = 99,
): Promise<number> {
    return invoke<number>("mod_classify", { files, rules, default: fallback });
}

// UnrealEngine.checkModType：ue4ss > pak > mods > scripts（Scripts 大小写敏感，照搬）
export const UNREAL_CLASSIFY_RULES: IClassifyRule[] = [
    {
        id: 2,
        anyOf: [
            { kind: "basename", value: "ue4ss.dll" },
            { kind: "basename", value: "dwmapi.dll" },
            { kind: "basename", value: "xinput1_3.dll" },
        ],
    },
    { id: 1, anyOf: [{ kind: "ext", value: "pak" }] },
    { id: 3, anyOf: [{ kind: "basename", value: "Enabled.txt" }] },
    { id: 5, anyOf: [{ kind: "segment", value: "Scripts" }] },
];

// UnityGame.checkModType：bepinEx > plugins
export const UNITY_CLASSIFY_RULES: IClassifyRule[] = [
    { id: 1, anyOf: [{ kind: "basename", value: "winhttp.dll" }] },
    {
        id: 2,
        anyOf: [
            { kind: "ext", value: "dll" },
            { kind: "contains", value: "plugins" },
        ],
    },
];

// UnityGameILCPP2.checkModType：melonLoader > mods
export const UNITY_ILCPP2_CLASSIFY_RULES: IClassifyRule[] = [
    { id: 1, anyOf: [{ kind: "basename", value: "version.dll" }] },
    { id: 2, anyOf: [{ kind: "ext", value: "dll" }] },
];

// REEngine.checkModType：dinput8 → 2；reframework → 7；autorun → 1；plugins → 4；natives → 3；pak → 6
export const RE_CLASSIFY_RULES: IClassifyRule[] = [
    { id: 2, anyOf: [{ kind: "basename", value: "dinput8.dll" }] },
    { id: 7, anyOf: [{ kind: "segment_ci", value: "reframework" }] },
    { id: 1, anyOf: [{ kind: "segment_ci", value: "autorun" }] },
    { id: 4, anyOf: [{ kind: "segment_ci", value: "plugins" }] },
    { id: 3, anyOf: [{ kind: "segment_ci", value: "natives" }] },
    { id: 6, anyOf: [{ kind: "ext", value: "pak" }] },
];

// DyingLight2.checkModType：ext pak → 1
export const DYING_LIGHT_2_CLASSIFY_RULES: IClassifyRule[] = [
    { id: 1, anyOf: [{ kind: "ext", value: "pak" }] },
];
