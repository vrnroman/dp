import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildPreflight } from "../src/commands/preflight.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("an app that builds cleanly passes the build preflight", async () => {
  const result = await buildPreflight(join(root, "fixtures", "builds-clean"));
  assert.equal(result.ok, true, result.detail ?? result.summary);
  assert.equal(result.ran, true);
});

test("an app whose build fails is refused, with the real error handed back", async () => {
  // This is the whole point: the break is caught here, in plain English, NOT as a cryptic
  // host build failure discovered after provisioning.
  const result = await buildPreflight(join(root, "fixtures", "builds-broken"));
  assert.equal(result.ok, false);
  assert.match(result.summary, /did not build/i);
  assert.ok(result.detail && /PREFLIGHT_MARKER/.test(result.detail), "the build error must be surfaced");
});

test("an app with no build step is a no-op, not a failure", async () => {
  // A static site (no package.json) has nothing to build; the gate must not block it.
  const result = await buildPreflight(join(root, "fixtures", "leaky-sql", "supabase"));
  assert.equal(result.ok, true);
  assert.equal(result.ran, false);
});
