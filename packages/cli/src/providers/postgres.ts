/**
 * Database setup steps that run against the live Postgres: apply the app's migrations and
 * seed the auth allowlist. Migrations are tracked in a small table so re-deploys only run
 * what is new.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { ALLOWLIST_SCHEMA, ALLOWLIST_TABLE } from "@platform/auth/pg-store";

const TRACK = "platform_migrations";

/**
 * Supabase requires TLS, and node-postgres does not negotiate it on its own (unlike psql).
 * So we turn SSL on for any non-local host. Local Postgres (the PGlite test harness) needs
 * no SSL. The pooler presents a publicly valid certificate, but we do not pin it.
 */
function pgSsl(url: string): false | { rejectUnauthorized: boolean } {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* leave empty */
  }
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "";
  return local ? false : { rejectUnauthorized: false };
}

function clientFor(url: string, extra: Record<string, unknown> = {}): pg.Client {
  return new pg.Client({ connectionString: url, ssl: pgSsl(url), ...extra });
}

export interface MigrationReport {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(connUrl: string, migrationsDir: string): Promise<MigrationReport> {
  const client = clientFor(connUrl);
  await client.connect();
  const report: MigrationReport = { applied: [], skipped: [] };
  try {
    await client.query(
      `create table if not exists ${TRACK} (name text primary key, applied_at timestamptz not null default now())`,
    );
    const files = listSqlFiles(migrationsDir);
    const done = new Set(
      (await client.query(`select name from ${TRACK}`)).rows.map((r) => r.name as string),
    );
    for (const file of files) {
      if (done.has(file)) {
        report.skipped.push(file);
        continue;
      }
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(`insert into ${TRACK} (name) values ($1)`, [file]);
        await client.query("commit");
        report.applied.push(file);
      } catch (err) {
        await client.query("rollback");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    return report;
  } finally {
    await client.end();
  }
}

function listSqlFiles(dir: string): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((f) => f.endsWith(".sql")).sort();
}

export async function seedAllowlist(
  connUrl: string,
  ownerEmail: string,
  members: string[],
): Promise<void> {
  const client = clientFor(connUrl);
  await client.connect();
  try {
    await client.query(ALLOWLIST_SCHEMA);
    await client.query(
      `insert into ${ALLOWLIST_TABLE} (email, role) values ($1, 'owner')
       on conflict (email) do update set role = 'owner'`,
      [ownerEmail.toLowerCase()],
    );
    for (const m of members) {
      const email = m.trim().toLowerCase();
      if (!email || email === ownerEmail.toLowerCase()) continue;
      await client.query(
        `insert into ${ALLOWLIST_TABLE} (email, role) values ($1, 'member')
         on conflict (email) do nothing`,
        [email],
      );
    }
  } finally {
    await client.end();
  }
}

/** Quick connectivity probe so we fail with a clear message if the DB is unreachable. */
export async function canConnect(connUrl: string): Promise<boolean> {
  const client = clientFor(connUrl, { connectionTimeoutMillis: 8000 });
  try {
    await client.connect();
    await client.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
  }
}
