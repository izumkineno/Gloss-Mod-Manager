<script setup lang="ts">
import { convertFileSrc } from "@tauri-apps/api/core";
const props = withDefaults(
    defineProps<{
        alt?: string;
        fallbackSrc?: string;
        src: string;
    }>(),
    {
        alt: "",
        fallbackSrc: "",
    },
);
const emit = defineEmits<{ failed: [src: string] }>();

const imageSrc = ref("");
const fallbackApplied = ref(false);

function resolveImageSrc(source: string) {
    if (!source) {
        return "";
    }

    if (
        source.includes("http://") ||
        source.includes("https://") ||
        source.startsWith("data:") ||
        source.startsWith("/")
    ) {
        return source;
    }

    return convertFileSrc(source);
}

function syncImageSrc() {
    fallbackApplied.value = false;
    imageSrc.value = resolveImageSrc(props.src);
}

function handleImageError() {
    if (fallbackApplied.value || !props.fallbackSrc) {
        return;
    }

    fallbackApplied.value = true;
    imageSrc.value = resolveImageSrc(props.fallbackSrc);
    // 通知父组件原图已死：懒加载可据此重新拉新 cover/介绍，而不是永远 skip。
    emit("failed", props.src);
}

watch(
    () => [props.src, props.fallbackSrc],
    () => {
        syncImageSrc();
    },
    { immediate: true },
);
</script>
<template>
    <img :src="imageSrc" :alt="props.alt" @error="handleImageError" />
</template>
<style scoped></style>
