import { test } from "node:test";
import assert from "node:assert/strict";
import { maxLineupPoints } from "../api/sleeper.js";

const players = {
  qb1: { position: "QB" }, qb2: { position: "QB" },
  rb1: { position: "RB" }, rb2: { position: "RB" }, rb3: { position: "RB" },
  wr1: { position: "WR" }, wr2: { position: "WR" }, wr3: { position: "WR" },
  te1: { position: "TE" },
  k1: { position: "K" },
};
const homeShape = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "SUPER_FLEX", "BN", "BN"];

test("fills strict slots first, then flex and superflex with the best leftovers", () => {
  const pts = { qb1: 25, qb2: 18, rb1: 20, rb2: 15, rb3: 9, wr1: 22, wr2: 12, wr3: 8, te1: 6, k1: 10 };
  // QB25 RB20 RB15 WR22 WR12 TE6, FLEX: RB9 WR8, SF: QB18 -> 135; K and BN ignored
  assert.equal(maxLineupPoints(pts, homeShape, players), 135);
});

test("a superflex QB beats a flex-eligible player only where it is allowed", () => {
  const pts = { qb1: 30, qb2: 28, rb1: 1, wr1: 1 };
  assert.equal(maxLineupPoints(pts, ["QB", "FLEX", "SUPER_FLEX"], players), 30 + 1 + 28);
});

test("uses fantasy_positions when present and rounds to 2 decimals", () => {
  const multi = { x: { position: "RB", fantasy_positions: ["RB", "WR"] } };
  assert.equal(maxLineupPoints({ x: 10.005 }, ["WR"], multi), 10.01);
});

test("empty slots score nothing and unknown players are skipped", () => {
  assert.equal(maxLineupPoints({ ghost: 50, te1: null }, ["QB", "TE"], players), 0);
});

test("returns null without points or without any known slot", () => {
  assert.equal(maxLineupPoints(null, homeShape, players), null);
  assert.equal(maxLineupPoints({ qb1: 5 }, ["BN", "IR"], players), null);
  assert.equal(maxLineupPoints({ qb1: 5 }, undefined, players), null);
});

test("a flex listed before its strict slot doesn't steal that slot's player", () => {
  // Unsorted, SUPER_FLEX would take the QB and leave the QB slot empty (30).
  assert.equal(maxLineupPoints({ qb1: 30, rb1: 10 }, ["SUPER_FLEX", "QB"], players), 40);
});
