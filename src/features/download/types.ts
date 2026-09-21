// 下载任务统一状态机类型（前端投影机只读，后端为真相源）。
// 状态集 5 态：waiting | active | paused | error | retrying。
// complete / removed 不是状态，是终局副作用（出机 + 发射终局事件）。

/** 机内状态（wire 上小写字符串，与后端 TaskStatus 1:1）。 */
export type DownloadStatus = "waiting" | "active" | "paused" | "error" | "retrying";

/** 终局副作用事件（非状态）：出机后发射。 */
export type TerminalKind = "complete" | "removed";

/** 任务元数据：随 task 进出机，complete/removed 后清理（purge 语义）。 */
export interface TaskMeta {
    /** 与 task 同 gid，同生命周期。 */
    gid: string;
    /** 落盘文件名。 */
    fileName: string;
    /** 下载地址。 */
    downloadUrl: string;
    /** 来源标识（如 gloss / nexus / custom）。 */
    source: string;
    /** 所属集合壳 id（普通任务为 undefined）。 */
    collectionId?: string;
}

/** 下载任务投影（后端 DlTaskChanged 事件的机内投影）。 */
export interface DownloadTask {
    gid: string;
    status: DownloadStatus;
    /** 后端真相源：重试次数（只读投影，不在前端累加）。 */
    retryCount: number;
    /** 后端真相源：下次重试毫秒时间戳（只读投影，不在前端计时）。 */
    nextRetryAtMs: number;
    /** 所属集合壳 id。 */
    collectionId?: string;
    /** 落盘目录投影（入队时登记，open-file 链路用）。 */
    dir?: string;
    /** 可选进度观测字段（触发器语义，不做数据源）。 */
    total?: number;
    downloaded?: number;
    speed?: number;
    error?: string;
}

/** 终局归档投影：complete 任务出机后的最后一帧（展示/重新下载用，status 为终局事件名）。 */
export type ArchivedTask = Omit<DownloadTask, "status"> & { status: TerminalKind };

/** facade 快照元素：机内 5 态任务或终局归档投影。 */
export type TaskProjection = DownloadTask | ArchivedTask;

/** Collection 壳：仅分组 + 共享闸，无独立状态机/队列。 */
export interface CollectionShell {
    collectionId: string;
    paused: boolean;
}

// 旧 IDownloader* 形状兼容层（Wave 3 迁移期）：调用方逐步改读 DownloadTask，旧文件已删，此处唯一真相源。
export interface IDownloaderTaskUri {
    status: string;
    uri: string;
}
export interface IDownloaderTaskFile {
    index?: string;
    path?: string;
    length?: string;
    completedLength?: string;
    selected?: string;
    uris?: IDownloaderTaskUri[];
}
export interface IDownloaderTask {
    gid: string;
    status: string;
    totalLength?: string;
    completedLength?: string;
    downloadSpeed?: string;
    connections?: string;
    numSeeders?: string;
    dir?: string;
    files: IDownloaderTaskFile[];
    bittorrent?: {
        info?: {
            name?: string;
        };
    };
    errorCode?: string;
    errorMessage?: string;
    followedBy?: string[];
    belongsTo?: string;
}
export interface IDownloaderGlobalStat {
    downloadSpeed: string;
    numActive: string;
    numWaiting: string;
    numStopped: string;
}
export interface IDownloaderEnsureOptions {
    outputDirectory?: string;
    split?: number;
    maxConnectionPerServer?: number;
    minSplitSize?: string;
}
export interface IDownloaderSettings {
    split: number;
    maxConnectionPerServer: number;
    minSplitSize: string;
}
/** 后退避选项：预留字段，不接 UI（决策已定）。 */
export interface BackoffOptions {
    delaysMs?: number[];
    maxRetries?: number;
}
