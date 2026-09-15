#!/usr/bin/env node
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { log } from "./logger.js";
import { processRunner } from "./process-runner.js";
import { preflight } from "./preflight.js";
import { ProjectManager } from "./projects/project-manager.js";
import { PiExtensionManager } from "./extensions/pi-extension-manager.js";
import { StateStore } from "./store.js";
import { TmuxManager } from "./tmux/tmux-manager.js";
import { BridgeServer } from "./bridge/bridge-server.js";
import { SessionManager } from "./sessions/session-manager.js";
import { LifecycleManager } from "./sessions/lifecycle-manager.js";
import { TelegramApi } from "./telegram/api.js";
import { TelegramBot } from "./telegram/bot.js";

const VERSION = "1.0.0";

function usage(): string {
  return `Pi Telegram Remote Manager ${VERSION}

Usage:
  pi-telegram-remote-manager --config <config.yaml>
  pi-telegram-remote-manager --check --config <config.yaml>
  pi-telegram-remote-manager --reset-owner --config <config.yaml>
  pi-telegram-remote-manager --help
  pi-telegram-remote-manager --version`;
}

function argumentsFrom(argv: string[]): { config?: string; check: boolean; resetOwner: boolean; help: boolean; version: boolean } {
  const result = { check: false, resetOwner: false, help: false, version: false } as ReturnType<typeof argumentsFrom>;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") result.config = argv[++i];
    else if (argv[i] === "--check") result.check = true;
    else if (argv[i] === "--reset-owner") result.resetOwner = true;
    else if (argv[i] === "--help" || argv[i] === "-h") result.help = true;
    else if (argv[i] === "--version" || argv[i] === "-v") result.version = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return result;
}

function acquireLock(path: string): () => void {
  try {
    const fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const pid = Number.parseInt(readFileSync(path, "utf8"), 10);
    let alive = false;
    if (Number.isFinite(pid)) {
      try { process.kill(pid, 0); alive = true; }
      catch (probe) { if ((probe as NodeJS.ErrnoException).code === "EPERM") alive = true; }
    }
    if (alive) throw new Error(`Another manager process is running (PID ${pid})`);
    unlinkSync(path);
    const fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, String(process.pid)); closeSync(fd);
  }
  return () => { try { if (readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path); } catch { /* already gone */ } };
}

async function main(): Promise<void> {
  const args = argumentsFrom(process.argv.slice(2));
  if (args.help) { process.stdout.write(`${usage()}\n`); return; }
  if (args.version) { process.stdout.write(`${VERSION}\n`); return; }
  if (!args.config) throw new Error("--config <config.yaml> is required");
  const config = await loadConfig(args.config);
  const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), "pi-extension", "remote-bridge.js");
  if (args.check) {
    for (const line of await preflight(config, processRunner, extensionPath, true)) process.stdout.write(`✓ ${line}\n`);
    return;
  }

  const store = new StateStore(config.dataDir);
  if (args.resetOwner) {
    const releaseResetLock = acquireLock(join(config.dataDir, "manager.lock"));
    try {
      const code = store.resetOwner();
      process.stdout.write(`Telegram owner reset. Pair again with: /trm_pair ${code}\n`);
    } finally { store.close(); releaseResetLock(); }
    return;
  }

  const releaseLock = acquireLock(join(config.dataDir, "manager.lock"));
  let bridge: BridgeServer | undefined;
  let lifecycle: LifecycleManager | undefined;
  let bot: TelegramBot | undefined;
  try {
    await preflight(config, processRunner, extensionPath);
    const projects = new ProjectManager(config.projectsRoot);
    await projects.initialize();
    bridge = new BridgeServer(config.bridge.socketPath);
    await bridge.start();
    const tmux = new TmuxManager(config.tmux.executable, processRunner);
    const sessions = new SessionManager(store, projects, tmux, bridge, config.pi.executable, extensionPath, config.sessions.bridgeRegistrationTimeoutSeconds * 1000);
    const extensions = new PiExtensionManager(config.pi.executable, processRunner, projects, config.dataDir);
    await sessions.recover();
    lifecycle = new LifecycleManager(sessions, tmux, config.sessions.idleTimeoutMinutes * 60_000);
    lifecycle.start();
    if (!store.getOwner()) {
      const code = store.ensurePairingCode();
      process.stdout.write(`Telegram pairing required. Send this private message to the bot:\n/trm_pair ${code}\n`);
    }
    bot = new TelegramBot(config, new TelegramApi(config.telegram.botToken), store, projects, sessions, extensions);
    bot.start();
    log("info", "Pi Telegram Remote Manager started", { projectsRoot: config.projectsRoot, socketPath: config.bridge.socketPath });
    await new Promise<void>((resolveSignal) => {
      const done = () => resolveSignal();
      process.once("SIGINT", done); process.once("SIGTERM", done);
    });
  } finally {
    bot?.stop(); lifecycle?.stop(); await bridge?.close(); store.close(); releaseLock();
  }
}

main().catch((error) => { log("error", "Fatal error", { error: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; });
