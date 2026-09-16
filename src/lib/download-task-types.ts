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

// 内置进程内下载器：无 RPC、无上传、无服务端；仅保留真实生效的分片参数。
export interface IDownloaderSettings {
    split: number;
    maxConnectionPerServer: number;
    minSplitSize: string;
}
