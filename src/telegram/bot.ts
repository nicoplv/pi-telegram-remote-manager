import { createHash, randomUUID } from "node:crypto";
import type { BridgeEvent } from "../bridge/protocol.js";
import { type PiExtensionManager, type PiExtensionTarget, validateSource } from "../extensions/pi-extension-manager.js";
import type { ProjectManager } from "../projects/project-manager.js";
import type { SessionManager } from "../sessions/session-manager.js";
import type { StateStore } from "../store.js";
import type { AppConfig, ManagedSession } from "../types.js";
import { log } from "../logger.js";
import { TelegramApi, TelegramApiError, type TelegramButton, type TelegramCallback, type TelegramMessage, type TelegramUpdate } from "./api.js";
import { escapeHtml, markdownToTelegramHtml, summarize } from "./render.js";

type ExtensionAction = "list" | "install" | "update";
type PackageChoiceAction = "list" | "update";
type ProjectChoiceAction = "view" | "new-session" | "ext-list" | "ext-install" | "ext-update";
type PendingWorkflow = (
  | { kind: "create-project" }
  | { kind: "rename-session"; sessionId: string }
  | { kind: "steer-session"; sessionId: string }
  | { kind: "extension-source"; target: PiExtensionTarget }
  | { kind: "package-choice"; action: PackageChoiceAction; target: PiExtensionTarget; sources: string[] }
  | { kind: "package-selected"; action: PackageChoiceAction; target: PiExtensionTarget; source: string }
  | { kind: "extension-confirm"; action: "install" | "uninstall" | "update"; target: PiExtensionTarget; source: string }
  | { kind: "pi-update-confirm" }
) & { id: string; expiresAt: number };
type StreamState = { messageId?: number; lastEdit: number; latest: string };
const WORKFLOW_TIMEOUT_MS = 300_000;
const MANAGER_BUTTON = "☰ Manager";

export class TelegramBot {
  private abort?: AbortController;
  private readonly failures = new Map<number, number[]>();
  private pending?: PendingWorkflow;
  private readonly activeTurns = new Set<string>();
  private readonly streams = new Map<string, StreamState>();
  private readonly toolUpdateAt = new Map<string, number>();
  private readonly typingAt = new Map<string, number>();

  constructor(
    private readonly config: AppConfig,
    private readonly api: TelegramApi,
    private readonly store: StateStore,
    private readonly projects: ProjectManager,
    private readonly sessions: SessionManager,
    private readonly extensions: PiExtensionManager,
  ) {
    sessions.on("bridge_event", (event: BridgeEvent, session: ManagedSession) => void this.onBridgeEvent(event, session));
  }

  start(): void {
    this.abort = new AbortController();
    void this.initializeTelegram();
    void this.poll(this.abort.signal);
  }
  stop(): void { this.abort?.abort(); }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message) await this.handleMessage(update.message);
    else if (update.callback_query) await this.handleCallback(update.callback_query);
  }

  private async initializeTelegram(): Promise<void> {
    const owner = this.store.getOwner();
    await this.api.deleteCommands(owner?.chatId).catch((error) => log("warn", "Failed to clear registered Telegram commands", { error: errorText(error) }));
    if (!owner) return;
    try {
      await this.sendManagerKeyboard(owner.chatId, "Manager controls are ready.");
      await this.showMain(owner.chatId);
    } catch (error) {
      log("warn", "Failed to initialize Telegram manager menu", { error: errorText(error) });
    }
  }

  private async poll(signal: AbortSignal): Promise<void> {
    let backoff = 500;
    let lastFailureLogAt = 0;
    let hadPollingFailure = false;
    while (!signal.aborted) {
      const offset = (this.store.getValue<number>("telegram_update_id") ?? -1) + 1;
      try {
        const updates = await this.api.getUpdates(offset, signal);
        for (const update of updates) {
          try { await this.handleUpdate(update); }
          catch (error) { log("error", "Telegram update failed", { updateId: update.update_id, error: errorText(error) }); }
          this.store.setValue("telegram_update_id", update.update_id);
        }
        if (hadPollingFailure) log("info", "Telegram polling recovered");
        hadPollingFailure = false;
        backoff = 500;
      } catch (error) {
        if (signal.aborted) break;
        hadPollingFailure = true;
        if (error instanceof TelegramApiError && !error.retryable) {
          log("error", "Telegram polling stopped after a permanent API error", { errorCode: error.errorCode, error: error.message });
          const owner = this.store.getOwner();
          if (owner && error.errorCode === 409) {
            await this.api.sendText(owner.chatId, "⚠️ Telegram polling stopped because another process is polling this bot. Stop the other process, then restart this manager.").catch(() => undefined);
          }
          return;
        }
        if (Date.now() - lastFailureLogAt >= 60_000 || lastFailureLogAt === 0) {
          log("warn", "Telegram polling temporarily failed; retrying", { error: errorText(error) });
          lastFailureLogAt = Date.now();
        }
        await new Promise((resolve) => setTimeout(resolve, backoff));
        backoff = Math.min(backoff * 2, 10_000);
      }
    }
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    if (!message.from || message.from.is_bot || message.chat.type !== "private") return;
    const owner = this.store.getOwner();
    if (!owner) { await this.handlePairing(message); return; }
    if (message.from.id !== owner.userId || message.chat.id !== owner.chatId) { await this.api.sendText(message.chat.id, "Unauthorized."); return; }
    const text = message.text?.trim();
    if (!text) return;
    if (text === MANAGER_BUTTON) { this.pending = undefined; await this.showMain(owner.chatId); return; }
    if (/^\/trm_pair(?:\s|$)/.test(text)) {
      this.pending = undefined;
      await this.sendManagerKeyboard(owner.chatId, "This bot is already paired.");
      await this.showMain(owner.chatId);
      return;
    }
    if (text.startsWith("/trm_")) {
      this.pending = undefined;
      await this.api.sendText(owner.chatId, `Remote-manager commands have moved to the ${MANAGER_BUTTON} menu.`);
      await this.showMain(owner.chatId);
      return;
    }
    if (this.pending) { await this.consumePending(owner.chatId, text); return; }
    await this.forward(owner.chatId, text, false);
  }

  private async handlePairing(message: TelegramMessage): Promise<void> {
    const match = /^\/trm_pair\s+(\d{6})$/.exec(message.text?.trim() ?? "");
    if (!match || this.pairingLimited(message.from!.id)) { await this.api.sendText(message.chat.id, "Unauthorized."); return; }
    if (!this.store.pairOwner(message.from!.id, message.chat.id, match[1])) {
      this.recordPairingFailure(message.from!.id);
      await this.api.sendText(message.chat.id, "Unauthorized.");
      return;
    }
    this.failures.delete(message.from!.id);
    await this.api.deleteCommands(message.chat.id).catch((error) => log("warn", "Failed to clear registered Telegram commands", { error: errorText(error) }));
    await this.sendManagerKeyboard(message.chat.id, "✅ Paired. This Telegram account is now the bot owner.");
    await this.showMain(message.chat.id);
  }

  private pairingLimited(userId: number): boolean {
    const recent = (this.failures.get(userId) ?? []).filter((time) => Date.now() - time < 60_000);
    this.failures.set(userId, recent);
    return recent.length >= 5;
  }

  private recordPairingFailure(userId: number): void { this.failures.set(userId, [...(this.failures.get(userId) ?? []), Date.now()]); }

  private async handleCallback(callback: TelegramCallback): Promise<void> {
    const owner = this.store.getOwner();
    if (!owner || callback.from.id !== owner.userId || callback.message?.chat.id !== owner.chatId) {
      await this.api.answerCallback(callback.id, "Unauthorized").catch(() => undefined);
      return;
    }
    await this.api.answerCallback(callback.id).catch(() => undefined);
    const data = callback.data ?? "";
    const chatId = owner.chatId;
    const messageId = callback.message.message_id;
    if (!data.startsWith("ext:package:") && !data.startsWith("ext:uninstall:") && !data.startsWith("ext:update:") && !data.startsWith("ext:packages:") && !data.startsWith("ext:confirm:") && !data.startsWith("pi:confirm:") && !data.startsWith("flow:cancel:")) this.pending = undefined;

    if (data === "home") return await this.showMain(chatId, messageId);
    if (data === "projects") return await this.showProjectsMenu(chatId, messageId);
    if (data === "projects:list") return await this.showProjectChoices(chatId, "view");
    if (data === "projects:create") return await this.prompt(chatId, "Type the new project name.", { kind: "create-project", id: workflowId(), expiresAt: expiresAt() });
    if (data === "sessions") return await this.showSessionsMenu(chatId, messageId);
    if (data === "sessions:active") return await this.showSessionList(chatId, true);
    if (data === "sessions:sleeping") return await this.showSessionList(chatId, false);
    if (data === "sessions:new") return await this.showProjectChoices(chatId, "new-session");
    if (data === "sessions:current") return await this.showCurrentSession(chatId, messageId);
    if (data === "extensions") return await this.showExtensionsMenu(chatId, messageId);
    const extensionScope = /^ext:scope:(list|install|update)$/.exec(data);
    if (extensionScope) return await this.showExtensionScopes(chatId, extensionScope[1] as ExtensionAction, messageId);
    const globalExtension = /^ext:global:(list|install|update)$/.exec(data);
    if (globalExtension) return await this.handleExtensionTarget(chatId, globalExtension[1] as ExtensionAction, { scope: "global" });
    const projectExtension = /^ext:project:(list|install|update)$/.exec(data);
    if (projectExtension) {
      return await this.showProjectChoices(chatId, `ext-${projectExtension[1]}` as ProjectChoiceAction);
    }
    if (data === "pi:update") return await this.showPiUpdateConfirmation(chatId);
    const cancellation = /^flow:cancel:([a-f0-9]{8})$/.exec(data);
    if (cancellation) return await this.cancelWorkflow(chatId, messageId, cancellation[1]);

    const projectChoice = /^project:select:(view|new-session|ext-list|ext-install|ext-update):([a-f0-9]{12})$/.exec(data);
    if (projectChoice) {
      const action = projectChoice[1] as ProjectChoiceAction;
      const project = await this.resolveProjectKey(projectChoice[2]);
      if (!project) { await this.api.sendText(chatId, "That project is no longer available.", projectNavigation()); return; }
      if (action === "view") return await this.showProject(chatId, project);
      if (action === "new-session") return await this.startSession(chatId, project);
      await this.projects.resolve(project);
      return await this.handleExtensionTarget(chatId, action.slice(4) as ExtensionAction, { scope: "project", projectId: project });
    }

    const projectAction = /^project:new:([a-f0-9]{12})$/.exec(data);
    if (projectAction) {
      const project = await this.resolveProjectKey(projectAction[1]);
      if (!project) { await this.api.sendText(chatId, "That project is no longer available.", projectNavigation()); return; }
      return await this.startSession(chatId, project);
    }

    const sessionAction = /^session:(view|stop|resume|rename|steer|leave):(.+)$/.exec(data);
    if (sessionAction) return await this.handleSessionAction(chatId, sessionAction[1], sessionAction[2]);

    const packageChoice = /^ext:package:([a-f0-9]{8}):(\d+)$/.exec(data);
    if (packageChoice) return await this.showSelectedPackage(chatId, packageChoice[1], Number(packageChoice[2]));
    const packageUninstall = /^ext:uninstall:([a-f0-9]{8})$/.exec(data);
    if (packageUninstall) return await this.uninstallSelectedPackage(chatId, packageUninstall[1]);
    const packageUpdate = /^ext:update:([a-f0-9]{8})$/.exec(data);
    if (packageUpdate) return await this.updateSelectedPackage(chatId, packageUpdate[1]);
    const packagesBack = /^ext:packages:([a-f0-9]{8})$/.exec(data);
    if (packagesBack) return await this.returnToPackageChoices(chatId, packagesBack[1]);
    const extensionConfirmation = /^ext:confirm:([a-f0-9]{8})$/.exec(data);
    if (extensionConfirmation) return await this.confirmExtensionAction(chatId, extensionConfirmation[1]);
    const piUpdateConfirmation = /^pi:confirm:([a-f0-9]{8})$/.exec(data);
    if (piUpdateConfirmation) return await this.confirmPiUpdate(chatId, piUpdateConfirmation[1]);
  }

  private async consumePending(chatId: number, text: string): Promise<void> {
    const pending = this.pending!;
    if (pending.expiresAt <= Date.now()) {
      this.pending = undefined;
      await this.api.sendText(chatId, "That request expired. Open the Manager menu to try again.");
      await this.showMain(chatId);
      return;
    }
    if (["package-choice", "package-selected", "extension-confirm", "pi-update-confirm"].includes(pending.kind)) {
      await this.api.sendText(chatId, "Use the displayed buttons, or tap Cancel.", promptNavigation(pending.id));
      return;
    }
    try {
      if (pending.kind === "create-project") {
        await this.projects.create(text);
        this.pending = undefined;
        await this.api.sendText(chatId, `✅ Created project <code>${escapeHtml(text)}</code>.`);
        await this.showProject(chatId, text);
      } else if (pending.kind === "rename-session") {
        const renamed = await this.sessions.rename(pending.sessionId, text);
        this.pending = undefined;
        await this.api.sendText(chatId, `✅ Renamed session to ${escapeHtml(renamed.friendlyName)}.`);
        await this.showSession(chatId, renamed.id);
      } else if (pending.kind === "steer-session") {
        const session = this.sessions.get(pending.sessionId);
        if (!session || session.state !== "busy") throw new Error("The session is no longer busy");
        this.activeTurns.add(session.id);
        await this.sessions.sendMessage(session.id, text, true);
        this.pending = undefined;
        await this.api.typing(chatId);
      } else if (pending.kind === "extension-source") {
        validateSource(text);
        this.pending = undefined;
        await this.showExtensionConfirmation(chatId, "install", pending.target, text);
      }
    } catch (error) {
      if (pending.kind === "steer-session") this.activeTurns.delete(pending.sessionId);
      await this.api.sendText(chatId, `❌ ${escapeHtml(errorText(error))}\n\nPlease try again, or cancel.`, promptNavigation(pending.id));
    }
  }

  private async handleSessionAction(chatId: number, action: string, id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) { await this.api.sendText(chatId, "That session no longer exists.", sessionMenuNavigation()); return; }
    try {
      if (action === "view") {
        this.store.setValue("selected_session", id);
        await this.showSession(chatId, id);
      } else if (action === "stop") {
        await this.sessions.stop(id, "manual");
        await this.api.sendText(chatId, `✅ Stop requested for ${escapeHtml(session.friendlyName)}.`);
        await this.showSessionsMenu(chatId);
      } else if (action === "resume") {
        const resumed = await this.sessions.resume(id);
        this.store.setValue("selected_session", id);
        await this.showSession(chatId, resumed.id);
      } else if (action === "rename") {
        await this.prompt(chatId, `Type a new name for <b>${escapeHtml(session.friendlyName)}</b>.`, {
          kind: "rename-session", sessionId: id, id: workflowId(), expiresAt: expiresAt(),
        });
      } else if (action === "steer") {
        if (session.state !== "busy") throw new Error("The session is no longer busy");
        await this.prompt(chatId, `Type the steering instruction for <b>${escapeHtml(session.friendlyName)}</b>.`, {
          kind: "steer-session", sessionId: id, id: workflowId(), expiresAt: expiresAt(),
        });
      } else if (action === "leave") {
        if (this.store.getValue<string>("selected_session") !== id) throw new Error("That session is no longer selected");
        await this.leaveSession(chatId);
        await this.showSessionsMenu(chatId);
      }
    } catch (error) { await this.api.sendText(chatId, `❌ ${escapeHtml(errorText(error))}`, sessionNavigation(id)); }
  }

  private async handleExtensionTarget(chatId: number, action: ExtensionAction, target: PiExtensionTarget): Promise<void> {
    if (action === "install") {
      return await this.prompt(chatId, `Type the remote package source to install ${extensionTargetSuccessText(target)}.`, {
        kind: "extension-source", target, id: workflowId(), expiresAt: expiresAt(),
      });
    }
    await this.showPackageChoices(chatId, target, action);
  }

  private async showPackageChoices(chatId: number, target: PiExtensionTarget, action: PackageChoiceAction): Promise<void> {
    try {
      const sources = await this.extensions.list(target);
      if (!sources.length) {
        await this.api.sendText(chatId, "No remote packages are installed in this scope.", extensionNavigation());
        return;
      }
      const id = workflowId();
      this.pending = { kind: "package-choice", id, action, target, sources, expiresAt: expiresAt() };
      const rows = sources.map((source, index) => [button(`${index + 1}. ${shortButtonText(source)}`, `ext:package:${id}:${index}`)]);
      rows.push([button("Cancel", `flow:cancel:${id}`), button("Home", "home")]);
      const heading = target.scope === "global" ? "Global Pi packages" : `Pi packages for ${escapeHtml(target.projectId)}`;
      await this.api.sendText(chatId, `<b>${heading}</b>\nSelect a package${action === "update" ? " to update" : ""}.`, { inlineKeyboard: rows });
    } catch (error) { await this.api.sendText(chatId, `❌ ${escapeHtml(errorText(error))}`, extensionNavigation()); }
  }

  private async showSelectedPackage(chatId: number, id: string, index: number): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.kind !== "package-choice" || pending.id !== id || pending.expiresAt <= Date.now() || !pending.sources[index]) {
      if (pending?.kind === "package-choice" && pending.id === id) this.pending = undefined;
      await this.api.sendText(chatId, "That package selection expired or was already handled.", extensionNavigation());
      return;
    }
    const source = pending.sources[index];
    this.pending = { kind: "package-selected", id, action: pending.action, target: pending.target, source, expiresAt: expiresAt() };
    await this.api.sendText(
      chatId,
      `<b>Pi package</b>\nScope: ${extensionTargetHtml(pending.target)}\nSource: <code>${escapeHtml(source)}</code>`,
      { inlineKeyboard: [[button(pending.action === "update" ? "Update extension" : "Uninstall", pending.action === "update" ? `ext:update:${id}` : `ext:uninstall:${id}`)], [button("Back", `ext:packages:${id}`), button("Home", "home")]] },
    );
  }

  private async uninstallSelectedPackage(chatId: number, id: string): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.kind !== "package-selected" || pending.action !== "list" || pending.id !== id || pending.expiresAt <= Date.now()) {
      if (pending?.kind === "package-selected" && pending.id === id) this.pending = undefined;
      await this.api.sendText(chatId, "That package selection expired or was already handled.", extensionNavigation());
      return;
    }
    this.pending = undefined;
    await this.showExtensionConfirmation(chatId, "uninstall", pending.target, pending.source);
  }

  private async updateSelectedPackage(chatId: number, id: string): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.kind !== "package-selected" || pending.action !== "update" || pending.id !== id || pending.expiresAt <= Date.now()) {
      if (pending?.kind === "package-selected" && pending.id === id) this.pending = undefined;
      await this.api.sendText(chatId, "That package selection expired or was already handled.", extensionNavigation());
      return;
    }
    this.pending = undefined;
    await this.showExtensionConfirmation(chatId, "update", pending.target, pending.source);
  }

  private async returnToPackageChoices(chatId: number, id: string): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.kind !== "package-selected" || pending.id !== id || pending.expiresAt <= Date.now()) {
      if (pending?.kind === "package-selected" && pending.id === id) this.pending = undefined;
      await this.api.sendText(chatId, "That package selection expired or was already handled.", extensionNavigation());
      return;
    }
    this.pending = undefined;
    await this.showPackageChoices(chatId, pending.target, pending.action);
  }

  private async showExtensionConfirmation(chatId: number, action: "install" | "uninstall" | "update", target: PiExtensionTarget, source: string): Promise<void> {
    const id = workflowId();
    this.pending = { kind: "extension-confirm", id, action, target, source, expiresAt: expiresAt() };
    const verb = action === "install" ? "Install" : action === "uninstall" ? "Uninstall" : "Update";
    await this.api.sendText(
      chatId,
      `<b>${verb} Pi package?</b>\nScope: ${extensionTargetHtml(target)}\nSource: <code>${escapeHtml(source)}</code>\n\n⚠️ Pi packages can run code with full access to this machine.`,
      { inlineKeyboard: [[button("Confirm", `ext:confirm:${id}`), button("Cancel", `flow:cancel:${id}`)], [button("Home", "home")]] },
    );
  }

  private async confirmExtensionAction(chatId: number, id: string): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.kind !== "extension-confirm" || pending.id !== id || pending.expiresAt <= Date.now()) {
      if (pending?.kind === "extension-confirm" && pending.id === id) this.pending = undefined;
      await this.api.sendText(chatId, "That package action expired or was already handled.", extensionNavigation());
      return;
    }
    this.pending = undefined;
    const progress = pending.action === "install" ? "Installing" : pending.action === "uninstall" ? "Uninstalling" : "Updating";
    await this.api.sendText(chatId, `${progress} <code>${escapeHtml(pending.source)}</code>…`);
    try {
      if (pending.action === "install") await this.extensions.install(pending.target, pending.source);
      else if (pending.action === "uninstall") await this.extensions.uninstall(pending.target, pending.source);
      else await this.extensions.update(pending.target, pending.source);
      const completed = pending.action === "install" ? "Installed" : pending.action === "uninstall" ? "Uninstalled" : "Updated";
      await this.api.sendText(
        chatId,
        `✅ ${completed} <code>${escapeHtml(pending.source)}</code> ${extensionTargetSuccessText(pending.target)}.\n\nExisting sessions are unchanged. Select each session and send <code>/reload</code>, or restart it.`,
        extensionNavigation(),
      );
    } catch (error) { await this.api.sendText(chatId, `❌ ${escapeHtml(errorText(error))}`, extensionNavigation()); }
  }

  private async showPiUpdateConfirmation(chatId: number): Promise<void> {
    const id = workflowId();
    this.pending = { kind: "pi-update-confirm", id, expiresAt: expiresAt() };
    await this.api.sendText(
      chatId,
      "<b>Update Pi?</b>\n\n⚠️ This replaces executable code used to start new Pi sessions.",
      { inlineKeyboard: [[button("Confirm", `pi:confirm:${id}`), button("Cancel", `flow:cancel:${id}`)], [button("Home", "home")]] },
    );
  }

  private async confirmPiUpdate(chatId: number, id: string): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.kind !== "pi-update-confirm" || pending.id !== id || pending.expiresAt <= Date.now()) {
      if (pending?.kind === "pi-update-confirm" && pending.id === id) this.pending = undefined;
      await this.api.sendText(chatId, "That Pi update expired or was already handled.", extensionNavigation());
      return;
    }
    this.pending = undefined;
    await this.api.sendText(chatId, "Updating Pi…");
    try {
      await this.extensions.updatePi();
      await this.api.sendText(chatId, "✅ Pi update completed. Existing sessions keep running their current Pi process; restart them to use the updated version.", extensionNavigation());
    } catch (error) { await this.api.sendText(chatId, `❌ ${escapeHtml(errorText(error))}`, extensionNavigation()); }
  }

  private async cancelWorkflow(chatId: number, messageId: number, id: string): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.id !== id || pending.expiresAt <= Date.now()) {
      if (pending?.id === id) this.pending = undefined;
      await this.api.sendText(chatId, "That request expired or was already handled.");
      return;
    }
    this.pending = undefined;
    if (["extension-source", "package-choice", "package-selected", "extension-confirm", "pi-update-confirm"].includes(pending.kind)) {
      await this.showExtensionsMenu(chatId, messageId);
    } else if (pending.kind === "create-project") {
      await this.showProjectsMenu(chatId, messageId);
    } else if (pending.kind === "rename-session" || pending.kind === "steer-session") {
      await this.showSession(chatId, pending.sessionId, messageId);
    } else {
      await this.showSessionsMenu(chatId, messageId);
    }
  }

  private async forward(chatId: number, text: string, steer: boolean): Promise<void> {
    const id = this.store.getValue<string>("selected_session");
    if (!id) { await this.api.sendText(chatId, `No session is selected. Tap ${MANAGER_BUTTON} to choose one.`); return; }
    try { this.activeTurns.add(id); await this.sessions.sendMessage(id, text, steer); await this.api.typing(chatId); }
    catch (error) { this.activeTurns.delete(id); await this.api.sendText(chatId, `❌ ${escapeHtml(errorText(error))}`); }
  }

  private async leaveSession(chatId: number): Promise<void> {
    const id = this.store.getValue<string>("selected_session");
    if (!id) {
      await this.api.sendText(chatId, "No Pi session is selected.");
      return;
    }
    this.store.deleteValue("selected_session");
    this.activeTurns.delete(id);
    this.streams.delete(id);
    this.typingAt.delete(id);
    await this.api.sendText(chatId, "✅ Left the selected Pi session. The Pi/tmux session is still open.");
  }

  private async sendManagerKeyboard(chatId: number, text: string): Promise<void> {
    await this.api.sendText(chatId, text, { persistentKeyboard: [[MANAGER_BUTTON]] });
  }

  private async renderMenu(chatId: number, html: string, buttons: TelegramButton[][], messageId?: number): Promise<void> {
    if (messageId) {
      try { await this.api.editText(chatId, messageId, html, buttons); return; }
      catch { /* The source message may be too old or no longer editable. */ }
    }
    await this.api.sendText(chatId, html, { inlineKeyboard: buttons });
  }

  private async showMain(chatId: number, messageId?: number): Promise<void> {
    await this.renderMenu(chatId, "<b>Pi Telegram Remote Manager</b>\nChoose a section.", [
      [button("Projects", "projects"), button("Sessions", "sessions")],
      [button("Manage Pi", "extensions")],
    ], messageId);
  }

  private async showProjectsMenu(chatId: number, messageId?: number): Promise<void> {
    await this.renderMenu(chatId, "<b>Projects</b>", [
      [button("List projects", "projects:list")],
      [button("Create project", "projects:create")],
      [button("Back", "home"), button("Home", "home")],
    ], messageId);
  }

  private async showProjectChoices(chatId: number, action: ProjectChoiceAction): Promise<void> {
    try {
      const projects = await this.projects.list();
      const rows = projects.map((name) => [button(name, `project:select:${action}:${projectKey(name)}`)]);
      rows.push([button("Back", action === "view" ? "projects" : action === "new-session" ? "sessions" : "extensions"), button("Home", "home")]);
      const title = action === "view" ? "Projects" : action === "new-session" ? "Choose a project for the new session" : "Choose a project";
      await this.api.sendText(chatId, `<b>${title}</b>\n${projects.length ? "Select a project." : "No projects."}`, { inlineKeyboard: rows });
    } catch (error) { await this.api.sendText(chatId, `❌ ${escapeHtml(errorText(error))}`, projectNavigation()); }
  }

  private async showProject(chatId: number, project: string, messageId?: number): Promise<void> {
    const sessions = this.sessions.list().filter((item) => item.projectId === project);
    const key = projectKey(project);
    const rows = sessions.map((session) => [button(formatSessionButton(session), `session:view:${session.id}`)]);
    rows.push([button("New session", `project:new:${key}`)]);
    rows.push([button("Back", "projects"), button("Home", "home")]);
    await this.renderMenu(chatId, `<b>${escapeHtml(project)}</b>\n${sessions.length ? "Select a session." : "No sessions yet."}`, rows, messageId);
  }

  private async showSessionsMenu(chatId: number, messageId?: number): Promise<void> {
    await this.renderMenu(chatId, "<b>Sessions</b>", [
      [button("Active sessions", "sessions:active"), button("Sleeping / stopped", "sessions:sleeping")],
      [button("New session", "sessions:new")],
      [button("Current session", "sessions:current")],
      [button("Back", "home"), button("Home", "home")],
    ], messageId);
  }

  private async showSessionList(chatId: number, active: boolean): Promise<void> {
    const sessions = this.sessions.list().filter((item) => active ? ["starting", "running", "busy"].includes(item.state) : ["sleeping", "stopped", "error"].includes(item.state));
    const rows = sessions.map((session) => [button(formatSessionButton(session), `session:view:${session.id}`)]);
    rows.push([button("Back", "sessions"), button("Home", "home")]);
    await this.api.sendText(chatId, `<b>${active ? "Active" : "Sleeping / stopped"} sessions</b>\n${sessions.length ? "Select a session." : "No sessions."}`, { inlineKeyboard: rows });
  }

  private async showCurrentSession(chatId: number, messageId?: number): Promise<void> {
    const id = this.store.getValue<string>("selected_session");
    if (!id) {
      await this.renderMenu(chatId, "No Pi session is selected.", [[button("Active sessions", "sessions:active"), button("Sleeping / stopped", "sessions:sleeping")], [button("Back", "sessions"), button("Home", "home")]], messageId);
      return;
    }
    await this.showSession(chatId, id, messageId);
  }

  private async startSession(chatId: number, project: string): Promise<void> {
    await this.api.sendText(chatId, `Starting a Pi session for <code>${escapeHtml(project)}</code>…`);
    try {
      const session = await this.sessions.create(project);
      this.store.setValue("selected_session", session.id);
      await this.showSession(chatId, session.id);
    } catch (error) {
      await this.api.sendText(chatId, `❌ ${escapeHtml(errorText(error))}`, sessionMenuNavigation());
    }
  }

  private async showSession(chatId: number, id: string, messageId?: number): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) { await this.api.sendText(chatId, "That session no longer exists.", sessionMenuNavigation()); return; }
    const recent = await this.sessions.recentMessages(id).catch(() => []);
    const previews = recent.length ? recent.map((item) => `<b>${item.role === "user" ? "You" : "Pi"}:</b> ${escapeHtml(item.text.slice(0, 500))}`).join("\n\n") : [session.lastUserPreview && `<b>You:</b> ${escapeHtml(session.lastUserPreview)}`, session.lastAssistantPreview && `<b>Pi:</b> ${escapeHtml(session.lastAssistantPreview)}`].filter(Boolean).join("\n\n");
    const details = `<b>${escapeHtml(session.friendlyName)}</b>\nID: <code>${sessionRef(session)}</code>\nProject: <code>${escapeHtml(session.projectId)}</code>\nState: ${session.state}\ntmux: <code>tmux attach -t ${escapeHtml(session.tmuxSessionName)}</code>${session.lastError ? `\nError: ${escapeHtml(session.lastError)}` : ""}${previews ? `\n\n${previews}` : ""}`;
    const active = ["starting", "running", "busy"].includes(session.state);
    const actions: TelegramButton[][] = active
      ? [[button("Stop", `session:stop:${id}`), button("Rename", `session:rename:${id}`)], ...(session.state === "busy" ? [[button("Steer", `session:steer:${id}`)]] : []), [button("Leave", `session:leave:${id}`)]]
      : [[button("Resume", `session:resume:${id}`), button("Rename", `session:rename:${id}`)]];
    actions.push([button("Back", "sessions"), button("Home", "home")]);
    await this.renderMenu(chatId, details, actions, messageId);
  }

  private async showExtensionsMenu(chatId: number, messageId?: number): Promise<void> {
    await this.renderMenu(chatId, "<b>Manage Pi</b>", [
      [button("List extensions", "ext:scope:list")],
      [button("Install extension", "ext:scope:install")],
      [button("Update extension", "ext:scope:update")],
      [button("Update Pi", "pi:update")],
      [button("Back", "home"), button("Home", "home")],
    ], messageId);
  }

  private async showExtensionScopes(chatId: number, action: ExtensionAction, messageId?: number): Promise<void> {
    const label = action === "list" ? "List extensions" : action === "install" ? "Install extension" : "Update extension";
    await this.renderMenu(chatId, `<b>${label}</b>\nChoose a scope.`, [
      [button("Global", `ext:global:${action}`), button("Project", `ext:project:${action}`)],
      [button("Back", "extensions"), button("Home", "home")],
    ], messageId);
  }

  private async prompt(chatId: number, html: string, pending: PendingWorkflow): Promise<void> {
    this.pending = pending;
    await this.api.sendText(chatId, html, promptNavigation(pending.id));
  }

  private async resolveProjectKey(key: string): Promise<string | undefined> {
    return (await this.projects.list()).find((project) => projectKey(project) === key);
  }

  private async onBridgeEvent(event: BridgeEvent, session: ManagedSession): Promise<void> {
    const owner = this.store.getOwner();
    if (!owner) return;
    const selected = this.store.getValue<string>("selected_session") === session.id;
    const routed = selected || this.activeTurns.has(session.id);
    if (!routed) return;
    const payload = event.payload ?? {};
    const prefix = selected ? "" : `<b>${escapeHtml(session.projectId)} · ${escapeHtml(session.friendlyName)}</b>\n`;
    const lastTyping = this.typingAt.get(session.id) ?? 0;
    if (event.type !== "state" && Date.now() - lastTyping >= 4_000) {
      this.typingAt.set(session.id, Date.now());
      await this.api.typing(owner.chatId).catch(() => undefined);
    }
    if (event.type === "state" && payload.busy === true) {
      this.typingAt.set(session.id, Date.now());
      await this.api.typing(owner.chatId).catch(() => undefined);
      const ids = await this.api.sendText(owner.chatId, `${prefix}🤖 <b>Working…</b>`);
      this.streams.set(session.id, { messageId: ids.at(-1), lastEdit: 0, latest: "" });
    } else if (event.type === "state" && payload.busy === false) {
      this.activeTurns.delete(session.id);
    } else if (event.type === "assistant_delta" && typeof payload.text === "string") {
      const stream = this.streams.get(session.id);
      if (!stream) return;
      stream.latest = payload.text;
      if (stream.messageId && Date.now() - stream.lastEdit >= this.config.render.streamIntervalMs && Buffer.byteLength(payload.text) < 3200) {
        stream.lastEdit = Date.now();
        await this.api.editText(owner.chatId, stream.messageId, `${prefix}${markdownToTelegramHtml(payload.text)}`).catch(() => undefined);
      }
    } else if (event.type === "assistant_final") {
      const body = String(payload.text || payload.error || "");
      const thinking = String(payload.thinking ?? "");
      const thought = this.config.render.thinking === "hidden" || !thinking ? "" : `\n\n<blockquote>${escapeHtml(this.config.render.thinking === "brief" ? summarize(thinking, 200) : thinking)}</blockquote>`;
      const html = `${prefix}${markdownToTelegramHtml(body)}${thought}`;
      const stream = this.streams.get(session.id);
      this.streams.delete(session.id);
      if (stream?.messageId && Buffer.byteLength(html) < 3500) await this.api.editText(owner.chatId, stream.messageId, html).catch(async () => { await this.api.sendText(owner.chatId, html); });
      else await this.api.sendText(owner.chatId, html || `${prefix}✅ Done`);
    } else if (event.type === "tool_start" && this.config.render.tools !== "hidden") {
      const detail = this.config.render.tools === "full" ? `\n<pre>${escapeHtml(summarize(payload.args, 1200))}</pre>` : payload.args ? `: ${escapeHtml(summarize(payload.args, 100))}` : "";
      await this.api.sendText(owner.chatId, `${prefix}🔧 ${escapeHtml(String(payload.name ?? "tool"))}${detail}`);
    } else if (event.type === "tool_update" && this.config.render.tools === "full") {
      const toolId = String(payload.id ?? "");
      const last = this.toolUpdateAt.get(toolId) ?? 0;
      if (Date.now() - last < 5_000) return;
      this.toolUpdateAt.set(toolId, Date.now());
      await this.api.sendText(owner.chatId, `${prefix}🔄 ${escapeHtml(String(payload.name ?? "tool"))}\n<pre>${escapeHtml(summarize(payload.partial, 700))}</pre>`);
    } else if (event.type === "tool_end" && (this.config.render.tools === "full" || payload.isError)) {
      this.toolUpdateAt.delete(String(payload.id ?? ""));
      await this.api.sendText(owner.chatId, `${prefix}${payload.isError ? "❌" : "✅"} ${escapeHtml(String(payload.name ?? "tool"))}\n<pre>${escapeHtml(summarize(payload.result, this.config.render.tools === "full" ? 2500 : 300))}</pre>`);
    } else if (event.type === "user_message" && payload.source === "interactive" && selected) {
      await this.api.sendText(owner.chatId, `⌨️ <b>Terminal</b>\n${escapeHtml(String(payload.text ?? ""))}`);
    } else if (event.type === "ui_prompt" && payload.active) {
      await this.api.sendText(owner.chatId, `⚠️ Pi is waiting for terminal input.\n<code>tmux attach -t ${escapeHtml(session.tmuxSessionName)}</code>`);
    }
  }
}

function button(text: string, callback_data: string): TelegramButton { return { text, callback_data }; }
function promptNavigation(id: string): { inlineKeyboard: TelegramButton[][] } {
  return { inlineKeyboard: [[button("Cancel", `flow:cancel:${id}`), button("Home", "home")]] };
}
function projectNavigation(): { inlineKeyboard: TelegramButton[][] } {
  return { inlineKeyboard: [[button("Back", "projects"), button("Home", "home")]] };
}
function sessionMenuNavigation(): { inlineKeyboard: TelegramButton[][] } {
  return { inlineKeyboard: [[button("Back", "sessions"), button("Home", "home")]] };
}
function sessionNavigation(id: string): { inlineKeyboard: TelegramButton[][] } {
  return { inlineKeyboard: [[button("Back to session", `session:view:${id}`), button("Home", "home")]] };
}
function extensionNavigation(): { inlineKeyboard: TelegramButton[][] } {
  return { inlineKeyboard: [[button("Back", "extensions"), button("Home", "home")]] };
}
function workflowId(): string { return randomUUID().slice(0, 8); }
function expiresAt(): number { return Date.now() + WORKFLOW_TIMEOUT_MS; }
function projectKey(name: string): string { return createHash("sha256").update(name).digest("hex").slice(0, 12); }
function shortButtonText(value: string): string { return value.length > 52 ? `${value.slice(0, 51)}…` : value; }
function extensionTargetHtml(target: PiExtensionTarget): string {
  return target.scope === "global" ? "global" : `project <code>${escapeHtml(target.projectId)}</code>`;
}
function extensionTargetSuccessText(target: PiExtensionTarget): string {
  return target.scope === "global" ? "globally" : `for project <code>${escapeHtml(target.projectId)}</code>`;
}
function sessionRef(session: ManagedSession): string { return session.id.slice(0, 8); }
function formatSessionButton(session: ManagedSession): string {
  return shortButtonText(`${stateIcon(session)} ${sessionRef(session)} · ${session.projectId} · ${session.friendlyName}`);
}
function stateIcon(session: ManagedSession): string { return session.state === "busy" ? "🟠" : session.state === "running" ? "🟢" : session.state === "starting" ? "🔵" : session.state === "error" ? "🔴" : "💤"; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
