import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/sessions/session-manager.js";
import { StateStore } from "../src/store.js";

describe("session startup failures", () => {
  it("captures Pi output, stops the tmux session, and returns one terminal error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tgrm-startup-"));
    const store = new StateStore(dir);
    const bridge = Object.assign(new EventEmitter(), { isConnected: () => false, command: async () => undefined, socketPath: "/tmp/bridge.sock" });
    const killSession = vi.fn(async () => undefined);
    const tmux = {
      launch: async () => undefined,
      paneExit: async () => ({ dead: true, status: 1 }),
      capturePane: async () => "Starting Pi...\nModel failed to load: missing credentials\n",
      exists: async () => true,
      killSession,
    };
    const projects = { resolve: async () => "/projects/demo" };
    const sessions = new SessionManager(store, projects as never, tmux as never, bridge as never, "pi", "/bridge.js", 5_000);

    await expect(sessions.create("demo")).rejects.toThrow(/Model failed to load: missing credentials/);
    expect(killSession).toHaveBeenCalledTimes(1);
    const stored = sessions.list()[0];
    expect(stored.state).toBe("error");
    expect(stored.lastError).toContain("Pi exited during startup with status 1");
    store.close();
  });
});
