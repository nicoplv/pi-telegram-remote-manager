export const BRIDGE_PROTOCOL_VERSION = 1;
export const MAX_BRIDGE_FRAME_BYTES = 1_048_576;

export type BridgeEventType =
  | "register" | "ready" | "state" | "user_message" | "assistant_delta" | "assistant_final"
  | "tool_start" | "tool_update" | "tool_end" | "ui_prompt" | "session_name" | "error" | "shutdown";

export interface BridgeEvent {
  v: 1;
  type: BridgeEventType;
  sessionId: string;
  payload?: Record<string, unknown>;
}

export type BridgeCommandName = "sendUserMessage" | "renameSession" | "getStatus" | "getRecentMessages" | "shutdown";

export interface BridgeCommand {
  v: 1;
  type: "command";
  requestId: string;
  command: BridgeCommandName;
  payload?: Record<string, unknown>;
}

export interface BridgeResponse {
  v: 1;
  type: "response";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export function encodeFrame(frame: BridgeEvent | BridgeCommand | BridgeResponse): string {
  return `${JSON.stringify(frame)}\n`;
}
