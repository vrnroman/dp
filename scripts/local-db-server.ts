/**
 * Long-running real-Postgres harness for the live app smoke test. Starts PGlite over the
 * wire protocol, runs the app's migrations, seeds the allowlist, then stays alive so a
 * real `next start` process can talk to it. Kill it to stop.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { runMigrations, seedAllowlist } from "../packages/cli/src/providers/postgres.ts";

const root = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PG_PORT ?? 5599);
const URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;

async function main() {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1" });
  await server.start();

  const migrations = join(root, "..", "apps", "reference-web", "migrations");
  await runMigrations(URL, migrations);
  await seedAllowlist(URL, "owner@test.dev", ["friend@test.dev"]);

  process.stdout.write(`DB READY on ${PORT}\n`);

  process.on("SIGTERM", async () => {
    await server.stop();
    await db.close();
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`DB harness failed: ${err.message}\n`);
  process.exit(1);
});
