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

test("a proper-tier manifest with roles, signup, and default parses", () => {
  const { manifest, issues } = parseManifest(`
name: recipe-box
blueprint: web
web:
  framework: nextjs
auth:
  tier: proper
  signup: open
  roles:
    - name: viewer
      can: only read
    - name: editor
      can: post and edit recipes
    - name: admin
      can: everything, including deleting
  default: viewer
`);
  assert.equal(issues.length, 0, JSON.stringify(issues));
  assert.equal(manifest?.auth?.tier, "proper");
  assert.equal(manifest?.auth?.signup, "open");
  assert.equal(manifest?.auth?.default, "viewer");
  assert.equal(manifest?.auth?.roles?.length, 3);
  assert.equal(manifest?.auth?.roles?.[1].can, "post and edit recipes");
});

test("a default role that is not declared is rejected", () => {
  const { issues } = parseManifest(`
name: recipe-box
blueprint: web
auth:
  tier: proper
  roles:
    - name: viewer
      can: only read
  default: superadmin
`);
  assert.ok(issues.some((i) => i.path === "auth.default"));
});

test("a role without a description is rejected", () => {
  const { issues } = parseManifest(`
name: recipe-box
blueprint: web
auth:
  tier: proper
  roles:
    - name: editor
      can: ""
`);
  assert.ok(issues.some((i) => i.path.startsWith("auth.roles")));
});

test("a bad role name is rejected", () => {
  const { issues } = parseManifest(`
name: recipe-box
blueprint: web
auth:
  tier: proper
  roles:
    - name: "Super Admin"
      can: everything
`);
  assert.ok(issues.some((i) => i.path.includes("roles") && i.path.includes("name")));
});

test("roles with no sign-in (tier none) are rejected", () => {
  const { issues } = parseManifest(`
name: recipe-box
blueprint: web
auth:
  tier: none
  roles:
    - name: editor
      can: post
`);
  assert.ok(issues.some((i) => i.path === "auth"));
});

test("an unknown signup mode is rejected", () => {
  const { issues } = parseManifest(`
name: recipe-box
blueprint: web
auth:
  tier: proper
  signup: sometimes
`);
  assert.ok(issues.some((i) => i.path === "auth.signup"));
});

test("duplicate role names are caught", () => {
  const { issues } = parseManifest(`
name: recipe-box
blueprint: web
auth:
  tier: proper
  roles:
    - name: editor
      can: post
    - name: editor
      can: post again
`);
  assert.ok(issues.some((i) => i.path.includes("roles") && i.problem.includes("twice")));
});
