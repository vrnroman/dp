/**
 * @platform/auth/next — the Next.js App Router binding.
 *
 * This is the only surface an app's server code touches for identity:
 *
 *   import { getUser, requireUser, signInWithEmail, signOut } from "@platform/auth/next";
 *
 * It wires the pure core to real cookies (next/headers) and a real allowlist (Postgres),
 * reading everything it needs from platform-injected env vars. The app never sees a
 * connection string or a session secret.
 */
import { cookies } from "next/headers";
import { Pool } from "pg";
import {
  authorize,
  signSession,
  verifySession,
  normalizeEmail,
  isValidEmail,
  type AllowlistEntry,
  type Role,
  type User,
} from "./core.ts";
import { PgAllowlist, ALLOWLIST_SCHEMA } from "./pg-store.ts";

const COOKIE = "platform_session";

let pool: Pool | null = null;
function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set. The platform injects this on deploy.");
    pool = new Pool({ connectionString: url, max: 3, ssl: sslFor(url) });
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

function store() {
  return new PgAllowlist(getPool());
}

function secret(): string {
  const s = process.env.PLATFORM_AUTH_SECRET;
  if (!s) throw new Error("PLATFORM_AUTH_SECRET is not set. The platform injects this on deploy.");
  return s;
}

/** Who is signed in, or null. Safe to call in any server component or route. */
export async function getUser(): Promise<User | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  return verifySession(token, secret());
}

/** Like getUser, but throws when nobody is signed in. Use in protected actions. */
export async function requireUser(): Promise<User> {
  const user = await getUser();
  if (!user) throw new Error("You need to sign in to do that.");
  return user;
}

/** Owner-only guard for the allowlist management surface. */
export async function requireOwner(): Promise<User> {
  const user = await requireUser();
  if (user.role !== "owner") throw new Error("Only the owner can manage who gets in.");
  return user;
}

export type SignInResult =
  | { ok: true; user: User }
  | { ok: false; reason: "invalid-email" | "not-allowed" };

/**
 * The front door. If the email is on the allowlist, sets the session cookie and returns
 * the user. If not, returns a clear reason the app can show in plain English.
 */
export async function signInWithEmail(rawEmail: string): Promise<SignInResult> {
  const email = normalizeEmail(rawEmail);
  if (!isValidEmail(email)) return { ok: false, reason: "invalid-email" };
  const user = await authorize(email, store());
  if (!user) return { ok: false, reason: "not-allowed" };
  const jar = await cookies();
  jar.set(COOKIE, signSession(user, secret()), {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return { ok: true, user };
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
}

/* ---- allowlist management (owner-facing "let my mom in" surface) ---- */

export async function getAllowlist(): Promise<AllowlistEntry[]> {
  return store().list();
}

export async function inviteToAllowlist(email: string, role: Role = "member"): Promise<AllowlistEntry> {
  await requireOwner();
  return store().add(email, role);
}

export async function removeFromAllowlist(email: string): Promise<void> {
  await requireOwner();
  await store().remove(email);
}

/** Ensure the allowlist table exists. Idempotent. Called by deploy and as a safety net. */
export async function ensureAllowlistTable(): Promise<void> {
  await getPool().query(ALLOWLIST_SCHEMA);
}
