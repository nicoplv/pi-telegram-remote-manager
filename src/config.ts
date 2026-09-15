import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { AppConfig } from "./types.js";

const envPattern = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

const rawSchema = z.object({
  telegram: z.object({ botToken: z.string().min(1) }),
  projectsRoot: z.string().min(1),
  dataDir: z.string().min(1).optional(),
  pi: z.object({ executable: z.string().min(1).default("pi") }).default({ executable: "pi" }),
  tmux: z.object({ executable: z.string().min(1).default("tmux") }).default({ executable: "tmux" }),
  sessions: z.object({
    idleTimeoutMinutes: z.number().positive().default(10),
    bridgeRegistrationTimeoutSeconds: z.number().positive().default(20),
  }).default({ idleTimeoutMinutes: 10, bridgeRegistrationTimeoutSeconds: 20 }),
  render: z.object({
    tools: z.enum(["hidden", "brief", "full"]).default("brief"),
    thinking: z.enum(["hidden", "brief", "full"]).default("brief"),
    streamIntervalMs: z.number().int().min(500).max(10_000).default(1000),
  }).default({ tools: "brief", thinking: "brief", streamIntervalMs: 1000 }),
  bridge: z.object({ transport: z.literal("unix-socket").default("unix-socket") }).default({ transport: "unix-socket" }),
});

function expandScalar(value: string): string {
  const match = envPattern.exec(value);
  if (!match) return value;
  const resolved = process.env[match[1]];
  if (!resolved) throw new Error(`Environment variable ${match[1]} is required`);
  return resolved;
}

function resolveUserPath(value: string): string {
  const expanded = value === "~" ? homedir() : value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value;
  return resolve(expanded);
}

export async function loadConfig(path: string): Promise<AppConfig> {
  const configPath = resolve(path);
  const document = parse(await readFile(configPath, "utf8"));
  if (document?.telegram?.botToken) document.telegram.botToken = expandScalar(document.telegram.botToken);
  const raw = rawSchema.parse(document);
  const dataDir = resolveUserPath(raw.dataDir ?? "~/.pi-telegram-remote-manager");
  const dataKey = createHash("sha256").update(dataDir).digest("hex").slice(0, 10);
  const socketFile = `pi-tgrm-${process.getuid?.() ?? process.pid}-${dataKey}.sock`;
  const candidateSocket = resolve(dataDir, socketFile);
  const socketPath = Buffer.byteLength(candidateSocket) < 96 ? candidateSocket : resolve(tmpdir(), socketFile);
  return {
    ...raw,
    projectsRoot: resolveUserPath(isAbsolute(raw.projectsRoot) ? raw.projectsRoot : resolve(dirname(configPath), raw.projectsRoot)),
    dataDir,
    bridge: { transport: "unix-socket", socketPath },
  };
}

export function redactConfig(config: AppConfig): unknown {
  return { ...config, telegram: { botToken: "[REDACTED]" } };
}
