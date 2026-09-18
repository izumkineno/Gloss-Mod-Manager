import { escapeHtmlText } from "@/lib/html-sanitizer";

/**
 * Nexus 风格 BBCode 转 HTML。
 * modDesc 实测为 `[b][color][size][url][i]` + `<br />` 混排的网页文章体，
 * markdown-it 吃不了这种格式，因此先转 HTML 再统一走 sanitizeHtml 净化。
 * 支持标签: b / i / u / s / color / size / url, 其余未知标签原样转义。
 */
export function bbcodeToHtml(source: string): string {
    // 先整体转义,再把白名单 BBCode 换回标签 — 未知标签保持转义态,天然防注入。
    let out = escapeHtmlText(source);

    // 换行:纯文本换行与残留 <br />(已被转义)统一成 <br />
    out = out
        .replace(/&lt;br\s*\/?&gt;/gi, "<br />")
        .replace(/\r\n|\r|\n/g, "<br />");

    // url: [url=href]text[/url] 与 [url]href[/url]
    out = out.replace(
        /\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi,
        (_m, href: string, text: string) =>
            `<a href="${href}">${text}</a>`,
    );
    out = out.replace(
        /\[url\]([\s\S]*?)\[\/url\]/gi,
        (_m, href: string) => `<a href="${href}">${href}</a>`,
    );

    // 简单标签
    const simple: Record<string, string> = {
        b: "strong",
        i: "em",
        u: "u",
        s: "s",
    };
    for (const [bb, html] of Object.entries(simple)) {
        out = out.replace(
            new RegExp(`\\[${bb}\\]([\\s\\S]*?)\\[\\/${bb}\\]`, "gi"),
            `<${html}>$1</${html}>`,
        );
    }

    // color: [color=#fff]text[/color] -> <font color>
    out = out.replace(
        /\[color=([^\]]+)\]([\s\S]*?)\[\/color\]/gi,
        (_m, color: string, text: string) =>
            `<font color="${color}">${text}</font>`,
    );

    // size: [size=N]text[/size] -> <font size>, 仅放行 1-7 数字
    out = out.replace(
        /\[size=([^\]]+)\]([\s\S]*?)\[\/size\]/gi,
        (_m, size: string, text: string) => {
            const n = /^\d+$/.test(size.trim()) ? size.trim() : "3";
            return `<font size="${n}">${text}</font>`;
        },
    );

    return out;
}
