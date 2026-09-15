import { randomInt } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ManagedSession, SessionState, StopReason, TelegramOwner } from "./types.js";

type SessionRow = {
  id: string;
  project_id: string;
  pi_session_id: string;
  pi_session_path: string | null;
  tmux_session_name: string;
  friendly_name: string;
  state: SessionState;
  created_at: string;
  last_activity_at: string;
  stop_reason: StopReason;
  last_error: string | null;
  last_user_preview: string | null;
  last_assistant_preview: string | null;
};

function toSession(row: SessionRow): ManagedSession {
  return {
    id: row.id,
    projectId: row.project_id,
    piSessionId: row.pi_session_id,
    piSessionPath: row.pi_session_path,
    tmuxSessionName: row.tmux_session_name,
    friendlyName: row.friendly_name,
    state: row.state,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    stopReason: row.stop_reason,
    lastError: row.last_error,
    lastUserPreview: row.last_user_preview,
    lastAssistantPreview: row.last_assistant_preview,
  };
}

export class StateStore {
  readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    const path = join(dataDir, "state.db");
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.migrate();
    chmodSync(path, 0o600);
  }

  close(): void { this.db.close(); }

  private migrate(): void {
    const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version > 1) throw new Error(`State database schema ${version.user_version} is newer than this application supports`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS managed_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        pi_session_id TEXT NOT NULL,
        pi_session_path TEXT,
        tmux_session_name TEXT NOT NULL UNIQUE,
        friendly_name TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('starting','running','busy','sleeping','stopped','error')),
        created_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        stop_reason TEXT CHECK(stop_reason IN ('idle','manual','crash') OR stop_reason IS NULL),
        last_error TEXT,
        last_user_preview TEXT,
        last_assistant_preview TEXT,
        UNIQUE(project_id, pi_session_id)
      );
      PRAGMA user_version=1;
    `);
  }

  getValue<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM app_state WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }

  setValue(key: string, value: unknown): void {
    this.db.prepare("INSERT INTO app_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
  }

  deleteValue(key: string): void { this.db.prepare("DELETE FROM app_state WHERE key = ?").run(key); }

  getOwner(): TelegramOwner | undefined { return this.getValue<TelegramOwner>("telegram_owner"); }

  ensurePairingCode(): string {
    const current = this.getValue<string>("pairing_code");
    if (current) return current;
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    this.setValue("pairing_code", code);
    return code;
  }

  pairOwner(userId: number, chatId: number, code: string): boolean {
    if (this.getOwner() || this.getValue<string>("pairing_code") !== code) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.setValue("telegram_owner", { userId, chatId });
      this.deleteValue("pairing_code");
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  resetOwner(): string {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.deleteValue("telegram_owner");
      this.deleteValue("selected_session");
      this.deleteValue("pairing_code");
      const code = this.ensurePairingCode();
      this.db.exec("COMMIT");
      return code;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  addSession(session: ManagedSession): void {
    this.db.prepare(`INSERT INTO managed_sessions
      (id,project_id,pi_session_id,pi_session_path,tmux_session_name,friendly_name,state,created_at,last_activity_at,stop_reason,last_error,last_user_preview,last_assistant_preview)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      session.id, session.projectId, session.piSessionId, session.piSessionPath, session.tmuxSessionName,
      session.friendlyName, session.state, session.createdAt, session.lastActivityAt, session.stopReason,
      session.lastError, session.lastUserPreview, session.lastAssistantPreview,
    );
  }

  getSession(id: string): ManagedSession | undefined {
    const row = this.db.prepare("SELECT * FROM managed_sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return row ? toSession(row) : undefined;
  }

  listSessions(): ManagedSession[] {
    return (this.db.prepare("SELECT * FROM managed_sessions ORDER BY last_activity_at DESC").all() as SessionRow[]).map(toSession);
  }

  updateSession(id: string, changes: Partial<Omit<ManagedSession, "id">>): ManagedSession {
    const map: Record<string, string> = {
      projectId: "project_id", piSessionId: "pi_session_id", piSessionPath: "pi_session_path",
      tmuxSessionName: "tmux_session_name", friendlyName: "friendly_name", state: "state",
      createdAt: "created_at", lastActivityAt: "last_activity_at", stopReason: "stop_reason",
      lastError: "last_error", lastUserPreview: "last_user_preview", lastAssistantPreview: "last_assistant_preview",
    };
    const entries = Object.entries(changes).filter(([key]) => key in map);
    if (entries.length) {
      const sets = entries.map(([key]) => `${map[key]} = ?`).join(", ");
      this.db.prepare(`UPDATE managed_sessions SET ${sets} WHERE id = ?`).run(...entries.map(([, value]) => value), id);
    }
    const updated = this.getSession(id);
    if (!updated) throw new Error(`Unknown managed session: ${id}`);
    return updated;
  }
}
