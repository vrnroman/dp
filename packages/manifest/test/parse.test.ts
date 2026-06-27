import { test } from "node:test";
import assert from "node:assert/strict";
import { parseManifest } from "../src/index.ts";

test("a complete web manifest parses", () => {
  const { manifest, issues } = parseManifest(`
name: budget-tracker
blueprint: web
web:
  framework: nextjs
database:
  engine: postgres
  migrations: ./migrations
auth:
  tier: simple
  allowlist:
    - mom@example.com
storage:
  buckets:
    - photos
`);
  assert.equal(issues.length, 0);
  assert.equal(manifest?.name, "budget-tracker");
  assert.equal(manifest?.blueprint, "web");
  assert.equal(manifest?.auth?.tier, "simple");
  assert.deepEqual(manifest?.storage?.buckets, ["photos"]);
});

test("a missing name and blueprint are both reported with fixes", () => {
  const { manifest, issues } = parseManifest(`runtime: node20`);
  assert.equal(manifest, null);
  const paths = issues.map((i) => i.path);
  assert.ok(paths.includes("name"));
  assert.ok(paths.includes("blueprint"));
  for (const i of issues) assert.ok(i.fix.length > 0, "every issue carries a fix");
});

test("an unknown blueprint is rejected", () => {
  const { issues } = parseManifest(`name: x-app\nblueprint: kubernetes`);
  assert.ok(issues.some((i) => i.path === "blueprint"));
});

test("a bad app name is rejected with a human example", () => {
  const { issues } = parseManifest(`name: My App!\nblueprint: web`);
  const nameIssue = issues.find((i) => i.path === "name");
  assert.ok(nameIssue);
  assert.match(nameIssue!.fix, /budget-tracker/);
});

test("database without migrations is caught", () => {
  const { issues } = parseManifest(`name: x-app\nblueprint: web\ndatabase:\n  engine: postgres`);
  assert.ok(issues.some((i) => i.path === "database.migrations"));
});

test("invalid yaml does not throw", () => {
  const { manifest, issues } = parseManifest(`name: : :\n  - bad`);
  assert.equal(manifest, null);
  assert.ok(issues.length > 0);
});
