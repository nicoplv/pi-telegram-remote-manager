import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/store.js";

describe("StateStore pairing", () => {
  it("consumes a pairing code exactly once and persists the owner", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tgrm-store-"));
    const store = new StateStore(dir);
    const code = store.ensurePairingCode();
    expect(code).toMatch(/^\d{6}$/);
    expect(store.pairOwner(12, 12, "wrong")).toBe(false);
    expect(store.pairOwner(12, 12, code)).toBe(true);
    expect(store.pairOwner(13, 13, code)).toBe(false);
    expect(store.getOwner()).toEqual({ userId: 12, chatId: 12 });
    store.close();

    const reopened = new StateStore(dir);
    expect(reopened.getOwner()).toEqual({ userId: 12, chatId: 12 });
    reopened.close();
  });

  it("resets the owner locally", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tgrm-store-"));
    const store = new StateStore(dir);
    const first = store.ensurePairingCode();
    store.pairOwner(1, 1, first);
    const next = store.resetOwner();
    expect(store.getOwner()).toBeUndefined();
    expect(store.pairOwner(2, 2, next)).toBe(true);
    store.close();
  });
});
