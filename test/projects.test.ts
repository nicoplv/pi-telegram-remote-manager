import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectManager } from "../src/projects/project-manager.js";

describe("ProjectManager", () => {
  it("lists and creates only safe direct child directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "tgrm-projects-"));
    const outside = await mkdtemp(join(tmpdir(), "tgrm-outside-"));
    await mkdir(join(root, "existing"));
    await symlink(outside, join(root, "escape"));
    const projects = new ProjectManager(root);
    await projects.initialize();
    expect(await projects.list()).toEqual(["existing"]);
    await projects.create("new-project");
    expect(await projects.resolve("new-project")).toBe(await realpath(join(root, "new-project")));
    await expect(projects.resolve("escape")).rejects.toThrow();
    await expect(projects.create("../bad")).rejects.toThrow();
    await expect(projects.create("EXISTING")).rejects.toThrow();
  });
});
