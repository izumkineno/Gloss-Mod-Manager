// 下载任务类型定义（传输层为 Rust 进程内 simple_downloader，见 native-downloader.ts）。
// 本文件仅保留各队列/组件共享的接口。

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
    uploadLength?: string;
    downloadSpeed?: string;
    uploadSpeed?: string;
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
    uploadSpeed: string;
    numActive: string;
    numWaiting: string;
    numStopped: string;
}

export interface IDownloaderEnsureOptions {
    outputDirectory?: string;
    listenPort?: number;
    secret?: string;
    maxConcurrentDownloads?: number;
    split?: number;
    maxConnectionPerServer?: number;
    minSplitSize?: string;
}

export interface IDownloaderSettings {
    autoStart: boolean;
    rpcPort: number;
    rpcSecret: string;
    maxConcurrentDownloads: number;
    split: number;
    maxConnectionPerServer: number;
    minSplitSize: string;
}
