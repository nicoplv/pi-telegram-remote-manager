import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

const PROJECT_NAME = /^(?=.{1,64}$)[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class ProjectManager {
  private canonicalRoot?: string;
  constructor(readonly root: string) {}

  async initialize(): Promise<void> {
    const info = await stat(this.root).catch(() => undefined);
    if (!info?.isDirectory()) throw new Error(`projectsRoot is not a directory: ${this.root}`);
    this.canonicalRoot = await realpath(this.root);
  }

  validateName(name: string): void {
    if (!PROJECT_NAME.test(name) || name === "." || name === "..") throw new Error("Project names must be 1-64 safe filename characters");
  }

  private rootPath(): string {
    if (!this.canonicalRoot) throw new Error("ProjectManager is not initialized");
    return this.canonicalRoot;
  }

  async list(): Promise<string[]> {
    const entries = await readdir(this.rootPath(), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
  }

  async create(name: string): Promise<string> {
    this.validateName(name);
    const existing = await this.list();
    if (existing.some((item) => item.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error("A project with that name already exists");
    const path = join(this.rootPath(), name);
    await mkdir(path, { recursive: false, mode: 0o700 });
    return path;
  }

  async resolve(projectId: string): Promise<string> {
    this.validateName(projectId);
    const candidate = resolve(this.rootPath(), projectId);
    const canonical = await realpath(candidate);
    const rel = relative(this.rootPath(), canonical);
    if (!rel || rel.startsWith("..") || basename(canonical) !== projectId) throw new Error("Project resolves outside projectsRoot");
    const info = await stat(canonical);
    if (!info.isDirectory()) throw new Error("Project is not a directory");
    return canonical;
  }
}
