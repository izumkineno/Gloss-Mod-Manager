import { invoke, isTauri } from "@tauri-apps/api/core";
import { appLogDir, join } from "@tauri-apps/api/path";
import { readDir, readTextFile, stat } from "@tauri-apps/plugin-fs";
import { FileHandler } from "@/lib/FileHandler";

// console 原生方法名，新增 trace 以对齐 tracing 的 trace 级别
type ConsoleMethodName = "debug" | "error" | "info" | "log" | "trace" | "warn";
type LogLevelName = "debug" | "error" | "info" | "trace" | "warn";

interface IWriteLogOptions {
    ensureInitialized?: boolean;
}

export interface ILogFileItem {
    createdAt: string | null;
    isLatest: boolean;
    name: string;
    path: string;
    size: number;
    updatedAt: string | null;
}

export class Log {
    private static readonly latestLogFileName = "latest.log";
    private static readonly ignoredTauriCallbackWarningParts = [
        "Couldn't find callback id",
        "app is reloaded while Rust is running an asynchronous operation",
    ];
    private static readonly originalConsole: Record<
        ConsoleMethodName,
        (...args: unknown[]) => void
    > = {
        debug: console.debug.bind(console),
        error: console.error.bind(console),
        info: console.info.bind(console),
        log: console.log.bind(console),
        trace: (console.trace?.bind(console) ?? console.debug.bind(console)) as (
            ...args: unknown[]
        ) => void,
        warn: console.warn.bind(console),
    };
    private static initializeTask: Promise<void> | null = null;
    private static isConsoleForwardingInstalled = false;
    private static isInitialized = false;
    // Tauri 注入前的早期调用缓冲，初始化后重放
    private static pendingBuffer: Array<{ level: LogLevelName; args: unknown[] }> = [];

    /**
     * 初始化日志系统：安装 console 拦截、创建日志目录，并将现有 console 输出同步到日志文件。
     */
    public static async initialize() {
        if (Log.initializeTask) {
            return Log.initializeTask;
        }

        Log.initializeTask = (async () => {
            if (!isTauri()) {
                return;
            }

            // 先装拦截，确保 getLogDirectoryPath 内的 console.log 也能被捕获（使用 originalConsole 避免递归）
            Log.installConsoleForwarding();
            await Log.getLogDirectoryPath();
            Log.isInitialized = true;
            await Log.flushPendingBuffer();
            await Log.writeToPlugin("info", ["日志系统初始化完成。"], {
                ensureInitialized: false,
            });
        })();

        try {
            await Log.initializeTask;
        } catch (error) {
            Log.initializeTask = null;
            throw error;
        }
    }

    /**
     * 获取应用日志目录的绝对路径。
     */
    public static async getLogDirectoryPath() {
        const directoryPath = await appLogDir();
        await FileHandler.createDirectory(directoryPath);
        return directoryPath;
    }

    /**
     * 列出当前日志目录下的全部 .log 文件，latest.log 始终排在最前面。
     */
    public static async listLogFiles(): Promise<ILogFileItem[]> {
        await Log.initialize();

        const directoryPath = await Log.getLogDirectoryPath();
        const entries = await readDir(directoryPath);
        const logFiles = entries.filter(
            (entry) =>
                entry.isFile && entry.name.toLowerCase().endsWith(".log"),
        );

        const items = await Promise.all(
            logFiles.map(async (entry) => {
                const filePath = await join(directoryPath, entry.name);
                const metadata = await stat(filePath);

                return {
                    createdAt: metadata.birthtime?.toISOString() ?? null,
                    isLatest:
                        entry.name.toLowerCase() ===
                        Log.latestLogFileName.toLowerCase(),
                    name: entry.name,
                    path: filePath,
                    size: metadata.size,
                    updatedAt: metadata.mtime?.toISOString() ?? null,
                } satisfies ILogFileItem;
            }),
        );

        return items.sort((left, right) => {
            if (left.isLatest !== right.isLatest) {
                return left.isLatest ? -1 : 1;
            }

            return right.name.localeCompare(left.name, "zh-CN");
        });
    }

    /**
     * 读取 latest.log 的完整内容。
     */
    public static async readLatestLog() {
        return Log.readLogFile(Log.latestLogFileName);
    }

    /**
     * 读取指定日志文件的完整内容。
     */
    public static async readLogFile(fileName: string) {
        await Log.initialize();
        const logFilePath = await join(
            await Log.getLogDirectoryPath(),
            Log.normalizeLogFileName(fileName),
        );

        return readTextFile(logFilePath);
    }

    /**
     * 在系统文件管理器中打开日志目录。
     */
    public static async openLogDirectory() {
        return FileHandler.openFolder(await Log.getLogDirectoryPath());
    }

    public static async trace(...args: unknown[]) {
        Log.originalConsole.debug(...args);
        await Log.writeToPlugin("trace", args);
    }

    public static async debug(...args: unknown[]) {
        Log.originalConsole.debug(...args);
        await Log.writeToPlugin("debug", args);
    }

    public static async info(...args: unknown[]) {
        Log.originalConsole.info(...args);
        await Log.writeToPlugin("info", args);
    }

    public static async warn(...args: unknown[]) {
        Log.originalConsole.warn(...args);
        await Log.writeToPlugin("warn", args);
    }

    public static async error(...args: unknown[]) {
        Log.originalConsole.error(...args);
        await Log.writeToPlugin("error", args);
    }

    /**
     * 安装 console 拦截：所有 console.* 调用都会同步镜像到 Rust tracing。
     * 模块加载时即调用，确保最早的日志也不丢失；方法幂等。
     */
    public static installConsoleForwarding() {
        if (Log.isConsoleForwardingInstalled) {
            return;
        }

        // 劫持 console.*，映射到对应的 tracing level
        // log -> info（与旧行为一致），trace -> trace
        console.log = Log.createConsoleForwarder("log", "info");
        console.info = Log.createConsoleForwarder("info", "info");
        console.warn = Log.createConsoleForwarder("warn", "warn");
        console.error = Log.createConsoleForwarder("error", "error");
        console.debug = Log.createConsoleForwarder("debug", "debug");
        // 部分环境无 console.trace，用 debug 兜底
        try {
            (console as unknown as Record<string, unknown>).trace = Log.createConsoleForwarder(
                "trace",
                "trace",
            );
        } catch {
            // 忽略只读属性的劫持失败
        }

        Log.isConsoleForwardingInstalled = true;
        Log.installGlobalErrorHandlers();
    }

    private static installGlobalErrorHandlers() {
        if (typeof window === "undefined") {
            return;
        }

        try {
            window.addEventListener("error", (event) => {
                const message = event.message || "Unknown window error";
                const stack = (event.error as Error | undefined)?.stack;
                void Log.writeToPlugin("error", stack ? [message, stack] : [message, event.error]);
            });

            window.addEventListener("unhandledrejection", (event) => {
                const reason = (event as PromiseRejectionEvent).reason;
                void Log.writeToPlugin("error", ["Unhandled rejection", reason]);
            });
        } catch {
            // 忽略非浏览器环境的监听失败
        }
    }

    private static createConsoleForwarder(
        consoleMethod: ConsoleMethodName,
        level: LogLevelName,
    ) {
        return (...args: unknown[]) => {
            Log.originalConsole[consoleMethod](...args);
            void Log.writeToPlugin(level, args);
        };
    }

    private static normalizeLogFileName(fileName: string) {
        const normalizedFileName = fileName.trim();

        if (!normalizedFileName) {
            throw new Error("日志文件名不能为空。");
        }

        if (/[\\/]/u.test(normalizedFileName)) {
            throw new Error("日志文件名不能包含路径分隔符。");
        }

        return normalizedFileName.toLowerCase().endsWith(".log")
            ? normalizedFileName
            : `${normalizedFileName}.log`;
    }

    private static async flushPendingBuffer() {
        if (Log.pendingBuffer.length === 0 || !isTauri()) {
            return;
        }

        const toFlush = [...Log.pendingBuffer];
        Log.pendingBuffer = [];

        for (const { level, args } of toFlush) {
            await Log.writeToPlugin(level, args, { ensureInitialized: false });
        }
    }

    private static async writeToPlugin(
        level: LogLevelName,
        args: unknown[],
        options: IWriteLogOptions = {},
    ) {
        if (!isTauri()) {
            if (Log.isInitialized) {
                return;
            }

            Log.pendingBuffer.push({ level, args: [...args] });
            if (Log.pendingBuffer.length > 300) {
                Log.pendingBuffer.shift();
            }

            return;
        }

        if (options.ensureInitialized !== false && !Log.isInitialized) {
            // 未初始化时的常规路径：先初始化再写入，同时把本次调用排队避免递归
            try {
                await Log.initialize();
            } catch {
                // 初始化失败则本次日志丢弃，避免阻塞业务
                return;
            }
        }

        const message = Log.stringifyArgs(args);

        if (Log.isIgnoredPluginLogMessage(message)) {
            return;
        }

        try {
            // 通过 Rust tracing 流水线落盘（stdout + session + latest）
            await invoke("frontend_log", { level, message });
        } catch (error) {
            Log.originalConsole.error("写入日志失败。");
            Log.originalConsole.error(error);
        }
    }

    /**
     * 尽量把复杂对象压缩为单行文本，避免标准日志被多余换行打散；
     * Error 会保留堆栈，方便后续排查问题。
     */
    private static stringifyArgs(args: unknown[]) {
        return args.map((item) => Log.stringifyValue(item)).join(" ");
    }

    private static isIgnoredPluginLogMessage(message: string) {
        // Tauri 热重载或窗口刷新时可能产生大量无效回调警告，这类噪声不写入文件日志。
        return Log.ignoredTauriCallbackWarningParts.every((part) =>
            message.includes(part),
        );
    }

    private static stringifyValue(value: unknown): string {
        if (value instanceof Error) {
            return value.stack
                ? `${value.name}: ${value.message}\n${value.stack}`
                : `${value.name}: ${value.message}`;
        }

        if (typeof value === "string") {
            return value;
        }

        if (
            typeof value === "number" ||
            typeof value === "boolean" ||
            typeof value === "bigint" ||
            value === null ||
            value === undefined
        ) {
            return String(value);
        }

        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
}

// 模块加载时立即拦截，确保最早的 console.*（包括其他模块顶层执行期间的）也能进入 tracing
// 幂等：重复调用无副作用；非 Tauri 预览下 writeToPlugin 会自动缓冲/丢弃
if (typeof window !== "undefined" && typeof console !== "undefined") {
    try {
        Log.installConsoleForwarding();
    } catch {
        // 忽略极早期调用的异常
    }
}
