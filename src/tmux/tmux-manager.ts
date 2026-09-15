import type { ProcessRunner } from "../process-runner.js";

export interface PiLaunch {
  tmuxName: string;
  cwd: string;
  piExecutable: string;
  piSessionId: string;
  piSessionPath?: string;
  friendlyName: string;
  bridgeExtensionPath: string;
  bridgeSocketPath: string;
  managedSessionId: string;
}

export class TmuxManager {
  constructor(private readonly executable: string, private readonly runner: ProcessRunner) {}

  async launch(input: PiLaunch): Promise<void> {
    const sessionArgs = input.piSessionPath ? ["--session", input.piSessionPath] : ["--session-id", input.piSessionId];
    try {
      // Start a holding shell first so remain-on-exit is set before Pi can fail.
      // The shell is immediately replaced; Pi still becomes the pane's direct process.
      await this.runner.run(this.executable, [
        "new-session", "-d", "-s", input.tmuxName, "-c", input.cwd,
        "-e", `PI_REMOTE_MANAGER_SESSION_ID=${input.managedSessionId}`,
        "-e", `PI_REMOTE_MANAGER_SOCKET=${input.bridgeSocketPath}`,
      ]);
      await this.runner.run(this.executable, ["set-option", "-w", "-t", `=${input.tmuxName}:0`, "remain-on-exit", "on"]);
      await this.runner.run(this.executable, [
        "respawn-pane", "-k", "-t", `=${input.tmuxName}:0.0`, "-c", input.cwd,
        "--", input.piExecutable, ...sessionArgs, "--name", input.friendlyName,
        "--approve", "--extension", input.bridgeExtensionPath,
      ]);
    } catch (error) {
      await this.killSession(input.tmuxName);
      throw error;
    }
  }

  async exists(name: string): Promise<boolean> {
    try { await this.runner.run(this.executable, ["has-session", "-t", `=${name}`]); return true; }
    catch { return false; }
  }

  async attachedClients(name: string): Promise<number> {
    try {
      const { stdout } = await this.runner.run(this.executable, ["display-message", "-p", "-t", `=${name}`, "#{session_attached}"]);
      return Number.parseInt(stdout.trim(), 10) || 0;
    } catch { return 0; }
  }

  async listOwned(): Promise<string[]> {
    try {
      const { stdout } = await this.runner.run(this.executable, ["list-sessions", "-F", "#{session_name}"]);
      return stdout.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("pi-"));
    } catch { return []; }
  }

  async paneExit(name: string): Promise<{ dead: boolean; status: number | null }> {
    try {
      const { stdout } = await this.runner.run(this.executable, [
        "display-message", "-p", "-t", `=${name}:0.0`, "#{pane_dead}\t#{pane_dead_status}",
      ]);
      const [dead, rawStatus] = stdout.trim().split("\t");
      return { dead: dead === "1", status: rawStatus === "" || rawStatus === undefined ? null : Number.parseInt(rawStatus, 10) };
    } catch {
      return { dead: true, status: null };
    }
  }

  async capturePane(name: string): Promise<string> {
    try {
      const { stdout } = await this.runner.run(this.executable, ["capture-pane", "-p", "-S", "-200", "-t", `=${name}:0.0`]);
      return stdout;
    } catch { return ""; }
  }

  async killSession(name: string): Promise<void> {
    try { await this.runner.run(this.executable, ["kill-session", "-t", `=${name}`]); }
    catch { /* It may already be gone. */ }
  }

  async waitForPaneExit(name: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.paneExit(name)).dead) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return (await this.paneExit(name)).dead;
  }
}
