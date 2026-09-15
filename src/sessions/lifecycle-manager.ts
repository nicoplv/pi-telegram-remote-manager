import type { SessionManager } from "./session-manager.js";
import type { TmuxManager } from "../tmux/tmux-manager.js";
import { log } from "../logger.js";

export class LifecycleManager {
  private timer?: NodeJS.Timeout;
  constructor(private readonly sessions: SessionManager, private readonly tmux: TmuxManager, private readonly idleMs: number) {}

  start(): void {
    if (!this.timer) this.timer = setInterval(() => void this.tick(), 30_000);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  async tick(now = Date.now()): Promise<void> {
    for (const session of this.sessions.list().filter((item) => item.state === "running")) {
      if (now - Date.parse(session.lastActivityAt) < this.idleMs) continue;
      if (await this.tmux.attachedClients(session.tmuxSessionName) > 0) continue;
      try { await this.sessions.stop(session.id, "idle"); }
      catch (error) { log("error", "Idle shutdown request failed", { sessionId: session.id, error: error instanceof Error ? error.message : String(error) }); }
    }
  }
}
