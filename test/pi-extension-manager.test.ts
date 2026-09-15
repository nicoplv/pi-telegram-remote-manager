import { describe, expect, it, vi } from "vitest";
import { parsePackageList, PiExtensionManager, validateSource } from "../src/extensions/pi-extension-manager.js";

describe("PiExtensionManager", () => {
  it("uses explicit global and project-local Pi commands", async () => {
    const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const projects = { resolve: vi.fn(async (id: string) => `/projects/${id}`) };
    const manager = new PiExtensionManager("custom-pi", { run } as never, projects as never, "/state");

    await manager.install({ scope: "global" }, "npm:@scope/tools@1.2.3");
    await manager.uninstall({ scope: "project", projectId: "demo" }, "git:github.com/example/tools");
    await manager.update({ scope: "global" }, "npm:@scope/tools");
    await manager.update({ scope: "project", projectId: "demo" }, "git:github.com/example/tools");
    await manager.updatePi();

    expect(run).toHaveBeenNthCalledWith(1, "custom-pi", ["install", "npm:@scope/tools@1.2.3", "--no-approve"], expect.objectContaining({
      cwd: "/state", timeout: 300_000,
      env: expect.objectContaining({ NO_COLOR: "1", FORCE_COLOR: "0", GIT_TERMINAL_PROMPT: "0" }),
    }));
    expect(run).toHaveBeenNthCalledWith(2, "custom-pi", ["remove", "git:github.com/example/tools", "-l", "--approve"], expect.objectContaining({ cwd: "/projects/demo", timeout: 300_000 }));
    expect(run).toHaveBeenNthCalledWith(3, "custom-pi", ["update", "--extension", "npm:@scope/tools", "--no-approve"], expect.objectContaining({ cwd: "/state", timeout: 300_000 }));
    expect(run).toHaveBeenNthCalledWith(4, "custom-pi", ["update", "--extension", "git:github.com/example/tools", "--approve"], expect.objectContaining({ cwd: "/projects/demo", timeout: 300_000 }));
    expect(run).toHaveBeenNthCalledWith(5, "custom-pi", ["update", "--self", "--no-approve"], expect.objectContaining({ cwd: "/state", timeout: 300_000 }));
    expect(projects.resolve).toHaveBeenCalledWith("demo");
  });

  it("lists only remote packages from the requested scope", async () => {
    const stdout = [
      "User packages:",
      "  npm:global-tools",
      "    /home/user/.pi/agent/npm/global-tools",
      "  /home/user/local-extension.ts",
      "",
      "Project packages:",
      "  git:github.com/example/project-tools@v1 (filtered)",
      "    /projects/demo/.pi/git/github.com/example/project-tools",
    ].join("\n");
    const run = vi.fn(async () => ({ stdout, stderr: "" }));
    const projects = { resolve: vi.fn(async () => "/projects/demo") };
    const manager = new PiExtensionManager("pi", { run } as never, projects as never, "/state");

    await expect(manager.list({ scope: "global" })).resolves.toEqual(["npm:global-tools"]);
    await expect(manager.list({ scope: "project", projectId: "demo" })).resolves.toEqual(["git:github.com/example/project-tools@v1"]);
    expect(run).toHaveBeenNthCalledWith(1, "pi", ["list"], expect.objectContaining({ cwd: "/state", timeout: 300_000 }));
    expect(run).toHaveBeenNthCalledWith(2, "pi", ["list"], expect.objectContaining({ cwd: "/projects/demo", timeout: 300_000 }));
    expect(parsePackageList("No packages installed.\n", "global")).toEqual([]);
  });

  it.each([
    "npm:@scope/tools@1.2.3",
    "git:github.com/example/tools@v1",
    "https://example.com/tools.git",
    "http://example.com/tools.git",
    "ssh://git@example.com/tools.git",
    "git://example.com/tools.git",
  ])("accepts remote source %s", (source) => {
    expect(() => validateSource(source)).not.toThrow();
  });

  it.each([
    "/tmp/extension.ts",
    "./extension.ts",
    "file:///tmp/extension.ts",
    "npm:package with-space",
    "package",
  ])("rejects unsupported source %s before running Pi", async (source) => {
    const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const manager = new PiExtensionManager("pi", { run } as never, { resolve: async () => "/projects/demo" } as never, "/state");
    await expect(manager.install({ scope: "global" }, source)).rejects.toThrow(/whitespace-free npm, git, HTTP/);
    expect(run).not.toHaveBeenCalled();
  });

  it("reports concise Pi command failures", async () => {
    const failure = Object.assign(new Error("Command failed"), { stderr: "fatal: credentials required\n" });
    const manager = new PiExtensionManager("pi", { run: async () => { throw failure; } } as never, { resolve: async () => "/projects/demo" } as never, "/state");
    await expect(manager.install({ scope: "global" }, "https://example.com/tools.git")).rejects.toThrow("Pi install failed: fatal: credentials required");
  });

  it("reports package command timeouts explicitly", async () => {
    const failure = Object.assign(new Error("Command failed"), { killed: true, stdout: "Installing package..." });
    const manager = new PiExtensionManager("pi", { run: async () => { throw failure; } } as never, { resolve: async () => "/projects/demo" } as never, "/state");
    await expect(manager.install({ scope: "global" }, "npm:tools")).rejects.toThrow("Pi install timed out after 5 minutes");
  });
});
