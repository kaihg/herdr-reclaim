// 左側遠征列表的分組：現役在上、其餘是歷史、沒講過話就撤回的格不出現。
import { describe, expect, test } from "bun:test";

import { expeditionGroups } from "../core/town.js";

const tile = (id, patch = {}) => ({
  rootSessionId: id,
  generation: 1,
  activatedAt: 1000,
  status: "idle",
  visits: [{ endedAt: 1 }],
  landStage: "reserved",
  providerUsage: [{ provider: "anthropic", usage: {} }],
  harvests: [],
  ...patch,
});

const ids = (tiles) => tiles.map((entry) => entry.rootSessionId);

describe("expeditionGroups", () => {
  test("session 還掛著（含 idle）在現役、新的在上；其餘進歷史", () => {
    const groups = expeditionGroups([
      tile("old-live", { visits: [{ endedAt: null }], activatedAt: 1000 }),
      tile("parked", { activatedAt: 3000 }),
      tile("idle-attached", { activatedAt: 1500, status: "idle", visits: [{ endedAt: null }] }),
      tile("new-live", { visits: [{ endedAt: null }], activatedAt: 2000 }),
      tile("done", { landStage: "archived", visits: [{ endedAt: null }], activatedAt: 500 }),
    ]);
    expect(ids(groups.live)).toEqual(["new-live", "idle-attached", "old-live"]);
    expect(ids(groups.history)).toEqual(["parked", "done"]);
    expect(groups.hidden).toEqual([]);
  });

  test("撤回且沒有任何用量與收成的格不出現；有講過話的撤回格留在歷史", () => {
    const groups = expeditionGroups([
      tile("silent", { landStage: "withdrawn", providerUsage: [] }),
      tile("talked", { landStage: "withdrawn" }),
    ]);
    expect(ids(groups.hidden)).toEqual(["silent"]);
    expect(ids(groups.history)).toEqual(["talked"]);
    expect(groups.live).toEqual([]);
  });

  test("沒講過話但還駐紮著（沒撤回）的格仍列出，等使用者決定", () => {
    const groups = expeditionGroups([tile("fresh", { visits: [{ endedAt: null }], providerUsage: [] })]);
    expect(ids(groups.live)).toEqual(["fresh"]);
    expect(groups.hidden).toEqual([]);
  });
});
