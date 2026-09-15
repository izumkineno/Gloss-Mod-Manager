import { describe, expect, it, vi } from "vitest";

// vi.mock 必须先于模块求值，静态 import 会被提升故此处用动态导入。
vi.mock("@tauri-apps/api/path", () => ({
    basename: (p: string) => p.split("/").pop() ?? p,
    join: (...parts: string[]) => parts.join("/"),
}));

vi.mock("element-plus-message", () => ({
    ElMessage: { warning: vi.fn(), error: vi.fn() },
}));
// 以与后端一致的 basename 语义模拟 mod_classify，只验证 TS 侧接线（规则构造/优先级/回退）
vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(async (_command: string, args: {
        files: string[];
        rules: Array<{ id: number; anyOf: Array<{ kind: string; value: string }> }>;
        default: number;
    }) => {
        for (const rule of args.rules) {
            const hit = args.files.some((file) =>
                rule.anyOf.some((matcher) =>
                    matcher.kind === "basename" &&
                    file.split("/").pop()?.toLowerCase() === matcher.value.toLowerCase()
                ),
            );
            if (hit) {
                return rule.id;
            }
        }
        return args.default;
    }),
}));

vi.mock("@/lib/FileHandler", () => ({
    FileHandler: {
        GetAppData: async () => "/appdata",
    },
}));

vi.mock("@/lib/Manager", () => ({
    Manager: { checkInstalled: () => true },
}));

const dictionary = ["parts/body/bod123.pak", "bin/modengine2_launcher.exe"];

vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(dictionary.join("\n"), { status: 200 })),
);

const { supportedGames } = await import("./EldenRing");

function mod(files: string[]) {
    return { modFiles: files } as unknown as IModInfo;
}

function checkTypeOf(game: ISupportedGames) {
    if (typeof game.checkModType !== "function") {
        throw new Error("EldenRing checkModType 应为函数式");
    }
    return game.checkModType;
}

describe("EldenRing checkModType", () => {
    it("含 launcher 时返回 2（engine 优先）", async () => {
        const game = await supportedGames();
        expect(
            await checkTypeOf(game)(mod(["a/modengine2_launcher.exe", "b/x.dll"])),
        ).toBe(2);
    });

    it("命中字典文件时返回 1", async () => {
        const game = await supportedGames();
        expect(await checkTypeOf(game)(mod(["mods/bod123.pak"]))).toBe(1);
    });

    it("未命中任何项时返回 99（修复前恒为 1）", async () => {
        const game = await supportedGames();
        expect(await checkTypeOf(game)(mod(["c/readme.txt"]))).toBe(99);
    });
});
