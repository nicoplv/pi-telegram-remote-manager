import { EventEmitter } from "node:events";
import { chmod, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { BRIDGE_PROTOCOL_VERSION, encodeFrame, MAX_BRIDGE_FRAME_BYTES, type BridgeCommandName, type BridgeEvent, type BridgeResponse } from "./protocol.js";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type Connection = { socket: Socket; sessionId: string | null; buffer: string };

export class BridgeServer extends EventEmitter {
  private server?: Server;
  private readonly connections = new Map<string, Connection>();
  private readonly pending = new Map<string, Pending>();

  constructor(readonly socketPath: string) { super(); }

  async start(): Promise<void> {
    await rm(this.socketPath, { force: true }).catch(() => undefined);
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => { this.server!.off("error", reject); resolve(); });
    });
    await chmod(this.socketPath, 0o600);
  }

  async close(): Promise<void> {
    for (const connection of this.connections.values()) connection.socket.destroy();
    this.connections.clear();
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error("Bridge server closed")); }
    this.pending.clear();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    await rm(this.socketPath, { force: true }).catch(() => undefined);
  }

  isConnected(sessionId: string): boolean { return this.connections.has(sessionId); }

  async command(sessionId: string, command: BridgeCommandName, payload: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<unknown> {
    const connection = this.connections.get(sessionId);
    if (!connection) throw new Error("Pi bridge is not connected");
    const requestId = randomUUID();
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`Bridge command timed out: ${command}`)); }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      connection.socket.write(encodeFrame({ v: 1, type: "command", requestId, command, payload }));
    });
  }

  private accept(socket: Socket): void {
    const connection: Connection = { socket, sessionId: null, buffer: "" };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      connection.buffer += chunk;
      if (Buffer.byteLength(connection.buffer) > MAX_BRIDGE_FRAME_BYTES) return socket.destroy(new Error("Bridge frame too large"));
      let newline: number;
      while ((newline = connection.buffer.indexOf("\n")) >= 0) {
        const line = connection.buffer.slice(0, newline);
        connection.buffer = connection.buffer.slice(newline + 1);
        if (line) this.onFrame(connection, line);
      }
    });
    socket.on("close", () => {
      if (connection.sessionId && this.connections.get(connection.sessionId) === connection) {
        this.connections.delete(connection.sessionId);
        this.emit("disconnect", connection.sessionId);
      }
    });
    socket.on("error", () => undefined);
  }

  private onFrame(connection: Connection, line: string): void {
    let frame: BridgeEvent | BridgeResponse;
    try { frame = JSON.parse(line) as BridgeEvent | BridgeResponse; }
    catch { connection.socket.destroy(new Error("Invalid bridge JSON")); return; }
    if (frame.v !== BRIDGE_PROTOCOL_VERSION) { connection.socket.destroy(new Error("Unsupported bridge protocol")); return; }
    if (frame.type === "response") {
      const pending = this.pending.get(frame.requestId);
      if (!pending) return;
      this.pending.delete(frame.requestId);
      clearTimeout(pending.timer);
      frame.ok ? pending.resolve(frame.result) : pending.reject(new Error(frame.error ?? "Bridge command failed"));
      return;
    }
    if (!frame.sessionId || (connection.sessionId && connection.sessionId !== frame.sessionId)) { connection.socket.destroy(new Error("Invalid session registration")); return; }
    if (frame.type === "register") {
      const previous = this.connections.get(frame.sessionId);
      if (previous && previous !== connection) previous.socket.destroy();
      connection.sessionId = frame.sessionId;
      this.connections.set(frame.sessionId, connection);
    } else if (!connection.sessionId) {
      connection.socket.destroy(new Error("Bridge must register first"));
      return;
    }
    this.emit("event", frame);
  }
}
