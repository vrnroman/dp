/**
 * @platform/auth/next — the Next.js App Router binding.
 *
 * This is the only surface an app's server code touches for identity:
 *
 *   import { getUser, requireUser, requireRole, googleStart, googleCallback } from "@platform/auth/next";
 *
 * It wires the pure core (./core, ./oauth, ./roles) to real cookies (next/headers), a real
 * allowlist + groups store (Postgres), and the network calls Google sign-in needs (token
 * exchange, public-key fetch), reading everything it needs from platform-injected env vars.
 * The app never sees a connection string, a client secret, or a session secret.
 *
 * Two sign-in tiers share this file:
 *   - `simple` — the email allowlist (trust-on-entry). Kept for apps that still use it.
 *   - `proper` — real Google sign-in with a verified identity. The default going forward.
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
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
import {
  buildGoogleAuthUrl,
  signValue,
  verifyValue,
  verifyGoogleIdToken,
  verifyRelayAssertion,
  safeReturnTo,
  GOOGLE_AUTH_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_JWKS_URI,
  type Jwk,
  type GoogleIdentity,
} from "./oauth.ts";
import {
  resolveRoles,
  decideAccess,
  type RoleSpec,
  type SignupMode,
  type Group,
  type Person,
} from "./roles.ts";
import { PgGroupsStore, GROUPS_SCHEMA } from "./pg-groups.ts";
import { createHash, randomBytes } from "node:crypto";

const COOKIE = "platform_session";
const OAUTH_COOKIE = "platform_oauth";

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
function groups() {
  return new PgGroupsStore(getPool());
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

/** Owner-only guard for the management surface (who's in, groups). */
export async function requireOwner(): Promise<User> {
  const user = await requireUser();
  if (user.role !== "owner") throw new Error("Only the owner can manage who gets in.");
  return user;
}

/* ------------------------------------------------------------------ */
/* App roles — declared by the app, resolved LIVE from group membership */
/* ------------------------------------------------------------------ */

/** The roles this app declared (from the manifest, injected as PLATFORM_ROLES). */
export function declaredRoles(): RoleSpec[] {
  try {
    const raw = JSON.parse(process.env.PLATFORM_ROLES || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((r) => r && typeof r.name === "string")
      .map((r) => ({ name: String(r.name), can: typeof r.can === "string" ? r.can : "" }));
  } catch {
    return [];
  }
}
export function defaultRole(): string | null {
  const d = process.env.PLATFORM_DEFAULT_ROLE;
  return d && d.trim() ? d.trim() : null;
}
export function signupMode(): SignupMode {
  return process.env.PLATFORM_SIGNUP_MODE === "invite" ? "invite" : "open";
}

/**
 * The exact roles the current (or given) user holds, resolved live from their groups. Owner
 * holds every declared role; everyone else holds the default role plus their groups' roles,
 * fail-closed against the declared set. Returns [] for a signed-out user.
 */
export async function rolesForUser(user?: User | null): Promise<string[]> {
  const u = user ?? (await getUser());
  if (!u) return [];
  const declared = declaredRoles().map((r) => r.name);
  if (declared.length === 0) return [];
  let granted: string[] = [];
  if (u.role !== "owner") {
    try {
      granted = await groups().grantedRolesForEmail(u.email);
    } catch {
      granted = []; // fail-closed: if we cannot read grants, grant nothing beyond the default
    }
  }
  return resolveRoles({
    isOwner: u.role === "owner",
    defaultRole: defaultRole(),
    grantedRoles: granted,
    declaredRoles: declared,
  });
}

/** True if the current user holds `role`. */
export async function userHasRole(role: string): Promise<boolean> {
  return (await rolesForUser()).includes(role);
}

/** Throws unless the current user is signed in AND holds `role`. Use to gate protected actions. */
export async function requireRole(role: string): Promise<User> {
  const user = await requireUser();
  const roles = await rolesForUser(user);
  if (!roles.includes(role)) {
    throw new Error(`You do not have permission to do that.`);
  }
  return user;
}

/* ------------------------------------------------------------------ */
/* Google sign-in (the `proper` tier)                                   */
/* ------------------------------------------------------------------ */

interface OAuthTxn {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  exp: number;
}

function googleClient(): { id: string; secretKey: string } {
  const id = process.env.GOOGLE_CLIENT_ID || "";
  const secretKey = process.env.GOOGLE_CLIENT_SECRET || "";
  if (!id || !secretKey) {
    throw new Error("Google sign-in is not configured. The platform injects GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on deploy.");
  }
  return { id, secretKey };
}

/** The registered redirect URI. Must exactly match the one in the Google console. */
function redirectUri(req: Request): string {
  const base = (process.env.PLATFORM_BASE_URL || new URL(req.url).origin).replace(/\/+$/, "");
  return `${base}/auth/google/callback`;
}

// Endpoints, with test-only overrides so a mock OAuth server can stand in for Google.
function authEndpoint(): string {
  return process.env.GOOGLE_AUTH_ENDPOINT_OVERRIDE || GOOGLE_AUTH_ENDPOINT;
}
function tokenEndpoint(): string {
  return process.env.GOOGLE_TOKEN_ENDPOINT_OVERRIDE || GOOGLE_TOKEN_ENDPOINT;
}
function jwksUri(): string {
  return process.env.GOOGLE_JWKS_URI_OVERRIDE || GOOGLE_JWKS_URI;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/* ------------------------------------------------------------------ */
/* Relay mode — sign in through the platform's shared auth relay        */
/* instead of talking to Google directly, so a new app "just works"     */
/* with no Google-console step. The relay (on the platform's VM) holds   */
/* the Google client + the ONE registered redirect URI; the app only     */
/* holds the relay's PUBLIC key (not secret) to verify what it returns.  */
/* ------------------------------------------------------------------ */

function relayUrl(): string {
  return (process.env.PLATFORM_AUTH_RELAY_URL || "").replace(/\/+$/, "");
}
function relayPublicKey(): Jwk | null {
  try {
    const k = JSON.parse(process.env.PLATFORM_RELAY_PUBLIC_KEY || "");
    return k && typeof k === "object" ? (k as Jwk) : null;
  } catch {
    return null;
  }
}
function relayIssuer(): string {
  return process.env.PLATFORM_RELAY_ISSUER || "dp-relay";
}
/** Relay mode is on only when BOTH the relay URL and its public key are injected. */
function relayEnabled(): boolean {
  return !!relayUrl() && !!relayPublicKey();
}
/** This app's canonical origin: what the relay binds the assertion's `aud` to. */
function appOrigin(req: Request): string {
  return (process.env.PLATFORM_APP_ORIGIN || new URL(req.url).origin).replace(/\/+$/, "");
}

/** Relay-mode start: redirect to the relay (not Google) with this app's own state + nonce. */
async function relayStart(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  const state = randomBytes(16).toString("base64url");
  const nonce = randomBytes(16).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const origin = appOrigin(req);
  const q = new URLSearchParams({
    app: origin,
    complete: `${origin}/auth/complete`,
    state,
    nonce,
  });
  const res = NextResponse.redirect(`${relayUrl()}/auth/relay/start?${q.toString()}`, 302);
  // Only the app's own state + nonce + returnTo go in the cookie — no Google secrets here.
  res.cookies.set(OAUTH_COOKIE, signValue({ state, nonce, returnTo, exp: now + 600 }, secret()), {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: 600,
  });
  return res;
}

/**
 * Route handler for GET /auth/complete — the relay's hand-back. Verifies the relay's signed
 * identity assertion (RS256, relay public key, aud=this app, nonce), then establishes the
 * session with the same policy as direct Google.
 *
 *   // app/auth/complete/route.ts
 *   export { googleComplete as GET } from "@platform/auth/next";
 */
export async function googleComplete(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const back = (reason: string) => {
    const r = NextResponse.redirect(new URL(`/signin?reason=${reason}`, url.origin), 302);
    r.cookies.delete(OAUTH_COOKIE);
    return r;
  };
  // The relay hands back ?error=... (cancelled / bad / verify) when it could not mint an assertion.
  const relayError = url.searchParams.get("error");
  if (relayError) return back(relayError === "cancelled" ? "cancelled" : "verify-failed");
  const assertion = url.searchParams.get("assertion");
  const state = url.searchParams.get("state");
  if (!assertion || !state) return back("bad-callback");

  const jar = await cookies();
  const txn = verifyValue<{ state: string; nonce: string; returnTo: string; exp: number }>(
    jar.get(OAUTH_COOKIE)?.value,
    secret(),
  );
  if (!txn || txn.exp < Math.floor(Date.now() / 1000)) return back("expired");
  if (txn.state !== state) return back("bad-state"); // CSRF on the relay round trip

  const pub = relayPublicKey();
  if (!pub) return back("verify-failed");
  const result = verifyRelayAssertion(assertion, {
    publicKey: pub,
    issuer: relayIssuer(),
    audience: appOrigin(req),
    nonce: txn.nonce, // replay defense: the assertion must carry the nonce we started with
  });
  if (!result.ok) return back("verify-failed");

  return establishSession(result.identity, url.origin, safeReturnTo(txn.returnTo));
}

/**
 * Route handler for GET /auth/google — start sign-in. In relay mode it redirects to the platform
 * relay; otherwise it sets a short-lived signed transaction cookie and redirects to Google.
 *
 *   // app/auth/google/route.ts
 *   export { googleStart as GET } from "@platform/auth/next";
 */
export async function googleStart(req: Request): Promise<Response> {
  if (relayEnabled()) return relayStart(req);
  const client = googleClient();
  const url = new URL(req.url);
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  const state = randomBytes(16).toString("base64url");
  const nonce = randomBytes(16).toString("base64url");
  const { verifier, challenge } = pkce();
  const now = Math.floor(Date.now() / 1000);

  const txn: OAuthTxn = { state, nonce, verifier, returnTo, exp: now + 600 };

  const authUrl = buildGoogleAuthUrl({
    clientId: client.id,
    redirectUri: redirectUri(req),
    state,
    nonce,
    codeChallenge: challenge,
    endpoint: authEndpoint(),
  });
  // Set the transaction cookie ON the redirect response, so it reliably rides the 302 (a native
  // Response.redirect does not carry cookies staged via next/headers on every runtime).
  const res = NextResponse.redirect(authUrl, 302);
  res.cookies.set(OAUTH_COOKIE, signValue(txn, secret()), {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: 600,
  });
  return res;
}

/**
 * Route handler for GET /auth/google/callback — finish sign-in. Verifies the transaction
 * cookie, exchanges the code for tokens, verifies the id_token end to end, enforces the
 * signup mode, and sets the session cookie.
 *
 *   // app/auth/google/callback/route.ts
 *   export { googleCallback as GET } from "@platform/auth/next";
 */
export async function googleCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // Every failure clears the transaction cookie and sends the person to a plain sign-in message.
  const back = (reason: string) => {
    const r = NextResponse.redirect(new URL(`/signin?reason=${reason}`, url.origin), 302);
    r.cookies.delete(OAUTH_COOKIE);
    return r;
  };

  // The person may have declined at Google's screen.
  if (url.searchParams.get("error")) return back("cancelled");

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return back("bad-callback");

  const jar = await cookies();
  const txn = verifyValue<OAuthTxn>(jar.get(OAUTH_COOKIE)?.value, secret());
  if (!txn || txn.exp < Math.floor(Date.now() / 1000)) return back("expired");
  // CSRF: the state echoed by Google must match the one we stashed.
  if (txn.state !== state) return back("bad-state");

  let identity: GoogleIdentity;
  try {
    const idToken = await exchangeCodeForIdToken(code, redirectUri(req), txn.verifier);
    const verify = (jwks: Jwk[]) =>
      verifyGoogleIdToken(idToken, { clientId: googleClient().id, jwks, nonce: txn.nonce });
    let result = verify(await fetchJwks());
    // If verification failed, it may be because Google rotated its signing keys since we cached
    // them. Force one fresh fetch and retry before giving up, so a key rotation does not lock
    // everyone out for the cache window.
    if (!result.ok) result = verify(await fetchJwks(true));
    if (!result.ok) return back("verify-failed");
    identity = result.identity;
  } catch {
    return back("verify-failed");
  }

  return establishSession(identity, url.origin, safeReturnTo(txn.returnTo));
}

/**
 * The shared tail of every sign-in path (direct Google AND the relay): enforce how strangers get
 * in (decideAccess, fail-closed), record the person, and set the app's own session cookie. This
 * is the single place identity becomes a session, so both paths apply the exact same policy.
 */
async function establishSession(identity: GoogleIdentity, origin: string, returnTo: string): Promise<Response> {
  // The allowlist read is best-effort: a miss (e.g. the table does not exist in open mode) just
  // means "not specially marked", and decideAccess is fail-closed.
  let allowlistRole: "owner" | "member" | null = null;
  try {
    const entry: AllowlistEntry | null = await store().find(identity.email);
    allowlistRole = entry ? entry.role : null;
  } catch {
    allowlistRole = null;
  }
  const access = decideAccess({
    email: identity.email,
    ownerEmail: normalizeEmail(process.env.PLATFORM_OWNER_EMAIL || ""),
    signup: signupMode(),
    allowlistRole,
  });
  if (!access.allowed) {
    const denied = NextResponse.redirect(new URL(`/signin?reason=not-allowed`, origin), 302);
    denied.cookies.delete(OAUTH_COOKIE);
    return denied;
  }

  const user: User = {
    email: identity.email,
    role: access.isOwner ? "owner" : "member",
    name: identity.name,
    sub: identity.sub,
    picture: identity.picture,
  };

  // Record them in the people directory (the "just arrived" list). Best-effort.
  try {
    await groups().recordPerson({ email: identity.email, name: identity.name, picture: identity.picture, sub: identity.sub });
  } catch {
    /* never fail a valid sign-in because the directory write hiccuped */
  }

  const res = NextResponse.redirect(new URL(returnTo, origin), 302);
  res.cookies.delete(OAUTH_COOKIE);
  res.cookies.set(COOKIE, signSession(user, secret()), {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}

async function exchangeCodeForIdToken(code: string, redirect: string, verifier: string): Promise<string> {
  const client = googleClient();
  const body = new URLSearchParams({
    code,
    client_id: client.id,
    client_secret: client.secretKey,
    redirect_uri: redirect,
    grant_type: "authorization_code",
    code_verifier: verifier,
  });
  const res = await fetch(tokenEndpoint(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
  const json = (await res.json()) as { id_token?: string };
  if (!json.id_token) throw new Error("token response carried no id_token");
  return json.id_token;
}

let jwksCache: { keys: Jwk[]; exp: number } | null = null;
async function fetchJwks(force = false): Promise<Jwk[]> {
  const now = Date.now();
  if (!force && jwksCache && jwksCache.exp > now) return jwksCache.keys;
  const res = await fetch(jwksUri());
  if (!res.ok) throw new Error(`could not fetch signing keys (${res.status})`);
  const json = (await res.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(json.keys) ? json.keys : [];
  // Never cache an empty/invalid key set: a single bad 200 response would otherwise lock out
  // every sign-in for the full cache window with no way to recover. Throw so we retry next time.
  if (keys.length === 0) throw new Error("signing keys were empty");
  jwksCache = { keys, exp: now + 60 * 60 * 1000 };
  return keys;
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
}

/* ---- simple tier (email allowlist) — kept for apps that still use it ---- */

export type SignInResult =
  | { ok: true; user: User }
  | { ok: false; reason: "invalid-email" | "not-allowed" };

/**
 * The simple-tier front door. If the email is on the allowlist, sets the session cookie and
 * returns the user. Trust-on-entry; the `proper` (Google) tier verifies identity for real.
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

/* ------------------------------------------------------------------ */
/* Groups management (owner-facing — the platform's "who can do what")  */
/* Every mutation is owner-guarded. The app builder never writes this;  */
/* they just declare roles and the platform ships this surface.         */
/* ------------------------------------------------------------------ */

/** Ensure the groups/people tables exist. Idempotent. Called by deploy and as a safety net. */
export async function ensureGroupsTables(): Promise<void> {
  await getPool().query(GROUPS_SCHEMA);
}

export interface GroupView {
  id: string;
  name: string;
  members: string[];
  roles: string[];
  /** the plain-English "can" lines for this group's roles, for the owner's screen. */
  can: string[];
}

/** The full picture for the "who's in / groups" screen. Owner-only. */
export async function groupsOverview(): Promise<{ groups: GroupView[]; specs: RoleSpec[]; defaultRole: string | null }> {
  await requireOwner();
  const g = groups();
  const list = await g.listGroups();
  const specs = declaredRoles();
  const canFor = (role: string) => specs.find((s) => s.name === role)?.can || "";
  const views: GroupView[] = [];
  for (const grp of list) {
    const [members, roles] = await Promise.all([g.membersOf(grp.id), g.rolesForGroup(grp.id)]);
    views.push({ id: grp.id, name: grp.name, members, roles, can: roles.map(canFor).filter(Boolean) });
  }
  return { groups: views, specs, defaultRole: defaultRole() };
}

/** Everyone who has ever signed in (the "just arrived" list). Owner-only. */
export async function listPeople(): Promise<Person[]> {
  await requireOwner();
  return groups().listPeople();
}

export async function createGroup(name: string): Promise<Group> {
  await requireOwner();
  return groups().createGroup(name);
}
export async function renameGroup(id: string, name: string): Promise<void> {
  await requireOwner();
  await groups().renameGroup(id, name);
}
export async function deleteGroup(id: string): Promise<void> {
  await requireOwner();
  await groups().deleteGroup(id);
}
export async function addPersonToGroup(groupId: string, email: string): Promise<void> {
  await requireOwner();
  await groups().addToGroup(groupId, email);
}
export async function removePersonFromGroup(groupId: string, email: string): Promise<void> {
  await requireOwner();
  await groups().removeFromGroup(groupId, email);
}

/** Set which roles a group grants. Fail-closed: only roles the app declared are accepted. */
export async function setGroupRoles(groupId: string, roles: string[]): Promise<void> {
  await requireOwner();
  const declared = new Set(declaredRoles().map((r) => r.name));
  const clean = roles.filter((r) => declared.has(r));
  await groups().setGroupRoles(groupId, clean);
}
