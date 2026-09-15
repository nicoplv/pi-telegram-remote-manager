import { access, mkdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { rm } from "node:fs/promises";
import type { AppConfig } from "./types.js";
import type { ProcessRunner } from "./process-runner.js";

export async function preflight(config: AppConfig, runner: ProcessRunner, extensionPath: string, checkSocket = false): Promise<string[]> {
  const results: string[] = [];
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Node.js 24 or newer is required");
  results.push(`Node ${process.versions.node}`);
  const projectStat = await stat(config.projectsRoot);
  if (!projectStat.isDirectory()) throw new Error(`projectsRoot is not a directory: ${config.projectsRoot}`);
  await access(config.projectsRoot, constants.R_OK | constants.W_OK);
  results.push(`projectsRoot ${config.projectsRoot}`);
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await access(config.dataDir, constants.R_OK | constants.W_OK);
  results.push(`dataDir ${config.dataDir}`);
  const pi = await runner.run(config.pi.executable, ["--version"], { timeout: 10_000 });
  results.push(`Pi ${pi.stdout.trim() || pi.stderr.trim()}`);
  const tmux = await runner.run(config.tmux.executable, ["-V"], { timeout: 10_000 });
  const tmuxVersion = tmux.stdout.trim() || tmux.stderr.trim();
  const match = /tmux\s+(\d+)\.(\d+)/i.exec(tmuxVersion);
  if (match && (Number(match[1]) < 3 || Number(match[1]) === 3 && Number(match[2]) < 2)) throw new Error("tmux 3.2 or newer is required");
  results.push(tmuxVersion);
  await access(extensionPath);
  results.push(`bridge extension ${extensionPath}`);
  if (checkSocket) {
    const path = `${config.bridge.socketPath}.check-${process.pid}`;
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(path, () => server.close(() => resolve()));
    });
    await rm(path, { force: true });
    results.push("Unix socket available");
  }
  return results;
}
