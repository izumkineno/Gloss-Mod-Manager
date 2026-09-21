// 文件选择弹窗的列表过滤器单测：各来源的"主文件/可选文件"必须按分类正确分桶。
import { describe, expect, it } from "vitest";
import { filterDownloadFilePickerItems } from "./download-picker-filter";
import type { IDownloadFilePickerItem } from "@/stores/download-picker";

const noneSelected = () => false;

function makeItem(
    overrides: Partial<IDownloadFilePickerItem> & Pick<IDownloadFilePickerItem, "id">,
): IDownloadFilePickerItem {
    return { title: overrides.id, description: "", badges: [], ...overrides };
}

describe("下载文件选择过滤器", () => {
    // 分桶只看 optional 语义：Nexus 行带"主文件/可选文件"、Collection 行带"必装/可选"，
    // 徽章文案不同但必须落到同一分桶；没有分类信息的来源（3DM 资源）按必装。
    it("按 optional 语义分桶，徽章文案不参与判断", () => {
        const items = [
            makeItem({ id: "nexus-main", badges: ["默认", "主文件"], optional: false }),
            makeItem({ id: "nexus-patch", badges: ["可选文件"], optional: true }),
            makeItem({ id: "collection-required", badges: ["必装"], optional: false }),
            makeItem({ id: "collection-optional", badges: ["可选", "已下载"], optional: true }),
            makeItem({ id: "gloss-resource", badges: ["最新"] }),
        ];

        expect(
            filterDownloadFilePickerItems(items, "required", noneSelected).map(
                (item) => item.id,
            ),
        ).toEqual(["nexus-main", "collection-required", "gloss-resource"]);
        expect(
            filterDownloadFilePickerItems(items, "optional", noneSelected).map(
                (item) => item.id,
            ),
        ).toEqual(["nexus-patch", "collection-optional"]);
    });

    it("未下载过滤掉已导入/已下载行", () => {
        const items = [
            makeItem({ id: "imported", badges: ["必装", "已导入"] }),
            makeItem({ id: "downloaded", badges: ["必装", "已下载"] }),
            makeItem({ id: "fresh", badges: ["必装"] }),
        ];

        expect(
            filterDownloadFilePickerItems(items, "undownloaded", noneSelected).map(
                (item) => item.id,
            ),
        ).toEqual(["fresh"]);
    });

    it("未勾选过滤掉已选中行", () => {
        const items = [makeItem({ id: "a" }), makeItem({ id: "b" })];

        expect(
            filterDownloadFilePickerItems(
                items,
                "unselected",
                (itemId) => itemId === "a",
            ).map((item) => item.id),
        ).toEqual(["b"]);
    });
});
