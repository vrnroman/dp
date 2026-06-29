import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildPreflight, buildTimeEnv } from "../src/commands/preflight.ts";
import type { Manifest } from "@platform/manifest";

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

test("a build that reads a declared env var fails without it, but passes once injected", async () => {
  // The fix: the build runs before provisioning, so it must see the env names the host would.
  // buildTimeEnv supplies a placeholder for a declared required secret, so the build compiles.
  const appDir = join(root, "fixtures", "needs-build-env");
  const manifest = { name: "needs-build-env", blueprint: "worker", env: { required: ["NEEDS_THIS"] } } as Manifest;

  const without = await buildPreflight(appDir);
  assert.equal(without.ok, false, "without the env var, the build must fail");
  assert.ok(without.detail && /NEEDS_THIS/.test(without.detail));

  const withEnv = await buildPreflight(appDir, { env: buildTimeEnv(manifest) });
  assert.equal(withEnv.ok, true, withEnv.detail ?? withEnv.summary);
});

test("buildTimeEnv prefers a real declared secret over its placeholder", () => {
  const manifest = { name: "x", blueprint: "web", env: { required: ["API_KEY"] } } as Manifest;
  const env = buildTimeEnv(manifest, { API_KEY: "real-value" } as NodeJS.ProcessEnv);
  assert.equal(env.API_KEY, "real-value");
});

test("buildTimeEnv defines DATABASE_URL only when the app declares a database", () => {
  const withDb = { name: "x", blueprint: "web", database: { engine: "postgres", migrations: "./m" } } as Manifest;
  const noDb = { name: "x", blueprint: "web" } as Manifest;
  assert.ok(buildTimeEnv(withDb).DATABASE_URL);
  assert.equal(buildTimeEnv(noDb).DATABASE_URL, undefined);
});

test("an app with no build step is a no-op, not a failure", async () => {
  // A static site (no package.json) has nothing to build; the gate must not block it.
  const result = await buildPreflight(join(root, "fixtures", "leaky-sql", "supabase"));
  assert.equal(result.ok, true);
  assert.equal(result.ran, false);
});
