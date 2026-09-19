// 左侧导航与顶部快捷入口的唯一来源。
// Sidebar 的常驻列表与 PinnedTabs 的快捷浮窗都从这里取定义。
import {
    Archive,
    ArrowDownToLine,
    Bot,
    Box,
    Gamepad2,
    GamepadDirectional,
    Home,
    Layers,
    Info,
    MessageCircleMore,
    Settings,
} from "lucide-vue-next";

export interface INavItem {
    labelKey: string;
    path: string;
    // lucide 图标组件，Sidebar 与 PinnedTabs 直接渲染。
    icon: unknown;
}

export const NAV_ITEMS: INavItem[] = [
    { labelKey: "nav.home", path: "/", icon: Home },
    { labelKey: "nav.games", path: "/games", icon: Gamepad2 },
    { labelKey: "nav.manager", path: "/manager", icon: Box },
    { labelKey: "nav.explore", path: "/explore", icon: GamepadDirectional },
    { labelKey: "nav.download", path: "/download", icon: ArrowDownToLine },
    { labelKey: "nav.collection", path: "/collection", icon: Layers },
    { labelKey: "nav.mcp", path: "/mcp", icon: Bot },
    { labelKey: "nav.backup", path: "/backup", icon: Archive },
    { labelKey: "nav.aiChat", path: "/ai-chat", icon: MessageCircleMore },
    { labelKey: "nav.about", path: "/about", icon: Info },
];

export const NAV_BOTTOM_ITEMS: INavItem[] = [
    { labelKey: "nav.settings", path: "/settings", icon: Settings },
];

/** 所有可被置顶的 tab（含底部设置项）。 */
export const PINNABLE_TABS: INavItem[] = [...NAV_ITEMS, ...NAV_BOTTOM_ITEMS];
