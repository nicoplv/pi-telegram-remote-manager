import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../src/store.js";
import { TelegramBot } from "../src/telegram/bot.js";
import type { TelegramSendOptions, TelegramUpdate } from "../src/telegram/api.js";
import type { AppConfig } from "../src/types.js";

async function setup(paired = false) {
  const dir = await mkdtemp(join(tmpdir(), "tgrm-bot-pairing-"));
  const store = new StateStore(dir);
  const code = store.ensurePairingCode();
  if (paired) store.pairOwner(42, 42, code);
  const sent: Array<{ chatId: number; text: string; options?: TelegramSendOptions }> = [];
  const api = {
    sendText: vi.fn(async (chatId: number, text: string, options?: TelegramSendOptions) => { sent.push({ chatId, text, options }); return [sent.length]; }),
    editText: vi.fn(async () => undefined),
    answerCallback: vi.fn(async () => undefined),
    typing: vi.fn(async () => undefined),
    deleteCommands: vi.fn(async () => undefined),
    getUpdates: vi.fn(async (_offset: number, signal: AbortSignal) => await new Promise<TelegramUpdate[]>((resolve) => {
      signal.addEventListener("abort", () => resolve([]), { once: true });
    })),
  };
  const sessions = Object.assign(new EventEmitter(), { list: () => [], get: () => undefined, recentMessages: async () => [] });
  const projects = { list: async () => [] };
  const extensions = { install: async () => undefined, uninstall: async () => undefined, list: async () => [] };
  const config = { render: { tools: "brief", thinking: "brief", streamIntervalMs: 1000 } } as AppConfig;
  const bot = new TelegramBot(config, api as never, store, projects as never, sessions as never, extensions as never);
  return { bot, store, code, sent, api };
}

describe("TelegramBot pairing and menu startup", () => {
  it("pairs one private owner and installs the persistent Manager menu", async () => {
    const context = await setup();
    await context.bot.handleUpdate({ update_id: 1, message: { message_id: 1, text: `/trm_pair ${context.code}`, from: { id: 42 }, chat: { id: 42, type: "private" } } });
    expect(context.store.getOwner()).toEqual({ userId: 42, chatId: 42 });
    expect(context.api.deleteCommands).toHaveBeenCalledWith(42);
    expect(context.sent[0].options?.persistentKeyboard).toEqual([["☰ Manager"]]);
    expect(context.sent[1].options?.inlineKeyboard?.flat().map((item) => item.text)).toEqual(["Projects", "Sessions", "Manage Pi"]);

    await context.bot.handleUpdate({ update_id: 2, message: { message_id: 2, text: "☰ Manager", from: { id: 99 }, chat: { id: 99, type: "private" } } });
    expect(context.sent.at(-1)).toEqual(expect.objectContaining({ chatId: 99, text: "Unauthorized." }));
    context.store.close();
  });

  it("clears command suggestions and sends a fresh menu on daemon startup", async () => {
    const context = await setup(true);
    context.bot.start();
    await vi.waitFor(() => expect(context.sent.length).toBeGreaterThanOrEqual(2));
    expect(context.api.deleteCommands).toHaveBeenCalledOnce();
    expect(context.api.deleteCommands).toHaveBeenCalledWith(42);
    expect(context.sent[0].options?.persistentKeyboard).toEqual([["☰ Manager"]]);
    expect(context.sent[1].text).toContain("Pi Telegram Remote Manager");
    context.bot.stop();
    context.store.close();
  });
});
