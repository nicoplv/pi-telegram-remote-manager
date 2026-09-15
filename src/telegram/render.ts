import { marked } from "marked";

const MAX_CHUNK_BYTES = 3500;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function stripHtml(text: string): string {
  return text.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
}

export function markdownToTelegramHtml(markdown: string): string {
  const safeInput = markdown.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let html = marked.parse(safeInput, { async: false, gfm: true, breaks: true }) as string;
  html = html
    .replace(/<h[1-6]>([\s\S]*?)<\/h[1-6]>/g, "<b>$1</b>\n")
    .replace(/<strong>/g, "<b>").replace(/<\/strong>/g, "</b>")
    .replace(/<em>/g, "<i>").replace(/<\/em>/g, "</i>")
    .replace(/<del>/g, "<s>").replace(/<\/del>/g, "</s>")
    .replace(/<p>/g, "").replace(/<\/p>/g, "\n")
    .replace(/<ul>/g, "").replace(/<\/ul>/g, "")
    .replace(/<ol>/g, "").replace(/<\/ol>/g, "")
    .replace(/<li>([\s\S]*?)<\/li>/g, "• $1\n")
    .replace(/<hr\s*\/?>/g, "———\n")
    .replace(/<table>([\s\S]*?)<\/table>/g, (_match, table: string) => `<pre>${table.replace(/<\/?(?:thead|tbody|tr)>/g, "\n").replace(/<\/?(?:th|td)>/g, "  ").replace(/<[^>]+>/g, "").trim()}</pre>`)
    .replace(/<a href="([^"]+)">([\s\S]*?)<\/a>/g, (_match, href: string, label: string) => /^(https?:|tg:)/i.test(href) ? `<a href="${escapeHtml(href)}">${label}</a>` : label)
    .trim();
  return html;
}

function bytes(text: string): number { return Buffer.byteLength(text, "utf8"); }

function takePrefix(text: string, maxBytes: number): { head: string; tail: string } {
  let used = 0;
  let index = 0;
  for (const char of text) {
    const size = bytes(char);
    if (used + size > maxBytes) break;
    used += size;
    index += char.length;
  }
  return { head: text.slice(0, index), tail: text.slice(index) };
}

export function splitTelegramHtml(html: string, maxBytes = MAX_CHUNK_BYTES): string[] {
  if (bytes(html) <= maxBytes) return [html];
  const atoms: string[] = [];
  const protectedHtml = html.replace(/<(pre|blockquote)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, (atom) => {
    const index = atoms.push(atom) - 1;
    return `\n\n\u0000ATOM${index}\u0000\n\n`;
  });
  const blocks = protectedHtml.split(/\n\n+/).map((block) => block.trim()).filter(Boolean).map((block) => block.replace(/\u0000ATOM(\d+)\u0000/g, (_m, i) => atoms[Number(i)] ?? ""));
  const chunks: string[] = [];
  let current = "";
  const flush = () => { if (current) chunks.push(current); current = ""; };
  for (const block of blocks) {
    if (bytes(block) > maxBytes) {
      flush();
      const match = /^<(pre|blockquote)(?:\s[^>]*)?>([\s\S]*)<\/\1>$/.exec(block);
      const open = match ? block.slice(0, block.indexOf(">") + 1) : "";
      const close = match ? `</${match[1]}>` : "";
      let rest = match ? match[2] : block;
      const budget = Math.max(100, maxBytes - bytes(open) - bytes(close));
      while (bytes(rest) > budget) {
        const prefix = takePrefix(rest, budget).head;
        let cut = Math.max(prefix.lastIndexOf("\n"), prefix.lastIndexOf(" "));
        if (cut < 1) cut = prefix.length;
        chunks.push(`${open}${rest.slice(0, cut)}${close}`);
        rest = rest.slice(cut).replace(/^\s+/, "");
      }
      if (rest) chunks.push(`${open}${rest}${close}`);
      continue;
    }
    const candidate = current ? `${current}\n\n${block}` : block;
    if (bytes(candidate) > maxBytes) { flush(); current = block; } else current = candidate;
  }
  flush();
  return chunks;
}

export function summarize(value: unknown, max = 500): string {
  let text: string;
  if (typeof value === "string") text = value;
  else { try { text = JSON.stringify(value, null, 2); } catch { text = String(value); } }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
