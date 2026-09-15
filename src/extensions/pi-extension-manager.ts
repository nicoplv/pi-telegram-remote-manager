import type { ProcessRunner } from "../process-runner.js";
import type { ProjectManager } from "../projects/project-manager.js";

export type PiExtensionTarget = { scope: "global" } | { scope: "project"; projectId: string };

const PACKAGE_TIMEOUT_MS = 300_000;
const REMOTE_SOURCE = /^(?:npm:|git:|https?:\/\/|ssh:\/\/|git:\/\/)\S+$/;

export class PiExtensionManager {
  constructor(
    private readonly piExecutable: string,
    private readonly runner: ProcessRunner,
    private readonly projects: ProjectManager,
    private readonly globalCwd: string,
  ) {}

  async install(target: PiExtensionTarget, source: string): Promise<void> {
    validateSource(source);
    await this.run(target, ["install", source]);
  }

  async uninstall(target: PiExtensionTarget, source: string): Promise<void> {
    validateSource(source);
    await this.run(target, ["remove", source]);
  }

  async update(target: PiExtensionTarget, source: string): Promise<void> {
    validateSource(source);
    await this.run(target, ["update", "--extension", source]);
  }

  async updatePi(): Promise<void> {
    await this.run({ scope: "global" }, ["update", "--self"]);
  }

  async list(target: PiExtensionTarget): Promise<string[]> {
    const { stdout } = await this.run(target, ["list"]);
    return parsePackageList(stdout, target.scope).filter(isRemoteSource);
  }

  private async run(target: PiExtensionTarget, args: string[]): Promise<{ stdout: string; stderr: string }> {
    const local = target.scope === "project";
    const cwd = local ? await this.projects.resolve(target.projectId) : this.globalCwd;
    const commandArgs = args[0] === "list"
      ? args
      : [...args, ...(args[0] === "update"
        ? [local ? "--approve" : "--no-approve"]
        : local ? ["-l", "--approve"] : ["--no-approve"])];
    try {
      return await this.runner.run(this.piExecutable, commandArgs, {
        cwd,
        timeout: PACKAGE_TIMEOUT_MS,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", GIT_TERMINAL_PROMPT: "0" },
      });
    } catch (error) {
      throw new Error(formatCommandError(args[0], error));
    }
  }
}

export function validateSource(source: string): void {
  if (!isRemoteSource(source)) {
    throw new Error("Extension source must be a whitespace-free npm, git, HTTP(S), or SSH package source");
  }
}

function isRemoteSource(source: string): boolean { return REMOTE_SOURCE.test(source); }

export function parsePackageList(output: string, scope: PiExtensionTarget["scope"]): string[] {
  const wanted = scope === "global" ? "user" : "project";
  let section: "user" | "project" | undefined;
  const packages: string[] = [];
  for (const rawLine of stripAnsi(output).split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === "User packages:") { section = "user"; continue; }
    if (line === "Project packages:") { section = "project"; continue; }
    const match = /^ {2}(\S.*)$/.exec(line);
    if (section === wanted && match) packages.push(match[1].replace(/ \(filtered\)$/, ""));
  }
  return packages;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "");
}

function formatCommandError(action: string, error: unknown): string {
  const processError = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
  if (processError?.killed === true || processError?.code === "ETIMEDOUT") {
    return `Pi ${action} timed out after ${PACKAGE_TIMEOUT_MS / 60_000} minutes`;
  }
  const details = processError
    ? ["stderr", "stdout", "message"].map((key) => processError[key]).find((value) => typeof value === "string" && value.trim())
    : undefined;
  const text = stripAnsi(String(details ?? error)).trim().replace(/\s+/g, " ").slice(0, 1200);
  return `Pi ${action} failed${text ? `: ${text}` : ""}`;
}
