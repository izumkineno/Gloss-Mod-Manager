<script setup lang="ts">
import MarkdownIt from "markdown-it";
import { bbcodeToHtml } from "@/lib/bbcode";
import { sanitizeHtml } from "@/lib/html-sanitizer";

// Mod 介绍富文本公共渲染:BBCode 文章体与 markdown 二选一,统一净化后输出。
const props = withDefaults(
    defineProps<{ source?: string; compact?: boolean }>(),
    { source: "", compact: false },
);

const markdownParser = new MarkdownIt({
    html: false,
    breaks: true,
    linkify: true,
    typographer: true,
});

const renderedHtml = computed(() => {
    const source = (props.source ?? "").replace(/\r\n?/gu, "\n").trim();
    if (!source) return "";
    // 含 BBCode 特征即走 BBCode 通道,否则走 markdown
    const html = /\[(b|i|u|color|size|url)[=\]]/iu.test(source)
        ? bbcodeToHtml(source)
        : markdownParser.render(source);
    return sanitizeHtml(html);
});
</script>

<template>
    <div
        v-if="renderedHtml"
        class="mod-description"
        :class="compact ? 'mod-description--compact' : ''"
        v-html="renderedHtml"
    />
    <p v-else class="empty-markdown"><slot>暂无介绍</slot></p>
</template>

<style scoped>
.empty-markdown {
    color: var(--muted-foreground);
    font-size: 0.875rem;
}

/* Nexus 风格暗色正文面板:深底+浅字,BBCode 颜色在暗底上可读 */
.mod-description {
    font-size: 0.875rem;
    line-height: 1.75;
    background: #0f0f12;
    color: #d7d7db;
    border: 1px solid #2a2a30;
    border-radius: 0.75rem;
    padding: 1.25rem 1.5rem;
}
.mod-description--compact {
    padding: 1rem 1.1rem;
    max-height: 12rem;
    overflow-y: auto;
}
.mod-description :deep(p:last-child) {
    margin-bottom: 0;
}
.mod-description :deep(font[size="5"]),
.mod-description :deep(font[size="6"]),
.mod-description :deep(font[size="7"]) {
    font-size: 1.25rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    line-height: 1.4;
}
.mod-description :deep(font[size="4"]) {
    font-size: 1.05rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    line-height: 1.4;
}
.mod-description :deep(font[size="2"]),
.mod-description :deep(font[size="1"]) {
    font-size: 0.8rem;
    line-height: 1.6;
}
.mod-description :deep(h1),
.mod-description :deep(h2),
.mod-description :deep(h3),
.mod-description :deep(h4) {
    margin: 1.4rem 0 0.7rem;
    font-weight: 600;
    line-height: 1.4;
}
.mod-description :deep(h1) {
    font-size: 1.3rem;
}
.mod-description :deep(h2) {
    font-size: 1.15rem;
}
.mod-description :deep(h3) {
    font-size: 1rem;
}
.mod-description :deep(p),
.mod-description :deep(ul),
.mod-description :deep(ol),
.mod-description :deep(blockquote),
.mod-description :deep(pre),
.mod-description :deep(table) {
    margin: 0 0 0.9rem;
}
.mod-description :deep(ul),
.mod-description :deep(ol) {
    padding-left: 1.3rem;
    list-style: revert;
}
.mod-description :deep(li + li) {
    margin-top: 0.3rem;
}
.mod-description :deep(a) {
    color: #e3dee0;
    text-decoration: underline;
    text-underline-offset: 0.2rem;
}
.mod-description :deep(a):hover {
    color: #ffffff;
}
.mod-description :deep(blockquote) {
    border-left: 2px solid #2a2a30;
    padding-left: 1rem;
    color: #a1a1aa;
}
.mod-description :deep(code) {
    border-radius: 0.35rem;
    background: #232329;
    color: #e8e8ea;
    padding: 0.1rem 0.35rem;
    font-size: 0.875em;
}
.mod-description :deep(pre) {
    overflow-x: auto;
    border: 1px solid #2a2a30;
    border-radius: 0.75rem;
    background: #1a1a1f;
    padding: 1rem;
}
.mod-description :deep(pre code) {
    background: transparent;
    padding: 0;
}
.mod-description :deep(img) {
    display: block;
    max-width: 100%;
    border-radius: 0.75rem;
    margin: 0.9rem 0;
}
.mod-description :deep(table) {
    width: 100%;
    border-collapse: collapse;
    border: 1px solid #2a2a30;
    border-radius: 0.75rem;
    overflow: hidden;
}
.mod-description :deep(th),
.mod-description :deep(td) {
    border-bottom: 1px solid #2a2a30;
    padding: 0.5rem 0.7rem;
    text-align: left;
}
.mod-description :deep(tr:last-child td) {
    border-bottom: none;
}
.mod-description :deep(th) {
    background: #1a1a1f;
    font-weight: 600;
}
</style>
