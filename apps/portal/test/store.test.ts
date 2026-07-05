// The DP central store: groups, membership, per-app role mapping, fail-closed resolution, the app
// registry, atomic persistence + backups. Zero-dep JSON store, exercised against a temp file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createStore, resolveRoles, normalizeOrigin } = require("../store.js");

const APP = "https://guestbook.vercel.app";
const ROLES = [
  { name: "viewer", can: "read the guestbook" },
  { name: "editor", can: "leave notes" },
];

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "dp-store-"));
  return { store: createStore(join(dir, "store.json")), dir };
}

test("pure resolveRoles mirrors roles.ts: fail-closed, owner-all, fence", () => {
  assert.deepEqual(resolveRoles({ isOwner: false, defaultRole: "viewer", grantedRoles: [], declaredRoles: ["viewer", "editor"] }), ["viewer"]);
  assert.deepEqual(resolveRoles({ isOwner: true, defaultRole: null, grantedRoles: [], declaredRoles: ["viewer", "editor"] }), ["editor", "viewer"]);
  // A granted role the app never declared is dropped (fence).
  assert.deepEqual(resolveRoles({ isOwner: false, defaultRole: null, grantedRoles: ["admin", "editor"], declaredRoles: ["viewer", "editor"] }), ["editor"]);
  // No declared roles => nothing, even for the owner.
  assert.deepEqual(resolveRoles({ isOwner: true, defaultRole: "x", grantedRoles: ["x"], declaredRoles: [] }), []);
});

test("groups: create is idempotent by name; rename; delete cascades", () => {
  const { store } = freshStore();
  const a = store.createGroup("Family");
  const b = store.createGroup("family"); // same name, case-insensitive
  assert.equal(a.id, b.id);
  assert.equal(store.listGroups().length, 1);
  store.renameGroup(a.id, "Household");
  assert.equal(store.listGroups()[0].name, "Household");

  store.registerApp(APP, { declaredRoles: ROLES, defaultRole: "viewer" });
  store.addMember(a.id, "Mom@Example.com");
  store.setGroupRolesForApp(APP, a.id, ["editor"]);
  assert.deepEqual(store.membersOf(a.id), ["mom@example.com"]); // normalized
  assert.deepEqual(store.rolesForGroupInApp(APP, a.id), ["editor"]);

  store.deleteGroup(a.id);
  assert.equal(store.listGroups().length, 0);
  assert.deepEqual(store.rolesForGroupInApp(APP, a.id), []); // mapping cascaded away
});

test("setGroupRolesForApp is fail-closed to the app's declared roles", () => {
  const { store } = freshStore();
  store.registerApp(APP, { declaredRoles: ROLES, defaultRole: "viewer" });
  const g = store.createGroup("Editors");
  store.setGroupRolesForApp(APP, g.id, ["editor", "admin", "superuser"]); // only editor is declared
  assert.deepEqual(store.rolesForGroupInApp(APP, g.id), ["editor"]);
});

test("resolve(email, app): default + group grants, intersected with declared", () => {
  const { store } = freshStore();
  store.registerApp(APP, { declaredRoles: ROLES, defaultRole: "viewer", ownerEmail: "owner@x.com" });
  const editors = store.createGroup("Editors");
  store.setGroupRolesForApp(APP, editors.id, ["editor"]);
  store.addMember(editors.id, "jo@x.com");

  // A signed-in stranger gets only the default role.
  assert.deepEqual(store.resolve("stranger@x.com", APP), ["viewer"]);
  // A member of Editors gets default + editor.
  assert.deepEqual(store.resolve("jo@x.com", APP), ["editor", "viewer"]);
  // The app owner implicitly holds every declared role.
  assert.deepEqual(store.resolve("owner@x.com", APP), ["editor", "viewer"]);
  // An unknown app grants nothing.
  assert.deepEqual(store.resolve("jo@x.com", "https://not-registered.vercel.app"), []);
});

test("persistence: survives a reload; writes are atomic with backups", () => {
  const dir = mkdtempSync(join(tmpdir(), "dp-store-"));
  const file = join(dir, "store.json");
  const s1 = createStore(file);
  const g = s1.createGroup("Family");
  s1.registerApp(APP, { declaredRoles: ROLES, defaultRole: "viewer" });
  s1.addMember(g.id, "mom@x.com");
  s1.setGroupRolesForApp(APP, g.id, ["editor"]);

  // A fresh store over the same file sees everything.
  const s2 = createStore(file);
  assert.equal(s2.listGroups().length, 1);
  assert.deepEqual(s2.membersOf(g.id), ["mom@x.com"]);
  assert.deepEqual(s2.rolesForGroupInApp(APP, g.id), ["editor"]);
  // A backup was taken on a later write.
  assert.ok(existsSync(`${file}.bak.1`), "expected a rotated backup");
});

test("a corrupt store file does not crash; starts empty and heals on next write", () => {
  const dir = mkdtempSync(join(tmpdir(), "dp-store-"));
  const file = join(dir, "store.json");
  writeFileSync(file, "{ this is not json ");
  const s = createStore(file); // must not throw
  assert.equal(s.listGroups().length, 0);
  s.createGroup("Recovered");
  const reread = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(Object.keys(reread.groups).length, 1);
});

test("normalizeOrigin: https + http(localhost) only, else empty (fail-closed)", () => {
  assert.equal(normalizeOrigin("https://a.vercel.app/x/y"), "https://a.vercel.app");
  assert.equal(normalizeOrigin("http://localhost:3000/z"), "http://localhost:3000");
  assert.equal(normalizeOrigin("http://evil.com"), "");
  assert.equal(normalizeOrigin("not a url"), "");
});
