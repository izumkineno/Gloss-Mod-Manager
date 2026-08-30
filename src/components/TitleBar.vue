<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { Copy, Minus, Square, X } from "lucide-vue-next";
import logoSrc from "@/assets/logo.png";
// 是否处于 Tauri 环境（vite preview 下无窗口 API，需降级隐藏控制按钮）
const isTauri = ref(false);
// 是否已最大化（用于切换图标：最大化→还原图标）
const isMaximized = ref(false);

let appWindow: Awaited<ReturnType<typeof import("@tauri-apps/api/window").getCurrentWindow>> | null = null;
let unlistenResized: (() => void) | null = null;

// 更新最大化状态
async function syncMaximized() {
    if (!appWindow) return;
    try {
        isMaximized.value = await appWindow.isMaximized();
    } catch {
        // 忽略非 Tauri 环境的调用失败
    }
}

onMounted(async () => {
    try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        appWindow = getCurrentWindow();
        isTauri.value = true;
        await syncMaximized();
        // 监听窗口尺寸变化（包含最大化/还原时触发），同步图标
        unlistenResized = await appWindow.onResized(() => {
            void syncMaximized();
        });
    } catch {
        // 非 Tauri 环境（浏览器预览）静默降级
        isTauri.value = false;
    }
});

onUnmounted(() => {
    unlistenResized?.();
});

// 对齐官方文档 Manual Implementation：
// 用 mousedown + e.detail===2 实现拖拽与双击最大化的二合一，避免单独的 data-tauri-drag-region 在 Windows 焦点丢失时失效。
async function onDragMouseDown(event: MouseEvent) {
    // 仅左键
    if (event.buttons !== 1) return;
    if (!appWindow) return;
    try {
        if (event.detail === 2) {
            // 双击：切换最大化
            await appWindow.toggleMaximize();
            await syncMaximized();
        } else {
            // 单击：开始拖拽
            await appWindow.startDragging();
        }
    } catch {
        // 忽略拖拽/最大化失败
    }
}

async function minimize() {
    try {
        await appWindow?.minimize();
    } catch { }
}

async function toggleMaximize() {
    if (!appWindow) return;
    try {
        await appWindow.toggleMaximize();
        await syncMaximized();
    } catch { }
}

async function closeWindow() {
    try {
        await appWindow?.close();
    } catch { }
}
</script>

<template>
    <!-- 对齐官方示例：仅拖拽区拥有 data-tauri-drag-region，控制按钮区不带该属性 -->
    <header
        class="flex h-8 shrink-0 select-none items-center border-b border-border/40 bg-background/80 backdrop-blur-xl"
    >
        <div
            id="titlebar"
            class="flex h-full flex-1 items-center gap-2 px-3"
            data-tauri-drag-region
            @mousedown="onDragMouseDown"
            @dblclick.stop="toggleMaximize"
        >
            <img
                :src="logoSrc"
                alt="Gloss Mod Manager"
                class="h-4 w-4 shrink-0 rounded-sm object-contain"
                draggable="false"
            />
            <span class="text-xs font-semibold tracking-tight">Gloss Mod Manager</span>
        </div>

        <!-- 右侧：窗口控制按钮（非拖拽区） -->
        <div v-if="isTauri" class="controls flex h-full shrink-0 items-stretch">
            <button
                id="titlebar-minimize"
                class="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label="最小化"
                tabindex="-1"
                @click="minimize"
            >
                <Minus class="h-3.5 w-3.5" />
            </button>
            <button
                id="titlebar-maximize"
                class="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                :aria-label="isMaximized ? '还原' : '最大化'"
                tabindex="-1"
                @click="toggleMaximize"
            >
                <Copy v-if="isMaximized" class="h-3.5 w-3.5" />
                <Square v-else class="h-3 w-3" />
            </button>
            <button
                id="titlebar-close"
                class="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
                aria-label="关闭"
                tabindex="-1"
                @click="closeWindow"
            >
                <X class="h-3.5 w-3.5" />
            </button>
        </div>
    </header>
</template>
