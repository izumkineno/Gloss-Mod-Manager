import { describe, expect, it, vi } from "vitest";

// vi.mock 必须先于模块求值，静态 import 会被提升故此处用动态导入。
vi.mock("@tauri-apps/api/path", () => ({
    basename: (p: string) => p.split("/").pop() ?? p,
    join: (...parts: string[]) => parts.join("/"),
}));

vi.mock("element-plus-message", () => ({
    ElMessage: { warning: vi.fn(), error: vi.fn() },
}));

// 内存文件系统：key 为绝对路径，value 为内容（目录记为 null）
const files = new Map<string, string | null>();

function resetFs(entries: Array<[string, string | null]>) {
    files.clear();
    for (const [path, content] of entries) {
        files.set(path, content);
    }
}

const deleted: string[] = [];
const copied: Array<[string, string]> = [];
let writtenPakList = "";

vi.mock("@/lib/Manager", () => ({
    Manager: {
        getModStoragePath: async (id: number | string) => `/mods/${String(id)}`,
        getContext: async () => ({ modStorage: "/mods", gameStorage: "/game" }),
    },
}));

vi.mock("@/lib/FileHandler", () => ({
    FileHandler: {
        getMyDocuments: async () => "/docs",
        getFolderFiles: async (dir: string) =>
            [...files.keys()]
                .filter((path) => path.startsWith(`${dir}/`))
                .map((path) => path.slice(dir.length + 1)),
        getFileExtension: async (path: string) => path.split(".").pop() ?? "",
        isFile: async (path: string) =>
            files.has(path) && files.get(path) !== null,
        copyFile: async (src: string, dst: string) => {
            copied.push([src, dst]);
            files.set(dst, files.get(src) ?? "");
            return true;
        },
        deleteFile: async (path: string) => {
            deleted.push(path);
            files.delete(path);
            return true;
        },
        renameFile: async (src: string, dst: string) => {
            files.set(dst, files.get(src) ?? "");
            files.delete(src);
            return true;
        },
        readFile: async (path: string) => {
            if (path.endsWith("pakList.txt")) {
                return (files.get(path) as string) || "";
            }
            return (files.get(path) as string) ?? "";
        },
        writeFile: async (path: string, content: string) => {
            if (path.endsWith("pakList.txt")) {
                writtenPakList = content;
            }
            files.set(path, content);
            return true;
        },
    },
}));

const { supportedGames } = await import("./DyingLight2");

function mod(id: number, modFiles: string[]) {
    return { id, modFiles } as unknown as IModInfo;
}
function pakTypeOf(game: ISupportedGames, install: boolean) {
    const entry = game.modType[0];
    const fn = install ? entry.install : entry.uninstall;
    if (typeof fn !== "function") {
        throw new Error("DyingLight2 pak 类型安装函数应为函数式");
    }
    return fn;
}


describe("DyingLight2 pak 管线", () => {
    it("非 pak 文件不参与序号分配（含 data 数字名时仍连续）", async () => {
        resetFs([
            ["/game/ph/source/data2.pak", "pak"],
            ["/game/ph/source/data5.txt", "txt"],
            ["/mods/7/x.pak", "pak"],
            ["/mods/pakList.txt", ""],
        ]);
        copied.length = 0;

        const game = await supportedGames();
        await pakTypeOf(game, true)(mod(7, ["x.pak"]));

        // 修复前 filter(async) 不过滤，data5.txt 参与 Math.max 得 data6；正确为 data3
        expect(copied[0][1]).toBe("/game/ph/source/data3.pak");
    });

    it("卸载只移除命中记录，不误删首条", async () => {
        resetFs([
            ["/game/ph/source/data2.pak", "pak"],
            ["/game/ph/source/data3.pak", "pak"],
            ["/mods/2/b.pak", "pak"],
            ["/mods/pakList.txt", "1|a.pak|data2.pak\n2|b.pak|data3.pak"],
        ]);
        deleted.length = 0;
        writtenPakList = "";

        const game = await supportedGames();
        await pakTypeOf(game, false)(mod(2, ["b.pak"]));

        // 修复前 find(async) 恒返首条，会删 data2.pak 并残留自身记录
        expect(deleted).toEqual(["/game/ph/source/data3.pak"]);
        expect(writtenPakList).toBe("1|a.pak|data2.pak");
    });
});
