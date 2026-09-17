import { EventEmitter } from "node:events";
import { access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { BridgeEvent, PiSessionCommand } from "../bridge/protocol.js";
import type { BridgeServer } from "../bridge/bridge-server.js";
import type { ProjectManager } from "../projects/project-manager.js";
import type { StateStore } from "../store.js";
import type { ManagedSession, StopReason } from "../types.js";
import type { TmuxManager } from "../tmux/tmux-manager.js";
import { log } from "../logger.js";

type RegistrationWaiter = {
  resolve: (session: ManagedSession) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  probe: NodeJS.Timeout;
};

export class SessionManager extends EventEmitter {
  private readonly registrationWaiters = new Map<string, RegistrationWaiter>();
  private readonly expectedStops = new Map<string, Exclude<StopReason, "crash" | null>>();

  constructor(
    private readonly store: StateStore,
    private readonly projects: ProjectManager,
    private readonly tmux: TmuxManager,
    private readonly bridge: BridgeServer,
    private readonly piExecutable: string,
    private readonly extensionPath: string,
    private readonly registrationTimeoutMs: number,
  ) {
    super();
    bridge.on("event", (event: BridgeEvent) => void this.onBridgeEvent(event));
    bridge.on("disconnect", (id: string) => void this.onDisconnect(id));
  }

  list(): ManagedSession[] { return this.store.listSessions(); }
  get(id: string): ManagedSession | undefined { return this.store.getSession(id); }

  async create(projectId: string): Promise<ManagedSession> {
    const cwd = await this.projects.resolve(projectId);
    const id = randomUUID();
    const piSessionId = randomUUID();
    const tmuxName = makeTmuxName(projectId, id);
    const now = new Date().toISOString();
    const session: ManagedSession = {
      id, projectId, piSessionId, piSessionPath: null, tmuxSessionName: tmuxName,
      friendlyName: `Session ${id.slice(0, 8)}`, state: "starting", createdAt: now,
      lastActivityAt: now, stopReason: null, lastError: null, lastUserPreview: null, lastAssistantPreview: null,
    };
    this.store.addSession(session);
    try {
      await this.launch(session, cwd);
      return await this.waitForRegistration(id);
    } catch (error) {
      this.store.updateSession(id, { state: "error", lastError: errorMessage(error) });
      throw error;
    }
  }

  async resume(id: string): Promise<ManagedSession> {
    const session = required(this.get(id));
    if (!session.piSessionPath) throw new Error("This session never registered a Pi session file");
    await access(session.piSessionPath).catch(() => { throw new Error(`Pi session file is missing: ${session.piSessionPath}`); });
    if (await this.tmux.exists(session.tmuxSessionName)) throw new Error("The tmux session already exists");
    const cwd = await this.projects.resolve(session.projectId);
    this.store.updateSession(id, { state: "starting", stopReason: null, lastError: null, lastActivityAt: new Date().toISOString() });
    try {
      await this.launch({ ...session, state: "starting" }, cwd);
      return await this.waitForRegistration(id);
    } catch (error) {
      this.store.updateSession(id, { state: "error", lastError: errorMessage(error) });
      throw error;
    }
  }

  async sendMessage(id: string, text: string, steer = false): Promise<void> {
    const session = required(this.get(id));
    if (!this.bridge.isConnected(id) || !["running", "busy"].includes(session.state)) throw new Error("Session is not connected");
    const delivery = steer ? "steer" : session.state === "busy" ? "followUp" : "immediate";
    await this.bridge.command(id, "sendUserMessage", { text, delivery });
    this.store.updateSession(id, { lastActivityAt: new Date().toISOString(), lastUserPreview: preview(text) });
  }

  async rename(id: string, name: string): Promise<ManagedSession> {
    const trimmed = name.replace(/[\r\n]/g, " ").trim();
    if (!trimmed || trimmed.length > 80) throw new Error("Session names must be 1-80 characters");
    if (this.bridge.isConnected(id)) await this.bridge.command(id, "renameSession", { name: trimmed });
    return this.store.updateSession(id, { friendlyName: trimmed });
  }

  async stop(id: string, reason: "manual" | "idle"): Promise<void> {
    const session = required(this.get(id));
    if (!this.bridge.isConnected(id)) throw new Error("Session bridge is not connected");
    if (this.expectedStops.has(id)) return;
    if (await this.tmux.attachedClients(session.tmuxSessionName) > 0) throw new Error("Detach all tmux clients before stopping this session");
    this.expectedStops.set(id, reason);
    try { await this.bridge.command(id, "shutdown"); }
    catch (error) { this.expectedStops.delete(id); throw error; }
    this.emit("stop_requested", session, reason);
  }

  async recentMessages(id: string): Promise<Array<{ role: string; text: string }>> {
    if (!this.bridge.isConnected(id)) return [];
    return await this.bridge.command(id, "getRecentMessages") as Array<{ role: string; text: string }>;
  }

  async commands(id: string): Promise<PiSessionCommand[]> {
    if (!this.bridge.isConnected(id)) return [];
    const result = await this.bridge.command(id, "getCommands");
    if (!Array.isArray(result)) return [];
    return result.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const command = item as Record<string, unknown>;
      if (typeof command.name !== "string" || !["extension", "prompt", "skill"].includes(String(command.source))) return [];
      return [{
        name: command.name,
        ...(typeof command.description === "string" ? { description: command.description } : {}),
        source: command.source as PiSessionCommand["source"],
      }];
    });
  }

  async recover(): Promise<void> {
    const known = new Set(this.list().map((session) => session.tmuxSessionName));
    for (const unknown of (await this.tmux.listOwned()).filter((name) => !known.has(name))) log("warn", "Ignoring unknown tmux session", { tmuxSessionName: unknown });
    for (const session of this.list()) {
      const exists = await this.tmux.exists(session.tmuxSessionName);
      if (!exists && ["starting", "running", "busy"].includes(session.state)) {
        this.store.updateSession(session.id, { state: "sleeping", stopReason: "crash", lastError: "Managed tmux session was not found during recovery" });
      } else if (exists) {
        this.store.updateSession(session.id, { state: "starting", lastError: null });
        setTimeout(() => {
          if (!this.bridge.isConnected(session.id) && this.get(session.id)?.state === "starting") {
            this.store.updateSession(session.id, { state: "error", lastError: "tmux is alive but its bridge did not reconnect" });
          }
        }, this.registrationTimeoutMs).unref();
      }
    }
  }

  private async launch(session: ManagedSession, cwd: string): Promise<void> {
    await this.tmux.launch({
      tmuxName: session.tmuxSessionName, cwd, piExecutable: this.piExecutable,
      piSessionId: session.piSessionId, piSessionPath: session.piSessionPath ?? undefined,
      friendlyName: session.friendlyName, bridgeExtensionPath: this.extensionPath,
      bridgeSocketPath: this.bridge.socketPath, managedSessionId: session.id,
    });
  }

  private waitForRegistration(id: string): Promise<ManagedSession> {
    const current = this.get(id);
    if (current && this.bridge.isConnected(id) && ["running", "busy"].includes(current.state)) return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      let checking = false;
      const fail = async (summary: string) => {
        const waiter = this.registrationWaiters.get(id);
        if (!waiter) return;
        this.registrationWaiters.delete(id);
        clearTimeout(waiter.timer);
        clearInterval(waiter.probe);
        const session = this.get(id);
        const output = session ? formatStartupOutput(await this.tmux.capturePane(session.tmuxSessionName)) : "";
        if (session && await this.tmux.exists(session.tmuxSessionName)) await this.tmux.killSession(session.tmuxSessionName);
        reject(new Error([summary, output].filter(Boolean).join("\n\n")));
      };
      const timer = setTimeout(() => void fail(`Pi did not become ready within ${this.registrationTimeoutMs / 1000} seconds. Startup was stopped.`), this.registrationTimeoutMs);
      const probe = setInterval(() => {
        if (checking) return;
        checking = true;
        const session = this.get(id);
        if (!session) { void fail("The managed session disappeared during startup.").finally(() => { checking = false; }); return; }
        void this.tmux.paneExit(session.tmuxSessionName).then(({ dead, status }) => {
          if (dead) return fail(`Pi exited during startup${status === null ? "" : ` with status ${status}`}.`);
        }).finally(() => { checking = false; });
      }, 200);
      this.registrationWaiters.set(id, { resolve, reject, timer, probe });
    });
  }

  private onBridgeEvent(event: BridgeEvent): void {
    const session = this.get(event.sessionId);
    if (!session) { log("warn", "Ignoring bridge for unknown session", { sessionId: event.sessionId }); return; }
    const payload = event.payload ?? {};
    const now = new Date().toISOString();
    if (event.type === "register") {
      if (payload.piSessionId !== session.piSessionId) {
        this.store.updateSession(session.id, { state: "error", lastError: "Bridge registered an unexpected Pi session ID" });
        return;
      }
      this.store.updateSession(session.id, {
        piSessionPath: typeof payload.piSessionPath === "string" ? payload.piSessionPath : session.piSessionPath,
        friendlyName: typeof payload.friendlyName === "string" && payload.friendlyName ? payload.friendlyName : session.friendlyName,
        state: payload.busy ? "busy" : "running", lastError: null,
      });
    } else if (event.type === "ready") {
      const updated = this.store.updateSession(session.id, { state: payload.busy ? "busy" : "running", lastError: null });
      const waiter = this.registrationWaiters.get(session.id);
      if (waiter) { clearTimeout(waiter.timer); clearInterval(waiter.probe); this.registrationWaiters.delete(session.id); waiter.resolve(updated); }
    } else if (event.type === "state") {
      this.store.updateSession(session.id, { state: payload.busy ? "busy" : "running", lastActivityAt: now });
    } else if (event.type === "user_message") {
      this.store.updateSession(session.id, { lastActivityAt: now, lastUserPreview: preview(String(payload.text ?? "")) });
    } else if (event.type === "assistant_final") {
      this.store.updateSession(session.id, { lastActivityAt: now, lastAssistantPreview: preview(String(payload.text || payload.error || "")) });
    } else if (["assistant_delta", "tool_start", "tool_update", "tool_end", "ui_prompt"].includes(event.type)) {
      this.store.updateSession(session.id, { lastActivityAt: now, ...(event.type === "ui_prompt" && payload.active ? { state: "busy" as const } : {}) });
    } else if (event.type === "session_name" && typeof payload.name === "string") {
      this.store.updateSession(session.id, { friendlyName: payload.name });
    } else if (event.type === "shutdown" && !this.expectedStops.has(session.id)) {
      this.expectedStops.set(session.id, "manual");
    }
    this.emit("bridge_event", event, this.get(session.id));
  }

  private async onDisconnect(id: string): Promise<void> {
    const session = this.get(id);
    if (!session) return;
    const reason = this.expectedStops.get(id);
    if (reason) {
      this.expectedStops.delete(id);
      if (await this.tmux.waitForPaneExit(session.tmuxSessionName, 2_000)) await this.tmux.killSession(session.tmuxSessionName);
      this.store.updateSession(id, { state: reason === "idle" ? "sleeping" : "stopped", stopReason: reason, lastError: null });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (!this.bridge.isConnected(id)) {
        const tmuxExists = await this.tmux.exists(session.tmuxSessionName);
        this.store.updateSession(id, { state: "error", stopReason: "crash", lastError: tmuxExists ? "Pi bridge disconnected" : "Pi exited unexpectedly" });
      }
    }
    this.emit("session_changed", this.get(id));
  }
}

function required(session: ManagedSession | undefined): ManagedSession {
  if (!session) throw new Error("Unknown managed session");
  return session;
}

function makeTmuxName(project: string, id: string): string {
  const slug = project.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 32) || "project";
  return `pi-${slug}-${id.slice(0, 8)}`;
}

function preview(text: string): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 500) : null;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function formatStartupOutput(raw: string): string {
  const cleaned = raw
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .slice(-20)
    .join("\n")
    .slice(-2_000);
  return cleaned ? `Pi startup output:\n${cleaned}` : "No startup diagnostics were captured from Pi.";
}
