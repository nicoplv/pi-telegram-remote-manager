import { describe, expect, it } from "vitest";
import { markdownToTelegramHtml, splitTelegramHtml } from "../src/telegram/render.js";

describe("Telegram rendering", () => {
  it("escapes raw HTML while preserving Markdown", () => {
    const rendered = markdownToTelegramHtml("**bold** <script>alert(1)</script>");
    expect(rendered).toContain("<b>bold</b>");
    expect(rendered).not.toContain("<script>");
    expect(rendered).toContain("&lt;script&gt;");
  });

  it("splits oversized Unicode pre blocks into balanced chunks", () => {
    const chunks = splitTelegramHtml(`<pre>${"🐻 line\n".repeat(1000)}</pre>`, 500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.startsWith("<pre>") && chunk.endsWith("</pre>") && Buffer.byteLength(chunk) <= 500)).toBe(true);
  });
});
