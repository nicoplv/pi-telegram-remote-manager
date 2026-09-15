import { describe, expect, it, vi } from "vitest";
import { TelegramApi, TelegramApiError } from "../src/telegram/api.js";

describe("TelegramApi", () => {
  it("polls for messages and callbacks and supports inline and persistent keyboards", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const result = String(url).endsWith("/getUpdates") ? [] : { message_id: 7, chat: { id: 42, type: "private" } };
      return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const api = new TelegramApi("secret", fetcher as typeof fetch);
    await api.getUpdates(4, new AbortController().signal);
    await api.sendText(42, "hello");
    await api.sendText(42, "inline", { inlineKeyboard: [[{ text: "Open", callback_data: "open" }]] });
    await api.sendText(42, "persistent", { persistentKeyboard: [["☰ Manager"]] });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ offset: 4, timeout: 25, allowed_updates: ["message", "callback_query"] });
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ chat_id: 42, text: "hello", parse_mode: "HTML" });
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body)).reply_markup).toEqual({ inline_keyboard: [[{ text: "Open", callback_data: "open" }]] });
    expect(JSON.parse(String(fetcher.mock.calls[3][1]?.body)).reply_markup).toEqual({
      keyboard: [[{ text: "☰ Manager" }]], resize_keyboard: true, is_persistent: true,
    });
  });

  it("clears registered Telegram commands from default, private-chat, and owner-chat scopes", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200, headers: { "content-type": "application/json" } }));
    const api = new TelegramApi("secret", fetcher as typeof fetch);
    await api.deleteCommands(42);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.every((call) => String(call[0]).includes("/deleteMyCommands"))).toBe(true);
    expect(fetcher.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))).toEqual([
      {},
      { scope: { type: "all_private_chats" } },
      { scope: { type: "chat", chat_id: 42 } },
    ]);
  });

  it("does not retry permanent polling errors", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: false, error_code: 409, description: "Conflict: another getUpdates request" }), { status: 409, headers: { "content-type": "application/json" } }));
    const api = new TelegramApi("secret", fetcher as typeof fetch);
    const error = await api.getUpdates(0, new AbortController().signal).catch((caught) => caught);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect(error.retryable).toBe(false);
  });

  it("redacts the bot token from network errors", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => { throw new Error(`failed ${url}`); });
    const api = new TelegramApi("secret-token", fetcher as typeof fetch);
    const error = await api.getUpdates(0, new AbortController().signal).catch((caught) => caught as Error);
    expect(error.message).not.toContain("secret-token");
  });
});
