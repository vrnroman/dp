/**
 * @platform/auth/oauth — the pure, framework-free core of Google sign-in.
 *
 * This holds everything about the OAuth 2.0 authorization-code flow that can be decided
 * without touching the network: building the URL we send a person to, signing the little
 * transaction cookie that ties the redirect back to the person who started it (CSRF/replay
 * defense), and — the part that actually matters for trust — verifying the identity token
 * Google hands back is really from Google and really for this app.
 *
 * The network parts (exchanging the code for tokens, fetching Google's public keys) live in
 * the Next.js binding, because they need `fetch`. Everything here is a pure function you can
 * unit-test with a locally generated keypair, so the security-critical logic is exercised
 * without a live Google.
 */
import { createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify } from "node:crypto";

/** Google's OpenID discovery endpoints. Constants so tests and callers agree. */
export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";
/** Google signs id_tokens under one of these two issuer spellings. Both are valid. */
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

function b64url(input: string | Buffer): string {
  return Buffer.from(input as never).toString("base64url");
}
function unb64urlStr(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/* ------------------------------------------------------------------ */
/* Signed values — the OAuth transaction cookie.                       */
/* A small, tamper-evident, HMAC-signed JSON blob. We use it to carry   */
/* the state + nonce + PKCE verifier from the start of sign-in to the   */
/* callback, with no server-side session store.                         */
/* ------------------------------------------------------------------ */

/** Sign an arbitrary JSON-serializable value into a `body.sig` token. */
export function signValue(value: unknown, secret: string): string {
  if (!secret) throw new Error("A secret is required to sign values.");
  const body = b64url(JSON.stringify(value));
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/** Verify and parse a `body.sig` token. Returns the value, or null if tampered/malformed. */
export function verifyValue<T = unknown>(token: string | undefined | null, secret: string): T | null {
  if (!token || !secret) return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  if (!constantTimeEqual(sig, expected)) return null;
  try {
    return JSON.parse(unb64urlStr(body)) as T;
  } catch {
    return null;
  }
}

/**
 * Sanitize a post-login "return to" target to a SAME-ORIGIN path, fail-closed.
 *
 * A login callback that honors an attacker-supplied redirect is an open redirect (CWE-601): the
 * victim signs in with real Google and is bounced to the attacker's site. A leading-`//` check is
 * not enough, because WHATWG `new URL()` treats a backslash as a slash, so `/\evil.com` resolves
 * cross-origin. So we reject backslashes and control characters up front, then resolve against a
 * fixed origin and accept the value ONLY if it stayed on that origin — returning just the path.
 */
export function safeReturnTo(raw: string | null | undefined): string {
  const v = String(raw ?? "");
  if (!v.startsWith("/") || v.startsWith("//")) return "/";
  // Backslashes and control chars (incl. tab/newline, 0x00-0x1f and 0x7f) can smuggle a
  // cross-origin authority past a naive check because URL parsers normalize or strip them.
  if (/[\\\x00-\x1f\x7f]/.test(v)) return "/";
  try {
    const u = new URL(v, "https://dp.invalid");
    if (u.origin !== "https://dp.invalid") return "/";
    return u.pathname + u.search + u.hash;
  } catch {
    return "/";
  }
}

/* ------------------------------------------------------------------ */
/* Step 1 — build the URL we send the person to.                       */
/* ------------------------------------------------------------------ */

export interface AuthUrlParams {
  clientId: string;
  redirectUri: string;
  /** CSRF token; echoed back on the callback and matched against the cookie. */
  state: string;
  /** binds the resulting id_token to this sign-in attempt (replay defense). */
  nonce: string;
  /** PKCE code challenge (S256 of the verifier). */
  codeChallenge?: string;
  /** defaults to "openid email profile" — enough to know who they are. */
  scope?: string;
  /** endpoint override, for tests. */
  endpoint?: string;
}

/** Build the Google consent URL. Pure: no network, deterministic given its inputs. */
export function buildGoogleAuthUrl(p: AuthUrlParams): string {
  if (!p.clientId) throw new Error("clientId is required to build the sign-in URL.");
  if (!p.redirectUri) throw new Error("redirectUri is required to build the sign-in URL.");
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: p.scope ?? "openid email profile",
    state: p.state,
    nonce: p.nonce,
    // Ask for a fresh consent-free login when possible, but let Google decide.
    access_type: "online",
    prompt: "select_account",
  });
  if (p.codeChallenge) {
    q.set("code_challenge", p.codeChallenge);
    q.set("code_challenge_method", "S256");
  }
  return `${p.endpoint ?? GOOGLE_AUTH_ENDPOINT}?${q.toString()}`;
}

/* ------------------------------------------------------------------ */
/* Step 3 — verify the id_token Google returned.                        */
/* This is the trust boundary. Everything above is plumbing; this is    */
/* what decides whether we believe an identity claim.                   */
/* ------------------------------------------------------------------ */

/** A JSON Web Key, as published in Google's JWKS. */
export interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  n?: string;
  e?: string;
  use?: string;
  [k: string]: unknown;
}

export interface GoogleIdentity {
  /** Google's stable, unique user id (the primary key of "who this is"). */
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
}

export type IdTokenResult =
  | { ok: true; identity: GoogleIdentity }
  | { ok: false; reason: string };

export interface VerifyIdTokenOptions {
  /** the app's OAuth client id — the id_token's `aud` must equal this. */
  clientId: string;
  /** Google's current signing keys (fetched by the caller, passed in so this stays pure). */
  jwks: Jwk[];
  /** the nonce we sent at sign-in start; the id_token's `nonce` must match. */
  nonce?: string;
  /** unix seconds; defaults to now. Injected so tests do not depend on the wall clock. */
  nowSeconds?: number;
  /** small tolerance for clock skew, in seconds. Default 120. */
  clockToleranceSeconds?: number;
}

/**
 * Verify a Google id_token end to end: real RS256 signature against Google's published key,
 * then the standard claims (issuer, audience, expiry, nonce, verified email). Returns the
 * identity only if EVERY check passes. Fail-closed: any doubt returns { ok: false }.
 */
export function verifyGoogleIdToken(idToken: string, opts: VerifyIdTokenOptions): IdTokenResult {
  if (!idToken || typeof idToken !== "string") return { ok: false, reason: "no id token" };
  const parts = idToken.split(".");
  if (parts.length !== 3) return { ok: false, reason: "id token is not a JWT" };
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(unb64urlStr(headerB64));
    claims = JSON.parse(unb64urlStr(payloadB64));
  } catch {
    return { ok: false, reason: "id token is not readable" };
  }

  // Only RS256, only Google's asymmetric keys. Refuse "alg: none" and HMAC downgrade attacks.
  if (header.alg !== "RS256") return { ok: false, reason: `unexpected token algorithm ${header.alg}` };
  if (!header.kid) return { ok: false, reason: "id token has no key id" };

  const jwk = opts.jwks.find((k) => k.kid === header.kid && (k.kty ?? "RSA") === "RSA");
  if (!jwk) return { ok: false, reason: "id token was signed by an unknown key" };

  // Verify the signature over the exact signing input Google signed.
  let signatureValid = false;
  try {
    const key = createPublicKey({ key: jwk as never, format: "jwk" });
    signatureValid = cryptoVerify(
      "RSA-SHA256",
      Buffer.from(`${headerB64}.${payloadB64}`),
      key,
      Buffer.from(sigB64, "base64url"),
    );
  } catch {
    return { ok: false, reason: "id token signature could not be checked" };
  }
  if (!signatureValid) return { ok: false, reason: "id token signature did not match" };

  // Standard claim checks. Any failure is fail-closed.
  const iss = String(claims.iss ?? "");
  if (!GOOGLE_ISSUERS.includes(iss)) return { ok: false, reason: "id token was not issued by Google" };

  // aud may be a string or (rarely) an array; the client id must be present.
  const aud = claims.aud;
  const audOk = Array.isArray(aud) ? aud.includes(opts.clientId) : aud === opts.clientId;
  if (!audOk) return { ok: false, reason: "id token was issued for a different app" };

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tol = opts.clockToleranceSeconds ?? 120;
  const exp = Number(claims.exp);
  if (!Number.isFinite(exp) || exp + tol < now) return { ok: false, reason: "id token has expired" };
  const iat = Number(claims.iat);
  if (Number.isFinite(iat) && iat - tol > now) return { ok: false, reason: "id token is from the future" };

  if (opts.nonce !== undefined) {
    if (typeof claims.nonce !== "string" || !constantTimeEqual(claims.nonce, opts.nonce)) {
      return { ok: false, reason: "id token nonce did not match this sign-in" };
    }
  }

  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (!email) return { ok: false, reason: "id token carries no email" };
  // Google sends email_verified as a boolean or the string "true".
  const emailVerified = claims.email_verified === true || claims.email_verified === "true";
  if (!emailVerified) return { ok: false, reason: "this Google account's email is not verified" };

  const sub = typeof claims.sub === "string" ? claims.sub : "";
  if (!sub) return { ok: false, reason: "id token carries no account id" };

  return {
    ok: true,
    identity: {
      sub,
      email,
      emailVerified,
      name: typeof claims.name === "string" ? claims.name : undefined,
      picture: typeof claims.picture === "string" ? claims.picture : undefined,
    },
  };
}
