import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProcessRunner {
  run(file: string, args: string[], options?: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv }): Promise<{ stdout: string; stderr: string }>;
}

export const processRunner: ProcessRunner = {
  async run(file, args, options) {
    const result = await execFileAsync(file, args, { cwd: options?.cwd, timeout: options?.timeout, env: options?.env, encoding: "utf8", maxBuffer: 2_000_000 });
    return { stdout: result.stdout, stderr: result.stderr };
  },
};
