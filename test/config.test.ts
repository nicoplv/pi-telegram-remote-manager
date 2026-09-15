import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, redactConfig } from "../src/config.js";

describe("configuration", () => {
  const previous = process.env.TEST_TELEGRAM_TOKEN;
  afterEach(() => { if (previous === undefined) delete process.env.TEST_TELEGRAM_TOKEN; else process.env.TEST_TELEGRAM_TOKEN = previous; });

  it("expands secrets and applies defaults without exposing the token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tgrm-config-"));
    process.env.TEST_TELEGRAM_TOKEN = "top-secret";
    const path = join(dir, "config.yaml");
    await writeFile(path, `telegram:\n  botToken: \${TEST_TELEGRAM_TOKEN}\nprojectsRoot: ${dir}\ndataDir: ${join(dir, "state")}\n`);
    const config = await loadConfig(path);
    expect(config.telegram.botToken).toBe("top-secret");
    expect(config.sessions.idleTimeoutMinutes).toBe(10);
    expect(JSON.stringify(redactConfig(config))).not.toContain("top-secret");
  });

  it("rejects a missing secret", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tgrm-config-"));
    const path = join(dir, "config.yaml");
    await writeFile(path, `telegram:\n  botToken: \${DOES_NOT_EXIST}\nprojectsRoot: ${dir}\n`);
    await expect(loadConfig(path)).rejects.toThrow("DOES_NOT_EXIST");
  });
});
