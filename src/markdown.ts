/**
 * HTML to markdown: Readability article extraction (via linkedom DOM)
 * with Turndown conversion. Falls back to the dependency-free regex
 * converter when Readability yields nothing.
 */

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

export function htmlToMarkdown(html: string, url: string): string {
  // Primary path: Readability + Turndown.
  try {
    const { document } = parseHTML(html);
    // Readability uses documentURI for link resolution hints.
    try {
      Object.defineProperty(document, "documentURI", { value: url, configurable: true });
    } catch {
      /* linkedom variant without defineProperty support */
    }
    const article = new Readability(document as unknown as Document).parse();
    if (article?.content) {
      const markdown = turndown.turndown(article.content).trim();
      if (markdown.length > 0) return markdown;
    }
  } catch {
    /* fall through to regex converter */
  }
  return fallbackHtmlToMarkdown(html);
}

// ─── Dependency-free fallback converter ─────────────────────────────────────

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function fallbackHtmlToMarkdown(html: string): string {
  let t = html;
  t = t.replace(/<!--[\s\S]*?-->/g, "");
  t = t.replace(
    /<(script|style|noscript|svg|iframe|object|embed|template|form|nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi,
    "",
  );
  t = t.replace(
    /<(script|style|noscript|svg|iframe|object|embed|template|form|nav|header|footer|aside)\b[^>]*\/>/gi,
    "",
  );
  t = t.replace(/<head[\s\S]*?<\/head>/gi, "");
  t = t.replace(
    /<pre[^>]*>([\s\S]*?)<\/pre>/gi,
    (_, b) => `\n\n\`\`\`\n${b.replace(/<[^>]+>/g, "")}\n\`\`\`\n\n`,
  );
  t = t.replace(/<(code|kbd|samp)[^>]*>([\s\S]*?)<\/\1>/gi, (_, b) => `\`${b.replace(/<[^>]+>/g, "")}\``);
  t = t.replace(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_, l, b) => `\n\n${"#".repeat(Number(l))} ${b.replace(/<[^>]+>/g, "").trim()}\n\n`,
  );
  t = t.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, b) => `\n- ${b.replace(/<[^>]+>/g, "").trim()}`);
  t = t.replace(
    /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
    (_, b) => `\n> ${b.replace(/<[^>]+>/g, "").trim()}`,
  );
  t = t.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, b) => {
    const label = b.replace(/<[^>]+>/g, "").trim();
    return label && href ? `[${label}](${href})` : label;
  });
  t = t.replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi, "![$1]");
  t = t.replace(/<br\s*\/?>/gi, "\n");
  t = t.replace(/<hr\s*\/?>/gi, "\n\n---\n\n");
  t = t.replace(/<t[dh]\b[^>]*>/gi, " | ");
  t = t.replace(/<\/tr>/gi, " |\n");
  t = t.replace(/<\/(p|div|section|article|li|ul|ol|table|tr|dl|dd|dt|h[1-6])>/gi, "\n");
  t = t.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  t = t.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");
  t = t.replace(/<[^>]+>/g, "");
  t = decodeEntities(t);
  t = t.replace(/[ \t]+/g, " ");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}
