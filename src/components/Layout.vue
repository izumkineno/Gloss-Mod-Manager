<script setup lang="ts">
import { provide, ref } from "vue";
import TitleBar from "@/components/TitleBar.vue";

// 置顶 popup 打开时只给主页面加遮罩（标题栏/侧边栏保持清晰可点）。
const pinnedPopupOpen = ref(false);
provide("pinnedPopupOpen", pinnedPopupOpen);
</script>
<template>
    <div
        class="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground selection:bg-primary/30 font-sans antialiased">
        <TitleBar />
        <div class="flex flex-1 min-h-0 overflow-hidden">
            <Sidebar />
            <main class="relative flex flex-1 flex-col min-w-0 bg-background">
                <div
                    class="flex-1 overflow-y-auto overflow-x-hidden p-3 sm:p-6 scroll-smooth">
                    <slot />
                </div>
                <!-- 主页面遮罩：popup 打开时压暗内容区，点击关闭 -->
                <div
                    v-if="pinnedPopupOpen"
                    class="absolute inset-0 z-30 bg-black/25 backdrop-blur-sm"
                    @click="pinnedPopupOpen = false"
                />
            </main>
        </div>
    </div>
</template>
<style scoped></style>
