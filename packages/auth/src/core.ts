/**
 * @platform/auth core — pure, framework-free, fully testable.
 *
 * This is the standard identity surface every app codes against. The app asks
 * "who is signed in?" and "are they allowed?" and never learns whether the answer
 * came from Supabase, a cookie, or (later) Google IAP. That indirection is what lets
 * the same app deploy to the personal profile today and the org profile tomorrow with
 * no code change.
 *
 * Simple-auth (v1): a person enters their email. If the email is on the allowlist they
 * get a signed session cookie. The owner manages the allowlist. Email ownership is taken
 * on trust at entry in v1; magic-link verification is a planned hardening (see HARDENING).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type Role = "owner" | "member";

export interface User {
  email: string;
  /** account tier: the owner (who deployed the app) vs everyone else. Distinct from app roles,
   *  which are declared by the app and resolved live from group membership (see ./roles). */
  role: Role;
  /** verified identity fields, present when sign-in came from Google (the `proper` tier). */
  name?: string;
  /** Google's stable account id. */
  sub?: string;
  picture?: string;
  /** app roles baked in at sign-in in RELAY mode (resolved centrally by DP and carried in the
   *  relay assertion). Absent in direct-Google mode, where roles resolve live from the groups DB. */
  roles?: string[];
}

export interface SessionPayload {
  email: string;
  role: Role;
  name?: string;
  sub?: string;
  picture?: string;
  /** relay-mode app roles, resolved centrally and carried from the assertion. */
  roles?: string[];
  /** unix seconds */
  exp: number;
}

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function b64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}
function unb64url(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

/** Create a signed, tamper-evident session token for a user. */
export function signSession(
  user: User,
  secret: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
  nowSeconds?: number,
): string {
  if (!secret) throw new Error("A session secret is required to sign sessions.");
  const now = nowSeconds ?? Math.floor(currentMillis() / 1000);
  const payload: SessionPayload = { email: user.email, role: user.role, exp: now + ttlSeconds };
  if (user.name) payload.name = user.name;
  if (user.sub) payload.sub = user.sub;
  if (user.picture) payload.picture = user.picture;
  if (user.roles && user.roles.length) payload.roles = user.roles;
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/** Verify a session token. Returns the user, or null if missing, tampered, or expired. */
export function verifySession(
  token: string | undefined | null,
  secret: string,
  nowSeconds?: number,
): User | null {
  if (!token || !secret) return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  if (!constantTimeEqual(sig, expected)) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(unb64url(body));
  } catch {
    return null;
  }
  const now = nowSeconds ?? Math.floor(currentMillis() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now) return null;
  if (typeof payload.email !== "string") return null;
  const user: User = { email: payload.email, role: payload.role === "owner" ? "owner" : "member" };
  if (typeof payload.name === "string") user.name = payload.name;
  if (typeof payload.sub === "string") user.sub = payload.sub;
  if (typeof payload.picture === "string") user.picture = payload.picture;
  if (Array.isArray(payload.roles)) user.roles = payload.roles.filter((r): r is string => typeof r === "string");
  return user;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Isolated so tests can run without relying on wall-clock; callers pass nowSeconds.
function currentMillis(): number {
  return Date.now();
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/* ------------------------------------------------------------------ */
/* Allowlist store — the door. A pluggable interface so the same logic */
/* runs against an in-memory map (tests) or Postgres (real deploys).    */
/* ------------------------------------------------------------------ */

export interface AllowlistEntry {
  email: string;
  role: Role;
}

export interface AllowlistStore {
  /** Returns the entry if the email is allowed in, else null. */
  find(email: string): Promise<AllowlistEntry | null>;
  list(): Promise<AllowlistEntry[]>;
  add(email: string, role?: Role): Promise<AllowlistEntry>;
  remove(email: string): Promise<void>;
}

/** In-memory allowlist. Used by contract tests and as a safe default. */
export class MemoryAllowlist implements AllowlistStore {
  private rows = new Map<string, Role>();
  constructor(seed: AllowlistEntry[] = []) {
    for (const e of seed) this.rows.set(normalizeEmail(e.email), e.role);
  }
  async find(email: string): Promise<AllowlistEntry | null> {
    const key = normalizeEmail(email);
    const role = this.rows.get(key);
    return role ? { email: key, role } : null;
  }
  async list(): Promise<AllowlistEntry[]> {
    return [...this.rows.entries()].map(([email, role]) => ({ email, role }));
  }
  async add(email: string, role: Role = "member"): Promise<AllowlistEntry> {
    const key = normalizeEmail(email);
    this.rows.set(key, role);
    return { email: key, role };
  }
  async remove(email: string): Promise<void> {
    this.rows.delete(normalizeEmail(email));
  }
}

/**
 * The decision at the heart of simple-auth: given an email and the door (allowlist),
 * may this person in, and as what role? Returns null when they are not on the list.
 */
export async function authorize(email: string, store: AllowlistStore): Promise<User | null> {
  const clean = normalizeEmail(email);
  if (!isValidEmail(clean)) return null;
  const entry = await store.find(clean);
  if (!entry) return null;
  return { email: entry.email, role: entry.role };
}
