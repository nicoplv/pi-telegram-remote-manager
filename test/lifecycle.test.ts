import { describe, expect, it, vi } from "vitest";
import { LifecycleManager } from "../src/sessions/lifecycle-manager.js";

describe("LifecycleManager", () => {
  it("does not stop an attached session and stops it after detachment", async () => {
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    const stop = vi.fn(async () => undefined);
    const sessions = { list: () => [{ id: "one", state: "running", lastActivityAt: old, tmuxSessionName: "pi-one" }], stop };
    let attached = 1;
    const tmux = { attachedClients: vi.fn(async () => attached) };
    const lifecycle = new LifecycleManager(sessions as never, tmux as never, 10 * 60_000);
    await lifecycle.tick();
    expect(stop).not.toHaveBeenCalled();
    attached = 0;
    await lifecycle.tick();
    expect(stop).toHaveBeenCalledWith("one", "idle");
  });
});
