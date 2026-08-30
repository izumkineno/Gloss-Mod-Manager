<script setup lang="ts">
import TitleBar from "@/components/TitleBar.vue";
</script>
<template>
    <div
        class="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground selection:bg-primary/30 font-sans antialiased">
        <TitleBar />
        <div class="flex flex-1 min-h-0 overflow-hidden">
            <Sidebar />
            <main class="flex flex-1 flex-col min-w-0 bg-background">
                <div
                    class="flex-1 overflow-y-auto overflow-x-hidden p-6 scroll-smooth">
                    <slot />
                </div>
            </main>
        </div>
    </div>
</template>
<style scoped></style>
