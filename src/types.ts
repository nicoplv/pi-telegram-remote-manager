export type SessionState = "starting" | "running" | "busy" | "sleeping" | "stopped" | "error";
export type StopReason = "idle" | "manual" | "crash" | null;
export type RenderLevel = "hidden" | "brief" | "full";

export interface ManagedSession {
  id: string;
  projectId: string;
  piSessionId: string;
  piSessionPath: string | null;
  tmuxSessionName: string;
  friendlyName: string;
  state: SessionState;
  createdAt: string;
  lastActivityAt: string;
  stopReason: StopReason;
  lastError: string | null;
  lastUserPreview: string | null;
  lastAssistantPreview: string | null;
}

export interface AppConfig {
  telegram: { botToken: string };
  projectsRoot: string;
  dataDir: string;
  pi: { executable: string };
  tmux: { executable: string };
  sessions: {
    idleTimeoutMinutes: number;
    bridgeRegistrationTimeoutSeconds: number;
  };
  render: {
    tools: RenderLevel;
    thinking: RenderLevel;
    streamIntervalMs: number;
  };
  bridge: { transport: "unix-socket"; socketPath: string };
}

export interface TelegramOwner {
  userId: number;
  chatId: number;
}
