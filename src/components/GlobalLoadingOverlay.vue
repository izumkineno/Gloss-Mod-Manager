<template>
    <div
        v-if="loading.visible"
        class="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-3 bg-black/50 backdrop-blur-sm"
    >
        <LoaderCircle class="size-8 animate-spin text-white" />
        <p v-if="loading.text" class="text-sm text-white/90">
            {{ loading.text }}
        </p>
    </div>
</template>

<script setup lang="ts">
import { LoaderCircle } from "lucide-vue-next";
import { useGlobalLoadingStore } from "@/stores/global-loading";

const loading = useGlobalLoadingStore();
</script>
