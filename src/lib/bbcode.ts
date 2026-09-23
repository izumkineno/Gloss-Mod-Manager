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

    // 换行:纯文本换行、残留 <br />（已被转义）与非法 [br] 统一成 <br />
    out = out
        .replace(/&lt;br\s*\/?&gt;/gi, "<br />")
        .replace(/\[br\s*\/?\]/gi, "<br />")
        .replace(/\r\n|\r|\n/g, "<br />");
    // 非法闭合 [/*]：Nexus 列表项常用，先清掉再分项。
    out = out.replace(/\[\/\*\]/gi, "");
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
    // img: [img]src[/img] 与 [img=src]；仅 http(s) 放行，其余整个标签丢弃防注入。
    const toSafeImg = (src: string) => {
        const url = src.trim().replace(/^["']|["']$/g, "").replace(/<br\s*\/?>/gi, "").trim();
        if (!/^https?:\/\/[^\s"'<>]+$/i.test(url)) {
            return "";
        }
        return `<img src="${url}" loading="lazy" />`;
    };
    out = out.replace(/\[img=([^\]]+)\]/gi, (_m, src: string) => toSafeImg(src));
    out = out.replace(/\[img\]([\s\S]*?)\[\/img\]/gi, (_m, src: string) => toSafeImg(src));
    for (const align of ["center", "left", "right", "justify"]) {
        out = out.replace(
            new RegExp(`\\[${align}\\]([\\s\\S]*?)\\[\\/${align}\\]`, "gi"),
            `<div style="text-align:${align};">$1</div>`,
        );
    }
    out = out.replace(/\[quote\]([\s\S]*?)\[\/quote\]/gi, "<blockquote>$1</blockquote>");
    out = out.replace(
        /\[quote=([^\]]+)\]([\s\S]*?)\[\/quote\]/gi,
        "<blockquote><p>$1</p>$2</blockquote>",
    );
    // list: [list][*]项[/*][/list] -> ul/li；孤立 [*] 按换行分隔的 li 处理。
    out = out.replace(/\[list(?:=[^\]]+)?\]([\s\S]*?)\[\/list\]/gi, (_m, body: string) => {
        const items = body
            .split(/\[\*\]/gi)
            .map((chunk) => chunk.replace(/\[\/*\]/g, "").trim())
            .map((chunk) => chunk.replace(/^(<br\s*\/?>\s*)+/i, "").replace(/(\s*<br\s*\/?>)+$/i, ""))
            .filter(Boolean);
        if (items.length === 0) {
            return "";
        }
        return `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;
    });
    out = out.replace(/\[\*\]/gi, "<br />• ");
    // font: Nexus 源 HTML 里残留的 <font> 已被转义，还原为 span（只保留 color）。
    out = out.replace(/&lt;font\s+color=(?:"([^"]*)"|'([^']*)'|([^\s&;]+))&gt;/gi, "<span style=\"color:$1$2$3;\">");
    out = out.replace(/&lt;\/font&gt;/gi, "</span>");
    out = out.replace(
        /\[size=([^\]]+)\]([\s\S]*?)\[\/size\]/gi,
        (_m, size: string, text: string) => {
            const n = /^\d+$/.test(size.trim()) ? size.trim() : "3";
            return `<font size="${n}">${text}</font>`;
        },
    );

    return out;
}
