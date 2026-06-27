/**
 * Postgres-backed allowlist store. Lives in its own file so the pure core (and its
 * tests) never have to load the `pg` driver. The platform creates this table during
 * deploy and seeds it from the manifest's auth.allowlist.
 */
import type { AllowlistEntry, AllowlistStore, Role } from "./core.ts";
import { normalizeEmail } from "./core.ts";

export const ALLOWLIST_TABLE = "platform_allowlist";

export const ALLOWLIST_SCHEMA = `
create table if not exists ${ALLOWLIST_TABLE} (
  email    text primary key,
  role     text not null default 'member',
  added_at timestamptz not null default now()
);
`;

// Minimal shape of a node-postgres pool so we don't hard-depend on @types/pg here.
interface PgPool {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export class PgAllowlist implements AllowlistStore {
  constructor(private pool: PgPool) {}

  async find(email: string): Promise<AllowlistEntry | null> {
    const key = normalizeEmail(email);
    const { rows } = await this.pool.query(
      `select email, role from ${ALLOWLIST_TABLE} where email = $1`,
      [key],
    );
    if (rows.length === 0) return null;
    return { email: rows[0].email as string, role: rows[0].role as Role };
  }

  async list(): Promise<AllowlistEntry[]> {
    const { rows } = await this.pool.query(
      `select email, role from ${ALLOWLIST_TABLE} order by added_at asc`,
    );
    return rows.map((r) => ({ email: r.email as string, role: r.role as Role }));
  }

  async add(email: string, role: Role = "member"): Promise<AllowlistEntry> {
    const key = normalizeEmail(email);
    await this.pool.query(
      `insert into ${ALLOWLIST_TABLE} (email, role) values ($1, $2)
       on conflict (email) do update set role = excluded.role`,
      [key, role],
    );
    return { email: key, role };
  }

  async remove(email: string): Promise<void> {
    await this.pool.query(`delete from ${ALLOWLIST_TABLE} where email = $1`, [normalizeEmail(email)]);
  }
}
