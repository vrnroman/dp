import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRoles, hasRole, decideAccess, MemoryGroupsStore } from "../src/roles.ts";

const DECLARED = ["viewer", "editor", "admin"];

test("the owner holds every declared role", () => {
  const roles = resolveRoles({ isOwner: true, defaultRole: "viewer", grantedRoles: [], declaredRoles: DECLARED });
  assert.deepEqual(roles, ["admin", "editor", "viewer"]);
});

test("everyone who signs in holds the default role", () => {
  const roles = resolveRoles({ isOwner: false, defaultRole: "viewer", grantedRoles: [], declaredRoles: DECLARED });
  assert.deepEqual(roles, ["viewer"]);
});

test("group membership grants roles on top of the default", () => {
  const roles = resolveRoles({ isOwner: false, defaultRole: "viewer", grantedRoles: ["editor"], declaredRoles: DECLARED });
  assert.deepEqual(roles, ["editor", "viewer"]);
});

test("fail-closed: a granted role the app never declared is not granted", () => {
  const roles = resolveRoles({ isOwner: false, defaultRole: "viewer", grantedRoles: ["superadmin", "editor"], declaredRoles: DECLARED });
  assert.deepEqual(roles, ["editor", "viewer"]);
  assert.ok(!roles.includes("superadmin"));
});

test("fail-closed: a default role outside the declared set grants nothing", () => {
  const roles = resolveRoles({ isOwner: false, defaultRole: "ghost", grantedRoles: [], declaredRoles: DECLARED });
  assert.deepEqual(roles, []);
});

test("no declared roles means no roles for anyone, even the owner", () => {
  assert.deepEqual(resolveRoles({ isOwner: true, defaultRole: "viewer", grantedRoles: ["editor"], declaredRoles: [] }), []);
});

test("no default role and no groups means a signed-in stranger holds nothing", () => {
  assert.deepEqual(resolveRoles({ isOwner: false, defaultRole: null, grantedRoles: [], declaredRoles: DECLARED }), []);
});

test("hasRole reflects resolveRoles", () => {
  const input = { isOwner: false, defaultRole: "viewer", grantedRoles: ["editor"], declaredRoles: DECLARED };
  assert.ok(hasRole("editor", input));
  assert.ok(hasRole("viewer", input));
  assert.ok(!hasRole("admin", input));
});

test("MemoryGroupsStore: create, add people, map roles, resolve grants", async () => {
  const s = new MemoryGroupsStore();
  const editors = await s.createGroup("Editors");
  const admins = await s.createGroup("Admins");
  await s.addToGroup(editors.id, "Alice@Example.com");
  await s.addToGroup(admins.id, "bob@example.com");
  await s.setGroupRoles(editors.id, ["editor"]);
  await s.setGroupRoles(admins.id, ["admin", "editor"]);

  // case-insensitive membership
  assert.deepEqual(await s.grantedRolesForEmail("alice@example.com"), ["editor"]);
  assert.deepEqual(await s.grantedRolesForEmail("bob@example.com"), ["admin", "editor"]);
  assert.deepEqual(await s.grantedRolesForEmail("stranger@example.com"), []);

  // membership listings
  assert.deepEqual(await s.membersOf(editors.id), ["alice@example.com"]);
  const aliceGroups = await s.groupsForEmail("alice@example.com");
  assert.deepEqual(aliceGroups.map((g) => g.name), ["Editors"]);
});

test("MemoryGroupsStore: removing from a group removes the grant immediately (live resolution)", async () => {
  const s = new MemoryGroupsStore();
  const g = await s.createGroup("Team");
  await s.addToGroup(g.id, "sam@example.com");
  await s.setGroupRoles(g.id, ["editor"]);
  assert.deepEqual(await s.grantedRolesForEmail("sam@example.com"), ["editor"]);
  await s.removeFromGroup(g.id, "sam@example.com");
  assert.deepEqual(await s.grantedRolesForEmail("sam@example.com"), []);
});

test("MemoryGroupsStore: createGroup is idempotent on name", async () => {
  const s = new MemoryGroupsStore();
  const a = await s.createGroup("Family");
  const b = await s.createGroup("Family");
  assert.equal(a.id, b.id);
  assert.equal((await s.listGroups()).length, 1);
});

test("MemoryGroupsStore: the people directory records who has signed in", async () => {
  const s = new MemoryGroupsStore();
  await s.recordPerson({ email: "New@Example.com", name: "New Person" });
  const people = await s.listPeople();
  assert.equal(people.length, 1);
  assert.equal(people[0].email, "new@example.com");
  assert.equal(people[0].name, "New Person");
});

test("decideAccess: the owner email is always let in as owner", () => {
  assert.deepEqual(
    decideAccess({ email: "boss@example.com", ownerEmail: "boss@example.com", signup: "invite" }),
    { allowed: true, isOwner: true },
  );
});

test("decideAccess: open signup lets any verified stranger in as a member", () => {
  assert.deepEqual(
    decideAccess({ email: "new@example.com", ownerEmail: "boss@example.com", signup: "open" }),
    { allowed: true, isOwner: false },
  );
});

test("decideAccess: invite signup turns away a stranger not on the allowlist", () => {
  assert.deepEqual(
    decideAccess({ email: "stranger@example.com", ownerEmail: "boss@example.com", signup: "invite", allowlistRole: null }),
    { allowed: false, isOwner: false },
  );
});

test("decideAccess: invite signup lets an allowlisted member in", () => {
  assert.deepEqual(
    decideAccess({ email: "friend@example.com", ownerEmail: "boss@example.com", signup: "invite", allowlistRole: "member" }),
    { allowed: true, isOwner: false },
  );
});

test("decideAccess: an allowlist owner marking elevates, in either mode", () => {
  assert.deepEqual(
    decideAccess({ email: "co@example.com", ownerEmail: "boss@example.com", signup: "open", allowlistRole: "owner" }),
    { allowed: true, isOwner: true },
  );
  assert.deepEqual(
    decideAccess({ email: "co@example.com", ownerEmail: "boss@example.com", signup: "invite", allowlistRole: "owner" }),
    { allowed: true, isOwner: true },
  );
});

test("decideAccess: an empty email is refused (fail-closed)", () => {
  assert.deepEqual(decideAccess({ email: "", ownerEmail: "boss@example.com", signup: "open" }), {
    allowed: false,
    isOwner: false,
  });
});

test("end-to-end: resolve a member's roles from the store", async () => {
  const s = new MemoryGroupsStore();
  const g = await s.createGroup("Editors");
  await s.addToGroup(g.id, "member@example.com");
  await s.setGroupRoles(g.id, ["editor"]);
  const granted = await s.grantedRolesForEmail("member@example.com");
  const roles = resolveRoles({ isOwner: false, defaultRole: "viewer", grantedRoles: granted, declaredRoles: DECLARED });
  assert.deepEqual(roles, ["editor", "viewer"]);
});
