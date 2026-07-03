/**
 * Territory proof for the data layer.
 *
 * Stands up a real Postgres in-process (PGlite, Postgres compiled to WASM) and exposes it
 * over the Postgres wire protocol, then runs every database-touching production function
 * against it with the real `pg` driver, unchanged. This is the closest thing to the live
 * Supabase round-trip we can run with no cloud project and no docker: real SQL, real
 * protocol, real code paths.
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import pg from "pg";

import { runMigrations, seedAllowlist, ensureGroupsTables, canConnect } from "../packages/cli/src/providers/postgres.ts";
import { PgAllowlist } from "@platform/auth/pg-store";
import { PgGroupsStore } from "@platform/auth/pg-groups";
import { authorize, resolveRoles } from "@platform/auth";
import { addNote, listNotes } from "../apps/reference-web/lib/db.ts";

const root = dirname(fileURLToPath(import.meta.url));
const PORT = 5599;
const URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;

function ok(msg: string) {
  process.stdout.write(`  ok   ${msg}\n`);
}

async function main() {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1" });
  await server.start();
  process.env.DATABASE_URL = URL;

  try {
    process.stdout.write("Verifying the data layer against a real Postgres:\n");

    // 1. Connectivity (the same probe `up` runs before migrating).
    assert.equal(await canConnect(URL), true);
    ok("The platform can connect to a real Postgres over the wire.");

    // 2. Migrations: the app's own .sql files, run by the platform's migration runner.
    const migrations = join(root, "..", "apps", "reference-web", "migrations");
    const report = await runMigrations(URL, migrations);
    assert.ok(report.applied.includes("0001_init.sql"), "0001_init.sql should apply");
    ok(`Migrations ran for real (${report.applied.join(", ")}).`);

    // 2b. Re-running is safe: nothing applies twice.
    const again = await runMigrations(URL, migrations);
    assert.equal(again.applied.length, 0);
    assert.ok(again.skipped.includes("0001_init.sql"));
    ok("Re-running migrations is safe (already-applied files are skipped).");

    // 3. Allowlist seeding (the front door), exactly as `up` seeds it.
    await seedAllowlist(URL, "owner@example.com", ["friend@example.com", "owner@example.com"]);
    // Create the groups/people schema now, while each setup step still uses its own short-lived
    // connection (PGlite serves one at a time; the long-lived pool below must be the only one).
    await ensureGroupsTables(URL);
    const pool = new pg.Pool({ connectionString: URL, max: 1 });
    const store = new PgAllowlist(pool);

    // 4. authorize(): the exact production path simple-auth uses to admit a person.
    const owner = await authorize("owner@example.com", store);
    assert.deepEqual(owner, { email: "owner@example.com", role: "owner" });
    ok("The owner is admitted as owner.");

    const friend = await authorize("FRIEND@example.com", store); // case-insensitive
    assert.deepEqual(friend, { email: "friend@example.com", role: "member" });
    ok("An allowlisted friend is admitted as member (case-insensitive).");

    const stranger = await authorize("stranger@example.com", store);
    assert.equal(stranger, null);
    ok("A stranger is turned away.");

    const people = await store.list();
    assert.equal(people.length, 2, "owner + friend, no duplicate owner");
    ok("The allowlist holds exactly the right people (no duplicate owner).");

    // 5. The owner can be granted, a guest added and removed (the settings surface).
    await store.add("guest@example.com");
    assert.ok(await store.find("guest@example.com"));
    await store.remove("guest@example.com");
    assert.equal(await store.find("guest@example.com"), null);
    ok("Adding and removing people works.");

    // 5b. The groups machinery (the proper/Google tier): real schema, real joins. Mapping people
    //     to roles is the platform's job; this is that job running against real Postgres.
    const groups = new PgGroupsStore(pool);
    const editors = await groups.createGroup("Editors");
    assert.equal((await groups.createGroup("Editors")).id, editors.id); // idempotent on name
    await groups.addToGroup(editors.id, "Friend@example.com"); // stored case-insensitively
    await groups.setGroupRoles(editors.id, ["editor", "bogus"]);
    const granted = await groups.grantedRolesForEmail("friend@example.com");
    assert.ok(granted.includes("editor"), "the SQL join returns the granted role");
    ok("Groups: an added member's granted roles come back from a real SQL join.");

    // Fail-closed: a role the app never declared ("bogus") is dropped at resolution.
    const resolved = resolveRoles({ isOwner: false, defaultRole: "viewer", grantedRoles: granted, declaredRoles: ["viewer", "editor"] });
    assert.deepEqual(resolved, ["editor", "viewer"]);
    ok("Roles resolve fail-closed against the declared set (an undeclared grant is dropped).");

    await groups.removeFromGroup(editors.id, "friend@example.com");
    assert.deepEqual(await groups.grantedRolesForEmail("friend@example.com"), []);
    ok("Removing someone from a group revokes their roles immediately (live resolution).");

    // Deleting the group cascades to its members and role mappings (no orphans).
    await groups.addToGroup(editors.id, "someone@example.com");
    await groups.deleteGroup(editors.id);
    assert.equal((await groups.listGroups()).length, 0);
    assert.deepEqual(await groups.grantedRolesForEmail("someone@example.com"), []);
    ok("Deleting a group cascades cleanly (members and role mappings go with it).");

    await groups.recordPerson({ email: "New@example.com", name: "New Person" });
    const ppl = await groups.listPeople();
    assert.ok(ppl.some((p) => p.email === "new@example.com" && p.name === "New Person"));
    ok("The people directory records who has signed in (the 'just arrived' list).");

    await pool.end();
    // PGlite serves ONE connection at a time; give its server a beat to fully release the pool's
    // socket before lib/db opens its own, so the handoff does not race into an ECONNRESET.
    await new Promise((r) => setTimeout(r, 200));

    // 6. The app's real write + read path (lib/db.ts), against real Postgres. Done last so
    // the app's lazy pool is the only open connection (PGlite serves one at a time).
    await addNote("owner@example.com", "hello from a real database", null);
    const notes = await listNotes();
    assert.ok(
      notes.some((n) => n.body === "hello from a real database" && n.author_email === "owner@example.com"),
    );
    ok("A note written through the app is saved and read back from real Postgres.");

    // Warm first open: the seeded welcome note is there too (proves the migration seed ran).
    assert.ok(notes.some((n) => /Welcome to your guestbook/.test(n.body)));
    ok("Warm first open works: the seeded welcome note is in the database.");

    process.stdout.write("\nThe full data layer works against a real Postgres. Verified.\n");
  } finally {
    await server.stop();
    await db.close();
  }
  // lib/db keeps a lazy pool open; exit cleanly now that all assertions passed.
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`\nData-layer verification FAILED: ${err.message}\n`);
  process.exit(1);
});
