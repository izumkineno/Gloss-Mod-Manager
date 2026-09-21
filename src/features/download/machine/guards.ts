// 闸语义：paused_all OR paused_collections 命中任一即冻结。
// resume_collection 只清该 id 闸；paused_all 置位时任务保持 paused。
export interface GateState {
    pausedAll: boolean;
    pausedCollections: Set<string>;
}

export function createGates(): GateState {
    return { pausedAll: false, pausedCollections: new Set() };
}

export function isGated(gates: GateState, collectionId?: string): boolean {
    if (gates.pausedAll) {
        return true;
    }
    return collectionId !== undefined && gates.pausedCollections.has(collectionId);
}
