import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../src/store.js";
import { TelegramBot } from "../src/telegram/bot.js";
import type { TelegramButton, TelegramSendOptions, TelegramUpdate } from "../src/telegram/api.js";
import type { AppConfig, ManagedSession } from "../src/types.js";

type SentMessage = { chatId: number; text: string; options?: TelegramSendOptions };

function session(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: "abcdef12-3456-7890-abcd-ef1234567890",
    projectId: "demo",
    piSessionId: "pi-session",
    piSessionPath: "/tmp/pi-session.jsonl",
    tmuxSessionName: "pi-demo-abcdef12",
    friendlyName: "Demo & test",
    state: "busy",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    stopReason: null,
    lastError: null,
    lastUserPreview: null,
    lastAssistantPreview: null,
    ...overrides,
  };
}

async function setup(initialSessions: ManagedSession[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "tgrm-bot-menu-"));
  const store = new StateStore(dir);
  const code = store.ensurePairingCode();
  store.pairOwner(42, 42, code);
  const sent: SentMessage[] = [];
  const edits: Array<{ chatId: number; messageId: number; text: string; buttons?: TelegramButton[][] }> = [];
  const api = {
    sendText: vi.fn(async (chatId: number, text: string, options?: TelegramSendOptions) => { sent.push({ chatId, text, options }); return [sent.length]; }),
    editText: vi.fn(async (chatId: number, messageId: number, text: string, buttons?: TelegramButton[][]) => { edits.push({ chatId, messageId, text, buttons }); }),
    answerCallback: vi.fn(async () => undefined),
    typing: vi.fn(async () => undefined),
    setCommands: vi.fn(async () => undefined),
    deleteCommands: vi.fn(async () => undefined),
  };
  const sessionsList = [...initialSessions];
  const sendMessage = vi.fn(async () => undefined);
  const commands = vi.fn(async () => [] as Array<{ name: string; description?: string; source: "extension" | "prompt" | "skill" }>);
  const sessions = Object.assign(new EventEmitter(), {
    list: () => sessionsList,
    get: (id: string) => sessionsList.find((item) => item.id === id),
    recentMessages: async () => [],
    commands,
    sendMessage,
    create: vi.fn(async (projectId: string) => {
      const created = session({ id: "created1-3456-7890-abcd-ef1234567890", projectId, friendlyName: "New session", state: "running" });
      sessionsList.push(created);
      return created;
    }),
    stop: vi.fn(async () => undefined),
    resume: vi.fn(async (id: string) => {
      const current = sessionsList.find((item) => item.id === id)!;
      current.state = "running";
      return current;
    }),
    rename: vi.fn(async (id: string, name: string) => {
      const current = sessionsList.find((item) => item.id === id)!;
      current.friendlyName = name;
      return current;
    }),
  });
  const projectNames = ["demo"];
  const projects = {
    list: vi.fn(async () => [...projectNames]),
    create: vi.fn(async (id: string) => { projectNames.push(id); return `/projects/${id}`; }),
    resolve: vi.fn(async (id: string) => {
      if (!projectNames.includes(id)) throw new Error(`Project not found: ${id}`);
      return `/projects/${id}`;
    }),
  };
  const extensions = {
    install: vi.fn(async () => undefined),
    uninstall: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    updatePi: vi.fn(async () => undefined),
    list: vi.fn(async () => [] as string[]),
  };
  const config = { render: { tools: "brief", thinking: "brief", streamIntervalMs: 1000 } } as AppConfig;
  const bot = new TelegramBot(config, api as never, store, projects as never, sessions as never, extensions as never);
  return { bot, store, sent, edits, api, projects, sessions, extensions, sendMessage, commands };
}

function message(text: string, updateId = 1): TelegramUpdate {
  return { update_id: updateId, message: { message_id: updateId, text, from: { id: 42 }, chat: { id: 42, type: "private" } } };
}

function callback(data: string, updateId = 2, userId = 42): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: { id: `callback-${updateId}`, data, from: { id: userId }, message: { message_id: 50, from: { id: 42 }, chat: { id: userId, type: "private" } } },
  };
}

function buttonData(sent: SentMessage[], predicate: (button: TelegramButton) => boolean): string {
  for (let index = sent.length - 1; index >= 0; index--) {
    const found = sent[index].options?.inlineKeyboard?.flat().find(predicate);
    if (found) return found.callback_data;
  }
  throw new Error("Button not found");
}

describe("TelegramBot menu workflows", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("opens the three-section menu and shows every project as a button without pagination", async () => {
    const context = await setup([session()]);
    await context.bot.handleUpdate(message("☰ Manager"));
    expect(context.sent.at(-1)?.options?.inlineKeyboard?.flat().map((item) => item.text)).toEqual(["Projects", "Sessions", "Manage Pi"]);

    await context.bot.handleUpdate(callback("projects"));
    expect(context.edits.at(-1)?.buttons?.flat().map((item) => item.text)).toContain("List projects");
    await context.bot.handleUpdate(callback("projects:list", 3));
    const projectButton = context.sent.at(-1)?.options?.inlineKeyboard?.flat().find((item) => item.text === "demo");
    expect(projectButton?.callback_data).toMatch(/^project:select:view:/);
    expect(context.sent.at(-1)?.options?.inlineKeyboard?.flat().some((item) => ["◀", "▶"].includes(item.text))).toBe(false);
    await context.bot.handleUpdate(callback(projectButton!.callback_data, 4));
    expect(context.sent.at(-1)?.text).toContain("<b>demo</b>");
    expect(context.sent.at(-1)?.options?.inlineKeyboard?.flat().some((item) => item.callback_data.startsWith("session:view:"))).toBe(true);

    await context.bot.handleUpdate(callback("projects:create", 5));
    await context.bot.handleUpdate(message("fresh", 6));
    expect(context.projects.create).toHaveBeenCalledWith("fresh");
    expect(context.sent.at(-1)?.text).toContain("<b>fresh</b>");
    context.store.close();
  });

  it("protects a newer typed workflow from an older Cancel button", async () => {
    const active = session();
    const context = await setup([active]);
    await context.bot.handleUpdate(callback("projects:create"));
    const staleCancel = buttonData(context.sent, (item) => item.text === "Cancel");
    await context.bot.handleUpdate(callback(`session:rename:${active.id}`, 3));
    await context.bot.handleUpdate(callback(staleCancel, 4));
    expect(context.sent.at(-1)?.text).toContain("expired or was already handled");
    await context.bot.handleUpdate(message("Renamed", 5));
    expect(context.sessions.rename).toHaveBeenCalledWith(active.id, "Renamed");
    context.store.close();
  });

  it("supports button session selection, rename, steering, stop, resume, and leave", async () => {
    const active = session();
    const sleeping = session({ id: "12345678-3456-7890-abcd-ef1234567890", friendlyName: "Sleeping", state: "sleeping" });
    const context = await setup([active, sleeping]);

    await context.bot.handleUpdate(callback("sessions:active"));
    const activeButton = context.sent.at(-1)?.options?.inlineKeyboard?.flat().find((item) => item.callback_data === `session:view:${active.id}`);
    expect(activeButton?.text).toContain("Demo & test");
    expect(context.sent.at(-1)?.options?.inlineKeyboard?.flat().some((item) => ["◀", "▶"].includes(item.text))).toBe(false);
    await context.bot.handleUpdate(callback(activeButton!.callback_data, 3));
    expect(context.store.getValue("selected_session")).toBe(active.id);
    expect(context.sent.at(-1)?.options?.inlineKeyboard?.flat().map((item) => item.text)).toContain("Steer");

    await context.bot.handleUpdate(callback(`session:rename:${active.id}`, 4));
    await context.bot.handleUpdate(message("New <name>", 5));
    expect(context.sessions.rename).toHaveBeenCalledWith(active.id, "New <name>");
    expect(context.sent.at(-1)?.text).toContain("New &lt;name&gt;");

    await context.bot.handleUpdate(callback(`session:steer:${active.id}`, 6));
    await context.bot.handleUpdate(message("prioritize tests", 7));
    expect(context.sendMessage).toHaveBeenCalledWith(active.id, "prioritize tests", true);
    await context.bot.handleUpdate(callback(`session:stop:${active.id}`, 8));
    expect(context.sessions.stop).toHaveBeenCalledWith(active.id, "manual");

    await context.bot.handleUpdate(callback(`session:resume:${sleeping.id}`, 9));
    expect(context.sessions.resume).toHaveBeenCalledWith(sleeping.id);
    expect(context.store.getValue("selected_session")).toBe(sleeping.id);
    await context.bot.handleUpdate(callback(`session:leave:${sleeping.id}`, 10));
    expect(context.store.getValue("selected_session")).toBeUndefined();
    expect(context.sessions.stop).toHaveBeenCalledTimes(1);
    context.store.close();
  });

  it("publishes selected-session commands and translates Telegram-safe aliases", async () => {
    const active = session({ state: "running" });
    const context = await setup([active]);
    context.commands.mockResolvedValue([
      { name: "review-changes", description: "Review the current changes", source: "extension" },
      { name: "skill:web-search", description: "Search the web", source: "skill" },
      { name: "trm_pair", source: "prompt" },
      { name: "review_changes", source: "prompt" },
    ]);

    await context.bot.handleUpdate(callback(`session:view:${active.id}`));
    expect(context.api.setCommands).toHaveBeenCalledWith(42, [
      { command: "review_changes", description: "Review the current changes" },
      { command: "skill_web_search", description: "Search the web" },
      { command: "pi_trm_pair", description: "Prompt command" },
      { command: "review_changes_2", description: "Prompt command" },
    ]);

    await context.bot.handleUpdate(message("/review_changes focus on tests", 3));
    expect(context.sendMessage).toHaveBeenLastCalledWith(active.id, "/review-changes focus on tests", false);
    await context.bot.handleUpdate(message("/skill_web_search Telegram", 4));
    expect(context.sendMessage).toHaveBeenLastCalledWith(active.id, "/skill:web-search Telegram", false);
    await context.bot.handleUpdate(message("/unknown", 5));
    expect(context.sendMessage).toHaveBeenLastCalledWith(active.id, "/unknown", false);

    await context.bot.handleUpdate(callback(`session:leave:${active.id}`, 6));
    expect(context.api.deleteCommands).toHaveBeenCalledWith(42);
    context.store.close();
  });

  it("chooses a new session project from unpaginated project buttons", async () => {
    const context = await setup();
    await context.bot.handleUpdate(callback("sessions:new"));
    const projectButton = context.sent.at(-1)?.options?.inlineKeyboard?.flat().find((item) => item.text === "demo");
    expect(projectButton?.callback_data).toMatch(/^project:select:new-session:/);
    expect(context.sent.at(-1)?.options?.inlineKeyboard?.flat().some((item) => ["◀", "▶"].includes(item.text))).toBe(false);
    await context.bot.handleUpdate(callback(projectButton!.callback_data, 3));
    expect(context.sessions.create).toHaveBeenCalledWith("demo");
    context.store.close();
  });

  it("shows Manage Pi actions without a duplicate top-level uninstall action", async () => {
    const context = await setup();
    await context.bot.handleUpdate(callback("extensions"));
    expect(context.edits.at(-1)?.text).toContain("Manage Pi");
    expect(context.edits.at(-1)?.buttons?.flat().map((item) => item.text)).toEqual([
      "List extensions", "Install extension", "Update extension", "Update Pi", "Back", "Home",
    ]);
    expect(context.edits.at(-1)?.buttons?.flat().map((item) => item.text)).not.toContain("Uninstall");
    context.store.close();
  });

  it("installs a global package only after button confirmation and prevents double clicks", async () => {
    const context = await setup();
    await context.bot.handleUpdate(callback("ext:scope:install"));
    expect(context.edits.at(-1)?.buttons?.flat().map((item) => item.text)).toEqual(expect.arrayContaining(["Global", "Project"]));
    await context.bot.handleUpdate(callback("ext:global:install", 3));
    await context.bot.handleUpdate(message("./local-extension.ts", 4));
    expect(context.sent.at(-1)?.text).toContain("whitespace-free");
    await context.bot.handleUpdate(message("https://example.com/tools.git?name=<tools>", 5));
    expect(context.extensions.install).not.toHaveBeenCalled();
    expect(context.sent.at(-1)?.text).toContain("&lt;tools&gt;");
    const confirm = buttonData(context.sent, (item) => item.text === "Confirm");

    await context.bot.handleUpdate(callback(confirm, 6));
    expect(context.extensions.install).toHaveBeenCalledWith({ scope: "global" }, "https://example.com/tools.git?name=<tools>");
    expect(context.sent.at(-1)?.text).toContain("<code>/reload</code>");
    await context.bot.handleUpdate(callback(confirm, 7));
    expect(context.extensions.install).toHaveBeenCalledTimes(1);
    expect(context.sent.at(-1)?.text).toContain("already handled");
    context.store.close();
  });

  it("lists project packages as buttons after project button selection", async () => {
    const context = await setup();
    context.extensions.list.mockResolvedValue(["npm:@scope/<tools>"]);
    await context.bot.handleUpdate(callback("ext:project:list"));
    const projectButton = context.sent.at(-1)?.options?.inlineKeyboard?.flat().find((item) => item.text === "demo");
    await context.bot.handleUpdate(callback(projectButton!.callback_data, 3));
    expect(context.projects.resolve).toHaveBeenCalledWith("demo");
    expect(context.extensions.list).toHaveBeenCalledWith({ scope: "project", projectId: "demo" });
    const packageButton = context.sent.at(-1)?.options?.inlineKeyboard?.flat().find((item) => item.text.includes("npm:@scope/<tools>"));
    expect(packageButton).toBeDefined();
    expect(context.sent.at(-1)?.options?.inlineKeyboard?.flat().some((item) => ["◀", "▶"].includes(item.text))).toBe(false);
    await context.bot.handleUpdate(callback(packageButton!.callback_data, 4));
    expect(context.sent.at(-1)?.text).toContain("npm:@scope/&lt;tools&gt;");
    expect(context.sent.at(-1)?.options?.inlineKeyboard?.flat().map((item) => item.text)).toContain("Uninstall");
    context.store.close();
  });

  it("selects an exact installed source button before uninstall confirmation", async () => {
    const context = await setup();
    context.extensions.list.mockResolvedValue(["npm:first", "git:github.com/example/a-very-long-package-name"]);
    await context.bot.handleUpdate(callback("ext:global:list"));
    const packageButtons = context.sent.at(-1)?.options?.inlineKeyboard?.flat().filter((item) => item.callback_data.startsWith("ext:package:")) ?? [];
    expect(packageButtons).toHaveLength(2);
    expect(packageButtons.every((item) => !item.callback_data.includes("npm:first"))).toBe(true);
    await context.bot.handleUpdate(callback(packageButtons[1].callback_data, 3));
    expect(context.sent.at(-1)?.text).toContain("a-very-long-package-name");
    const uninstall = buttonData(context.sent, (item) => item.text === "Uninstall");
    await context.bot.handleUpdate(callback(uninstall, 4));
    const confirm = buttonData(context.sent, (item) => item.text === "Confirm");
    await context.bot.handleUpdate(callback(confirm, 5));
    expect(context.extensions.uninstall).toHaveBeenCalledWith({ scope: "global" }, "git:github.com/example/a-very-long-package-name");
    context.store.close();
  });

  it("updates a selected extension only after confirmation", async () => {
    const context = await setup();
    context.extensions.list.mockResolvedValue(["npm:tools"]);
    await context.bot.handleUpdate(callback("ext:global:update"));
    const packageButton = buttonData(context.sent, (item) => item.callback_data.startsWith("ext:package:"));
    await context.bot.handleUpdate(callback(packageButton, 3));
    const update = buttonData(context.sent, (item) => item.text === "Update extension");
    expect(context.extensions.update).not.toHaveBeenCalled();
    await context.bot.handleUpdate(callback(update, 4));
    const confirm = buttonData(context.sent, (item) => item.text === "Confirm");
    await context.bot.handleUpdate(callback(confirm, 5));
    expect(context.extensions.update).toHaveBeenCalledWith({ scope: "global" }, "npm:tools");
    expect(context.sent.at(-1)?.text).toContain("Existing sessions are unchanged");
    context.store.close();
  });

  it("updates Pi only after confirmation and prevents repeated execution", async () => {
    const context = await setup();
    await context.bot.handleUpdate(callback("pi:update"));
    expect(context.extensions.updatePi).not.toHaveBeenCalled();
    const confirm = buttonData(context.sent, (item) => item.text === "Confirm");
    await context.bot.handleUpdate(callback(confirm, 3));
    expect(context.extensions.updatePi).toHaveBeenCalledOnce();
    expect(context.sent.at(-1)?.text).toContain("restart them to use the updated version");
    await context.bot.handleUpdate(callback(confirm, 4));
    expect(context.extensions.updatePi).toHaveBeenCalledOnce();
    expect(context.sent.at(-1)?.text).toContain("already handled");
    context.store.close();
  });

  it("reports an empty extension scope without creating a mutation", async () => {
    const context = await setup();
    await context.bot.handleUpdate(callback("ext:global:list"));
    expect(context.sent.at(-1)?.text).toContain("No remote packages");
    expect(context.extensions.uninstall).not.toHaveBeenCalled();
    context.store.close();
  });

  it("cancels and expires package workflows", async () => {
    vi.useFakeTimers();
    const context = await setup();
    await context.bot.handleUpdate(callback("ext:global:install"));
    const cancel = buttonData(context.sent, (item) => item.text === "Cancel");
    await context.bot.handleUpdate(callback(cancel, 3));
    expect(context.edits.at(-1)?.text).toContain("Manage Pi");

    await context.bot.handleUpdate(callback("ext:global:install", 4));
    vi.advanceTimersByTime(300_001);
    await context.bot.handleUpdate(message("npm:tools", 5));
    expect(context.extensions.install).not.toHaveBeenCalled();
    expect(context.sent.some((item) => item.text.includes("expired"))).toBe(true);
    context.store.close();
  });

  it("sanitizes package failures", async () => {
    const context = await setup();
    context.extensions.install.mockRejectedValue(new Error("failed <secret>"));
    await context.bot.handleUpdate(callback("ext:global:install"));
    await context.bot.handleUpdate(message("npm:tools", 3));
    const confirm = buttonData(context.sent, (item) => item.text === "Confirm");
    await context.bot.handleUpdate(callback(confirm, 4));
    expect(context.sent.at(-1)?.text).toContain("failed &lt;secret&gt;");
    context.store.close();
  });

  it("rejects retired manager commands without forwarding them", async () => {
    const context = await setup();
    context.store.setValue("selected_session", "session-1");
    await context.bot.handleUpdate(message("/trm_install global npm:tools"));
    expect(context.sent.at(-2)?.text).toContain("moved to the ☰ Manager menu");
    expect(context.sent.at(-1)?.text).toContain("Pi Telegram Remote Manager");
    expect(context.sendMessage).not.toHaveBeenCalled();
    expect(context.extensions.install).not.toHaveBeenCalled();
    context.store.close();
  });

  it("forwards Pi messages only when no menu input is pending", async () => {
    const active = session();
    const context = await setup([active]);
    context.store.setValue("selected_session", active.id);
    await context.bot.handleUpdate(message("/reload"));
    expect(context.sendMessage).toHaveBeenCalledWith(active.id, "/reload", false);

    await context.bot.handleUpdate(callback("ext:global:install", 3));
    await context.bot.handleUpdate(message("/reload", 4));
    expect(context.sendMessage).toHaveBeenCalledTimes(1);
    expect(context.sent.at(-1)?.text).toContain("whitespace-free");
    await context.bot.handleUpdate(message("☰ Manager", 5));
    expect(context.sent.at(-1)?.text).toContain("Pi Telegram Remote Manager");
    context.store.close();
  });

  it("acknowledges authorized callbacks and rejects unauthorized callbacks", async () => {
    const context = await setup();
    await context.bot.handleUpdate(callback("projects"));
    expect(context.api.answerCallback).toHaveBeenCalledWith("callback-2");
    await context.bot.handleUpdate(callback("projects", 3, 99));
    expect(context.api.answerCallback).toHaveBeenLastCalledWith("callback-3", "Unauthorized");
    context.store.close();
  });
});
