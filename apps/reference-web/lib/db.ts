/**
 * The app reads DATABASE_URL from the environment and never hardcodes a connection.
 * That single rule is what lets the platform point this app at Supabase today and a
 * different Postgres tomorrow, with no code change.
 */
import { Pool } from "pg";

let pool: Pool | null = null;

export function db(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set. The platform injects this when it deploys the app.");
    }
    pool = new Pool({ connectionString, max: 3, ssl: sslFor(connectionString) });
  }
  return pool;
}

// Supabase requires TLS; local Postgres does not. node-postgres needs to be told.
function sslFor(url: string): false | { rejectUnauthorized: boolean } {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* leave empty */
  }
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "";
  return local ? false : { rejectUnauthorized: false };
}

export interface Note {
  id: string;
  author_email: string;
  body: string;
  photo_url: string | null;
  created_at: string;
}

export async function listNotes(limit = 100): Promise<Note[]> {
  const { rows } = await db().query(
    "select id, author_email, body, photo_url, created_at from notes order by created_at desc limit $1",
    [limit],
  );
  return rows as Note[];
}

export async function addNote(authorEmail: string, body: string, photoUrl: string | null): Promise<void> {
  await db().query("insert into notes (author_email, body, photo_url) values ($1, $2, $3)", [
    authorEmail,
    body,
    photoUrl,
  ]);
}
