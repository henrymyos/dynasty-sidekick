import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshotBase } from "../api/values-history.js";

test("prefers the production domain from Vercel's env over any header", () => {
  assert.equal(snapshotBase({ VERCEL_PROJECT_PRODUCTION_URL: "dp.example.app" }, "evil.example"), "https://dp.example.app");
});

test("falls back to the Host header: http for local dev, https otherwise", () => {
  assert.equal(snapshotBase({}, "localhost:3000"), "http://localhost:3000");
  assert.equal(snapshotBase({}, "127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.equal(snapshotBase({}, "dp.vercel.app"), "https://dp.vercel.app");
  assert.equal(snapshotBase({}, "localhost.evil.com"), "https://localhost.evil.com");
});

test("rejects empty or malformed hosts", () => {
  for (const h of ["", undefined, "evil.com/@x", "a b", "evil.com#"]) assert.throws(() => snapshotBase({}, h));
});
