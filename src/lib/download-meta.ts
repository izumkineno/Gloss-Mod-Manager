// 下载任务元信息后端桥：dl_meta_* 命令透传，前端仅做信息显示。
// 存储真相源在后端 download_meta.json；本模块不持状态，每次直调后端。
import { invoke } from "@tauri-apps/api/core";
import type { IGlossDownloadTaskMeta } from "@/lib/gloss-download";

export type DownloadMetaMap = Record<string, IGlossDownloadTaskMeta>;

/** 整表读取（页面初始化/刷新展示用）。 */
export async function listDownloadMeta(): Promise<DownloadMetaMap> {
    return invoke<DownloadMetaMap>("dl_meta_list");
}

/** 整表覆盖（批量清理落盘用，与原 PersistentStore.set 整表语义一致）。 */
export async function saveDownloadMetaMap(map: DownloadMetaMap): Promise<void> {
    await invoke("dl_meta_save", { map });
}

/** 单条写入（建任务/导入标记等单点更新用）。 */
export async function putDownloadMeta(gid: string, meta: IGlossDownloadTaskMeta): Promise<void> {
    await invoke("dl_meta_put", { gid, meta });
}

/** 单条删除（清理/移除任务时调用）。 */
export async function removeDownloadMeta(gid: string): Promise<void> {
    await invoke("dl_meta_remove", { gid });
}
