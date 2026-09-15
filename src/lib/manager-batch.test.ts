import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock 必须先于模块求值，静态 import 会被提升故此处用动态导入。
vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
    listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/api/path", () => ({
    basename: (p: string) => p.split("/").pop() ?? p,
    dirname: (p: string) => p.split("/").slice(0, -1).join("/") || "/",
    join: (...parts: string[]) => parts.join("/"),
    sep: () => "/",
    documentDir: async () => "/docs",
    localDataDir: async () => "/data",
    resourceDir: async () => "/res",
}));
vi.mock("element-plus-message", () => ({
    ElMessage: { warning: vi.fn(), error: vi.fn() },
}));
vi.mock("@/stores/manager", () => ({
    useManager: () => ({
        managerGame: { gameName: "G", gamePath: "/game" },
    }),
}));

vi.mock("@/stores/settings", () => ({
    useSettings: () => ({ storagePath: "/storage", closeSoftLinks: true }),
}));

// Manager.ts 经自动导入取全局 useManager/useSettings，测试里手动挂载
vi.stubGlobal("useManager", () => ({
    managerGame: { gameName: "G", gamePath: "/game" },
}));
vi.stubGlobal("useSettings", () => ({ storagePath: "/storage", closeSoftLinks: true }));

vi.mock("@/lib/FileHandler", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./FileHandler")>();
    // class 静态方法不可 spread：继承后覆盖需要桩的方法
    class MockHandler extends actual.FileHandler {
        public static override async fileExists() {
            return true;
        }
        public static override async deleteFolder() {
            return true;
        }
    }
    return { ...actual, FileHandler: MockHandler };
});

const { invoke } = await import("@tauri-apps/api/core");
const { Manager } = await import("./Manager");

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

function mod(files: string[]) {
    return { id: 1, modFiles: files } as unknown as IModInfo;
}

beforeEach(() => {
    invokeMock.mockReset();
});

describe("Manager 批量安装编排", () => {
    it("generalInstall 一次 invoke 组装全部文件且顺序与 modFiles 一致", async () => {
        invokeMock.mockResolvedValue([
            { file: "a.txt", ok: true },
            { file: "sub/b.txt", ok: false, error: "文件不存在" },
        ]);

        const result = await Manager.generalInstall(mod(["a.txt", "sub/b.txt"]), "Data", false);

        expect(invokeMock).toHaveBeenCalledTimes(1);
        const [command, args] = invokeMock.mock.calls[0] as [string, Record<string, unknown>];
        expect(command).toBe("mod_install_batch");
        expect(args.allowedRoots).toEqual(["/storage/mods/G/1", "/game/Data"]);
        expect(args.items).toEqual([
            { file: "a.txt", src: "/storage/mods/G/1/a.txt", dst: "/game/Data/a.txt", op: "copy", backup: "gmmback" },
            { file: "sub/b.txt", src: "/storage/mods/G/1/sub/b.txt", dst: "/game/Data/b.txt", op: "copy", backup: "gmmback" },
        ]);
        expect(result).toEqual([
            { file: "a.txt", state: true },
            { file: "sub/b.txt", state: false },
        ]);
    });

    it("keepPath=true 时保留包内相对目录", async () => {
        invokeMock.mockResolvedValue([{ file: "sub/b.txt", ok: true }]);

        await Manager.generalInstall(mod(["sub/b.txt"]), "Data", true);

        const [, args] = invokeMock.mock.calls[0] as [string, Record<string, unknown>];
        expect((args.items as Array<Record<string, string>>)[0].dst).toBe("/game/Data/sub/b.txt");
    });

    it("后端整批异常时逐项记 false（照搬旧逐项 catch）", async () => {
        invokeMock.mockRejectedValue(new Error("backend down"));

        const result = await Manager.generalInstall(mod(["a.txt"]), "Data", false);

        expect(result).toEqual([{ file: "a.txt", state: false }]);
    });

    it("generalUninstall 发 remove 项（源存在时一次 invoke）", async () => {
        invokeMock
            .mockResolvedValueOnce([{ file: "a.txt", ok: true }])
            .mockResolvedValue([]);
        const result = await Manager.generalUninstall(mod(["a.txt"]), "Data", false);

        const [command, args] = invokeMock.mock.calls[0] as [string, Record<string, unknown>];
        expect(command).toBe("mod_install_batch");
        expect(args.items).toEqual([
            { file: "a.txt", src: "/storage/mods/G/1/a.txt", dst: "/game/Data/a.txt", op: "remove", backup: "gmmback" },
        ]);
        expect(result).toEqual([{ file: "a.txt", state: true }]);
    });
});
