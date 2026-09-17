import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createConnection, type Socket } from "node:net";
import { BRIDGE_PROTOCOL_VERSION, encodeFrame, MAX_BRIDGE_FRAME_BYTES, type BridgeCommand, type BridgeEvent, type BridgeResponse, type PiSessionCommand } from "../bridge/protocol.js";

function messageParts(content: unknown): { text: string; thinking: string } {
  if (typeof content === "string") return { text: content, thinking: "" };
  if (!Array.isArray(content)) return { text: "", thinking: "" };
  const texts: string[] = [];
  const thoughts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const item = part as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") texts.push(item.text);
    if (item.type === "thinking" && typeof item.thinking === "string") thoughts.push(item.thinking);
  }
  return { text: texts.join("\n\n"), thinking: thoughts.join("\n\n") };
}

export default function remoteBridge(pi: ExtensionAPI): void {
  const sessionId = process.env.PI_REMOTE_MANAGER_SESSION_ID;
  const socketPath = process.env.PI_REMOTE_MANAGER_SOCKET;
  if (!sessionId || !socketPath) return;

  let socket: Socket | undefined;
  let buffer = "";
  let context: ExtensionContext | undefined;
  let stopped = false;
  let reconnectDelay = 250;
  let reconnectTimer: NodeJS.Timeout | undefined;

  const emit = (type: BridgeEvent["type"], payload: Record<string, unknown> = {}) => {
    if (!socket?.writable) return;
    try {
      const frame = encodeFrame({ v: BRIDGE_PROTOCOL_VERSION, type, sessionId, payload } as BridgeEvent);
      if (Buffer.byteLength(frame) <= MAX_BRIDGE_FRAME_BYTES) socket.write(frame);
      else socket.write(encodeFrame({ v: 1, type: "error", sessionId, payload: { message: `${type} event exceeded the bridge size limit` } }));
    } catch {
      socket.write(encodeFrame({ v: 1, type: "error", sessionId, payload: { message: `${type} event was not serializable` } }));
    }
  };

  const register = () => {
    if (!context) return;
    emit("register", {
      pid: process.pid,
      piSessionId: context.sessionManager.getSessionId(),
      piSessionPath: context.sessionManager.getSessionFile(),
      friendlyName: pi.getSessionName(),
      busy: !context.isIdle(),
      pending: context.hasPendingMessages(),
    });
    emit("ready", { busy: !context.isIdle() });
  };

  const respond = (requestId: string, ok: boolean, result?: unknown, error?: string) => {
    if (socket?.writable) socket.write(encodeFrame({ v: 1, type: "response", requestId, ok, result, error } as BridgeResponse));
  };

  const recentMessages = () => {
    if (!context) return [];
    return context.sessionManager.getBranch().flatMap((entry: unknown) => {
      const row = entry as { type?: string; message?: { role?: string; content?: unknown } };
      if (row.type !== "message" || !row.message || !["user", "assistant"].includes(row.message.role ?? "")) return [];
      const parts = messageParts(row.message.content);
      return parts.text ? [{ role: row.message.role, text: parts.text.slice(0, 2000) }] : [];
    }).slice(-6);
  };

  const onCommand = async (command: BridgeCommand) => {
    try {
      if (!context) throw new Error("Pi session is not ready");
      const payload = command.payload ?? {};
      switch (command.command) {
        case "sendUserMessage": {
          const text = String(payload.text ?? "");
          if (!text) throw new Error("Message is empty");
          const delivery = payload.delivery;
          pi.sendUserMessage(text, {
            ...(delivery === "steer" || delivery === "followUp" ? { deliverAs: delivery } : {}),
            expandPromptTemplates: true,
          });
          respond(command.requestId, true);
          break;
        }
        case "renameSession":
          pi.setSessionName(String(payload.name ?? "")); respond(command.requestId, true); break;
        case "getStatus":
          respond(command.requestId, true, { idle: context.isIdle(), pending: context.hasPendingMessages(), sessionPath: context.sessionManager.getSessionFile(), name: pi.getSessionName() }); break;
        case "getRecentMessages":
          respond(command.requestId, true, recentMessages()); break;
        case "getCommands": {
          const commands: PiSessionCommand[] = pi.getCommands().map((item) => ({
            name: item.name,
            description: item.description,
            source: item.source,
          }));
          respond(command.requestId, true, commands);
          break;
        }
        case "shutdown":
          context.shutdown(); respond(command.requestId, true); break;
      }
    } catch (error) { respond(command.requestId, false, undefined, error instanceof Error ? error.message : String(error)); }
  };

  const connect = () => {
    if (stopped || socket) return;
    buffer = "";
    const next = createConnection(socketPath);
    socket = next;
    next.setEncoding("utf8");
    next.on("connect", () => { reconnectDelay = 250; register(); });
    next.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_BRIDGE_FRAME_BYTES) return next.destroy();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const frame = JSON.parse(line) as BridgeCommand;
          if (frame.v === 1 && frame.type === "command") void onCommand(frame);
        } catch { /* Ignore malformed daemon frames. */ }
      }
    });
    next.on("error", () => undefined);
    next.on("close", () => {
      if (socket === next) socket = undefined;
      if (!stopped) {
        reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
      }
    });
  };

  pi.on("session_start", (_event, ctx) => { context = ctx; connect(); register(); });
  pi.on("agent_start", () => emit("state", { busy: true }));
  pi.on("agent_settled", () => emit("state", { busy: false }));
  pi.on("input", (event) => { emit("user_message", { text: event.text, source: event.source, delivery: event.streamingBehavior }); });
  pi.on("message_update", (event) => {
    const message = event.message as { role?: string; content?: unknown };
    if (message.role === "assistant") emit("assistant_delta", messageParts(message.content));
  });
  pi.on("message_end", (event) => {
    const message = event.message as { role?: string; content?: unknown; errorMessage?: string };
    if (message.role === "assistant") emit("assistant_final", { ...messageParts(message.content), error: message.errorMessage });
  });
  pi.on("tool_execution_start", (event) => emit("tool_start", { id: event.toolCallId, name: event.toolName, args: event.args }));
  pi.on("tool_execution_update", (event) => emit("tool_update", { id: event.toolCallId, name: event.toolName, partial: event.partialResult }));
  pi.on("tool_execution_end", (event) => emit("tool_end", { id: event.toolCallId, name: event.toolName, result: event.result, isError: event.isError }));
  pi.on("ui_prompt_start", (event) => emit("ui_prompt", { active: true, kind: event.kind, title: event.title }));
  pi.on("ui_prompt_end", () => emit("ui_prompt", { active: false }));
  pi.on("session_info_changed", (event) => emit("session_name", { name: event.name }));
  pi.on("session_shutdown", (event) => {
    emit("shutdown", { reason: event.reason });
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.end();
  });
}
