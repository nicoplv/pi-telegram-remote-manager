import { createConnection } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BridgeServer } from "../src/bridge/bridge-server.js";

describe("BridgeServer", () => {
  it("registers a client and correlates command responses", async (context) => {
    const dir = await mkdtemp(join("/private/tmp", "tgrm-bridge-"));
    const server = new BridgeServer(join(dir, "bridge.sock"));
    try { await server.start(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") { context.skip(); return; }
      throw error;
    }
    const socket = createConnection(server.socketPath);
    socket.setEncoding("utf8");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(`${JSON.stringify({ v: 1, type: "register", sessionId: "managed", payload: {} })}\n`);
    await new Promise<void>((resolve) => server.once("event", () => resolve()));
    socket.once("data", (chunk: string) => {
      const command = JSON.parse(chunk.trim());
      socket.write(`${JSON.stringify({ v: 1, type: "response", requestId: command.requestId, ok: true, result: { idle: true } })}\n`);
    });
    await expect(server.command("managed", "getStatus")).resolves.toEqual({ idle: true });
    socket.end();
    await server.close();
  });
});
