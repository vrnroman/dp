/**
 * Postgres-backed groups store. Lives in its own file so the pure core (and its tests) never
 * load the `pg` driver. The platform creates these tables during deploy. Ids are app-generated
 * text (not a serial) so the store logic is identical against Postgres and the in-memory store,
 * and portable across the PGlite test harness and Supabase.
 */
import type { Group, GroupsStore, Person } from "./roles.ts";
import { randomBytes } from "node:crypto";

export const GROUPS_TABLE = "platform_groups";
export const GROUP_MEMBERS_TABLE = "platform_group_members";
export const GROUP_ROLES_TABLE = "platform_group_roles";
export const PEOPLE_TABLE = "platform_people";

/** All the tables the groups/people machinery needs. Idempotent; safe to re-run each deploy. */
export const GROUPS_SCHEMA = `
create table if not exists ${GROUPS_TABLE} (
  id         text primary key,
  name       text not null unique,
  created_at timestamptz not null default now()
);
create table if not exists ${GROUP_MEMBERS_TABLE} (
  group_id text not null references ${GROUPS_TABLE}(id) on delete cascade,
  email    text not null,
  added_at timestamptz not null default now(),
  primary key (group_id, email)
);
create table if not exists ${GROUP_ROLES_TABLE} (
  group_id text not null references ${GROUPS_TABLE}(id) on delete cascade,
  role     text not null,
  primary key (group_id, role)
);
create table if not exists ${PEOPLE_TABLE} (
  email      text primary key,
  name       text,
  picture    text,
  sub        text,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);
`;

interface PgClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(): void;
}
interface PgPool {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  /** present on a real node-postgres Pool; used to run a real transaction. */
  connect?(): Promise<PgClient>;
}

function normalize(email: string): string {
  return String(email ?? "").trim().toLowerCase();
}
function newId(): string {
  return "g" + randomBytes(9).toString("hex");
}

export class PgGroupsStore implements GroupsStore {
  constructor(private pool: PgPool) {}

  async listGroups(): Promise<Group[]> {
    const { rows } = await this.pool.query(`select id, name from ${GROUPS_TABLE} order by name asc`);
    return rows.map((r) => ({ id: r.id as string, name: r.name as string }));
  }
  async createGroup(name: string): Promise<Group> {
    const clean = String(name ?? "").trim();
    if (!clean) throw new Error("A group needs a name.");
    // Idempotent on name: return the existing group rather than erroring on the unique index.
    const { rows } = await this.pool.query(
      `insert into ${GROUPS_TABLE} (id, name) values ($1, $2)
       on conflict (name) do update set name = excluded.name
       returning id, name`,
      [newId(), clean],
    );
    return { id: rows[0].id as string, name: rows[0].name as string };
  }
  async renameGroup(id: string, name: string): Promise<void> {
    const clean = String(name ?? "").trim();
    if (!clean) return;
    await this.pool.query(`update ${GROUPS_TABLE} set name = $2 where id = $1`, [id, clean]);
  }
  async deleteGroup(id: string): Promise<void> {
    await this.pool.query(`delete from ${GROUPS_TABLE} where id = $1`, [id]);
  }
  async addToGroup(groupId: string, email: string): Promise<void> {
    await this.pool.query(
      `insert into ${GROUP_MEMBERS_TABLE} (group_id, email) values ($1, $2) on conflict do nothing`,
      [groupId, normalize(email)],
    );
  }
  async removeFromGroup(groupId: string, email: string): Promise<void> {
    await this.pool.query(
      `delete from ${GROUP_MEMBERS_TABLE} where group_id = $1 and email = $2`,
      [groupId, normalize(email)],
    );
  }
  async membersOf(groupId: string): Promise<string[]> {
    const { rows } = await this.pool.query(
      `select email from ${GROUP_MEMBERS_TABLE} where group_id = $1 order by email asc`,
      [groupId],
    );
    return rows.map((r) => r.email as string);
  }
  async groupsForEmail(email: string): Promise<Group[]> {
    const { rows } = await this.pool.query(
      `select g.id, g.name from ${GROUPS_TABLE} g
       join ${GROUP_MEMBERS_TABLE} m on m.group_id = g.id
       where m.email = $1 order by g.name asc`,
      [normalize(email)],
    );
    return rows.map((r) => ({ id: r.id as string, name: r.name as string }));
  }
  async rolesForGroup(groupId: string): Promise<string[]> {
    const { rows } = await this.pool.query(
      `select role from ${GROUP_ROLES_TABLE} where group_id = $1 order by role asc`,
      [groupId],
    );
    return rows.map((r) => r.role as string);
  }
  async setGroupRoles(groupId: string, roles: string[]): Promise<void> {
    const clean = [...new Set(roles.map((r) => String(r).trim()).filter(Boolean))];
    // Replace the group's roles atomically: a crash between the delete and the inserts must never
    // leave a group with a partial (or empty) role set, silently stripping access. Use one real
    // transaction on a dedicated connection; the multi-row insert also drops the per-role trips.
    if (typeof this.pool.connect === "function") {
      const client = await this.pool.connect();
      try {
        await client.query("begin");
        await client.query(`delete from ${GROUP_ROLES_TABLE} where group_id = $1`, [groupId]);
        if (clean.length) {
          const values = clean.map((_, i) => `($1, $${i + 2})`).join(", ");
          await client.query(
            `insert into ${GROUP_ROLES_TABLE} (group_id, role) values ${values} on conflict do nothing`,
            [groupId, ...clean],
          );
        }
        await client.query("commit");
      } catch (err) {
        await client.query("rollback").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      return;
    }
    // Fallback for a bare pool with no connect(): still correct, just not crash-atomic.
    await this.pool.query(`delete from ${GROUP_ROLES_TABLE} where group_id = $1`, [groupId]);
    for (const role of clean) {
      await this.pool.query(
        `insert into ${GROUP_ROLES_TABLE} (group_id, role) values ($1, $2) on conflict do nothing`,
        [groupId, role],
      );
    }
  }
  async grantedRolesForEmail(email: string): Promise<string[]> {
    const { rows } = await this.pool.query(
      `select distinct r.role from ${GROUP_ROLES_TABLE} r
       join ${GROUP_MEMBERS_TABLE} m on m.group_id = r.group_id
       where m.email = $1 order by r.role asc`,
      [normalize(email)],
    );
    return rows.map((r) => r.role as string);
  }
  async recordPerson(p: Person): Promise<void> {
    await this.pool.query(
      `insert into ${PEOPLE_TABLE} (email, name, picture, sub) values ($1, $2, $3, $4)
       on conflict (email) do update set
         name = coalesce(excluded.name, ${PEOPLE_TABLE}.name),
         picture = coalesce(excluded.picture, ${PEOPLE_TABLE}.picture),
         sub = coalesce(excluded.sub, ${PEOPLE_TABLE}.sub),
         last_seen = now()`,
      [normalize(p.email), p.name ?? null, p.picture ?? null, p.sub ?? null],
    );
  }
  async listPeople(): Promise<Person[]> {
    const { rows } = await this.pool.query(
      `select email, name, picture, sub, first_seen, last_seen from ${PEOPLE_TABLE} order by first_seen desc`,
    );
    return rows.map((r) => ({
      email: r.email as string,
      name: (r.name as string) ?? null,
      picture: (r.picture as string) ?? null,
      sub: (r.sub as string) ?? null,
      firstSeen: r.first_seen ? String(r.first_seen) : undefined,
      lastSeen: r.last_seen ? String(r.last_seen) : undefined,
    }));
  }
}
