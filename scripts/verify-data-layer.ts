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

import { runMigrations, seedAllowlist, canConnect } from "../packages/cli/src/providers/postgres.ts";
import { PgAllowlist } from "@platform/auth/pg-store";
import { authorize } from "@platform/auth";
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

    await pool.end();

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
