import { describe, expect, it } from "vitest";
import type { ProcessRunner } from "../src/process-runner.js";
import { TmuxManager } from "../src/tmux/tmux-manager.js";

describe("TmuxManager", () => {
  it("launches Pi with an argument array and no interpolated shell command", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const runner: ProcessRunner = { async run(file, args) { calls.push({ file, args }); return { stdout: "", stderr: "" }; } };
    const tmux = new TmuxManager("tmux", runner);
    await tmux.launch({
      tmuxName: "pi-safe-12345678", cwd: "/projects/a;touch nope", piExecutable: "pi",
      piSessionId: "pi-id", friendlyName: "name; echo nope", bridgeExtensionPath: "/app/bridge.js",
      bridgeSocketPath: "/tmp/bridge.sock", managedSessionId: "managed-id",
    });
    expect(calls).toHaveLength(3);
    expect(calls[0].file).toBe("tmux");
    expect(calls[0].args).toContain("/projects/a;touch nope");
    expect(calls[2].args).toContain("name; echo nope");
    expect(calls.flatMap((call) => call.args).join(" ")).not.toContain("sh -c");
    expect(calls[2].args.at(-2)).toBe("--extension");
    expect(calls[1].args).toContain("remain-on-exit");
  });
});
