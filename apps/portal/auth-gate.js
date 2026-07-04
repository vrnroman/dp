// The portal's own front door — Google sign-in, zero dependencies.
//
// The portal clones and runs code, so it must never be open. Today Caddy sits in front with a
// single shared basic_auth password. This gate replaces that with real Google sign-in, but ONLY
// when it is configured: set PORTAL_GOOGLE_CLIENT_ID + PORTAL_GOOGLE_CLIENT_SECRET (+ a stable
// PORTAL_AUTH_SECRET and PORTAL_BASE_URL) and the portal gates itself; leave them unset and this
// is a no-op, so the existing basic_auth front door keeps working unchanged (fail-safe).
//
// Open signup by default: anyone with a Google account can sign in. Set PORTAL_ALLOWED_EMAILS to
// a comma-separated list to restrict it. The verification is the real thing: the id_token's RS256
// signature is checked against Google's published keys, plus issuer / audience / expiry / nonce.
const http = require("node:http");
const { createHmac, createPublicKey, timingSafeEqual, verify: cryptoVerify, sign: cryptoSign, randomBytes, createHash } = require("node:crypto");
const { readFileSync, writeFileSync, appendFileSync, existsSync } = require("node:fs");

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const SESSION_COOKIE = "portal_session";
const OAUTH_COOKIE = "portal_oauth";

function b64url(s) { return Buffer.from(s).toString("base64url"); }
function unb64url(s) { return Buffer.from(s, "base64url").toString("utf8"); }
function ctEq(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function createGate() {
  const clientId = process.env.PORTAL_GOOGLE_CLIENT_ID || "";
  const clientSecret = process.env.PORTAL_GOOGLE_CLIENT_SECRET || "";
  const enabled = !!(clientId && clientSecret);
  // A stable secret keeps sessions valid across restarts. Fall back to a per-process random one
  // (sessions then reset on restart, which is safe, just less convenient).
  const secret = process.env.PORTAL_AUTH_SECRET || randomBytes(32).toString("hex");
  const base = (process.env.PORTAL_BASE_URL || "").replace(/\/+$/, "");
  const allow = (process.env.PORTAL_ALLOWED_EMAILS || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  // The portal is the deploy console: it clones and RUNS code on the owner's VM. So unlike the
  // apps it ships (open signup by default), it is fail-closed — with no allowlist it admits NOBODY
  // until the owner sets PORTAL_ALLOWED_EMAILS, unless they deliberately opt into open access with
  // PORTAL_OPEN=1. Turning on Google without configuring who-gets-in never means "anyone can".
  const openPortal = process.env.PORTAL_OPEN === "1";
  function isAllowed(email) {
    if (allow.length) return allow.includes(String(email).trim().toLowerCase());
    return openPortal;
  }
  // Endpoints, with test-only overrides so a mock OAuth server can stand in for Google.
  const authEp = process.env.PORTAL_GOOGLE_AUTH_OVERRIDE || GOOGLE_AUTH;
  const tokenEp = process.env.PORTAL_GOOGLE_TOKEN_OVERRIDE || GOOGLE_TOKEN;
  const jwksEp = process.env.PORTAL_GOOGLE_JWKS_OVERRIDE || GOOGLE_JWKS;

  function sign(value) {
    const body = b64url(JSON.stringify(value));
    return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
  }
  function unsign(token) {
    if (!token || token.indexOf(".") < 0) return null;
    const i = token.indexOf(".");
    const body = token.slice(0, i), sig = token.slice(i + 1);
    if (!ctEq(sig, createHmac("sha256", secret).update(body).digest("base64url"))) return null;
    try { return JSON.parse(unb64url(body)); } catch { return null; }
  }

  function cookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || "").split(";")) {
      const j = part.indexOf("=");
      if (j > 0) out[part.slice(0, j).trim()] = decodeURIComponent(part.slice(j + 1).trim());
    }
    return out;
  }
  function setCookie(res, name, value, maxAge) {
    const bits = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "Secure", "SameSite=Lax"];
    bits.push(`Max-Age=${maxAge}`);
    const prev = res.getHeader("Set-Cookie");
    const list = prev ? (Array.isArray(prev) ? prev.slice() : [prev]) : [];
    list.push(bits.join("; "));
    res.setHeader("Set-Cookie", list);
  }
  function clearCookie(res, name) { setCookie(res, name, "", 0); }

  function redirectUri(req) {
    const origin = base || `https://${req.headers.host}`;
    return `${origin}/auth/google/callback`;
  }

  // Verify a Google id_token end to end. Returns { email, name, sub } or null. Fail-closed.
  //
  // PARITY REQUIREMENT: this is the zero-dependency portal's own copy of the hardened verifier in
  // packages/auth/src/oauth.ts (`verifyRs256Jwt`). The portal ships as a standalone plain-JS
  // service (no build step, no @platform/auth import), so the logic is duplicated on purpose. Any
  // hardening to oauth.ts's RS256 verification (algorithm/kid/iss/aud/exp/iat/nonce checks) MUST be
  // mirrored here, since the relay verifies internet-facing Google tokens through this path.
  function verifyIdToken(idToken, jwks, nonce) {
    if (!idToken || typeof idToken !== "string") return null;
    const parts = idToken.split(".");
    if (parts.length !== 3) return null;
    let header, claims;
    try { header = JSON.parse(unb64url(parts[0])); claims = JSON.parse(unb64url(parts[1])); } catch { return null; }
    if (header.alg !== "RS256" || !header.kid) return null;
    const jwk = jwks.find((k) => k.kid === header.kid && (k.kty || "RSA") === "RSA");
    if (!jwk) return null;
    let ok = false;
    try {
      const key = createPublicKey({ key: jwk, format: "jwk" });
      ok = cryptoVerify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"));
    } catch { return null; }
    if (!ok) return null;
    if (!GOOGLE_ISSUERS.includes(String(claims.iss))) return null;
    const aud = claims.aud;
    if (!(Array.isArray(aud) ? aud.includes(clientId) : aud === clientId)) return null;
    const now = Math.floor(Date.now() / 1000);
    if (!(Number(claims.exp) + 120 >= now)) return null;
    // Reject a token minted in the future (kept in parity with the canonical oauth.ts verifier).
    const iat = Number(claims.iat);
    if (Number.isFinite(iat) && iat - 120 > now) return null;
    if (nonce !== undefined && !(typeof claims.nonce === "string" && ctEq(claims.nonce, nonce))) return null;
    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
    const verified = claims.email_verified === true || claims.email_verified === "true";
    if (!email || !verified) return null;
    return {
      email,
      name: typeof claims.name === "string" ? claims.name : "",
      sub: typeof claims.sub === "string" ? claims.sub : "",
    };
  }

  let jwksCache = null;
  async function fetchJwks(force) {
    const now = Date.now();
    if (!force && jwksCache && jwksCache.exp > now) return jwksCache.keys;
    const r = await fetch(jwksEp);
    if (!r.ok) throw new Error("jwks fetch failed");
    const j = await r.json();
    const keys = Array.isArray(j.keys) ? j.keys : [];
    // Never cache an empty set: a single bad 200 would otherwise lock out sign-in for the window.
    if (keys.length === 0) throw new Error("jwks empty");
    jwksCache = { keys, exp: now + 3600000 };
    return keys;
  }
  async function exchangeCode(code, redirect, verifier) {
    const body = new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: redirect, grant_type: "authorization_code", code_verifier: verifier,
    });
    const r = await fetch(tokenEp, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
    if (!r.ok) throw new Error("token exchange failed");
    const j = await r.json();
    if (!j.id_token) throw new Error("no id_token");
    return j.id_token;
  }
  // The single Google code->identity path shared by BOTH the portal's own login and the relay,
  // so their verification never drifts: exchange the code, verify the id_token, retry once with
  // fresh JWKS in case Google rotated keys. Returns { email, name, sub } or null.
  async function googleIdentityFromCode(code, req, verifier, nonce) {
    try {
      const idToken = await exchangeCode(code, redirectUri(req), verifier);
      let id = verifyIdToken(idToken, await fetchJwks(false), nonce);
      if (!id) id = verifyIdToken(idToken, await fetchJwks(true), nonce);
      return id;
    } catch { return null; }
  }

  /** Who is signed in, or null. */
  function user(req) {
    const s = unsign(cookies(req)[SESSION_COOKIE]);
    if (!s || typeof s.email !== "string") return null;
    if (typeof s.exp !== "number" || s.exp < Math.floor(Date.now() / 1000)) return null;
    return { email: s.email, name: s.name || "" };
  }

  function signInPage(reason) {
    const msg = reason ? `<p class="err">Could not sign you in. Please try again.</p>` : "";
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#faf6ef;color:#2b2620;font:17px/1.6 ui-rounded,system-ui,sans-serif}.card{background:#fffdf8;border:1px solid #ece3d2;border-radius:20px;padding:32px;max-width:360px;text-align:center;box-shadow:0 16px 44px -30px rgba(80,60,20,.5)}h1{font-size:24px;margin:0 0 6px}p{color:#8a8178;margin:0 0 20px}.err{color:#c0392b}a{display:inline-block;padding:13px 22px;border-radius:12px;background:#2b2620;color:#faf6ef;text-decoration:none;font-weight:600}</style>
<div class="card"><h1>Put it online</h1><p>Sign in to deploy your apps.</p>${msg}<a href="/auth/google">Continue with Google</a></div>`;
  }

  /**
   * Handle the auth routes and the gate. Returns true if it fully handled the request (the caller
   * should stop). Returns false to let the caller serve the request (the person is signed in, or
   * the gate is disabled).
   */
  async function handle(req, res, url) {
    if (!enabled) return false;
    const p = url.pathname;

    if (p === "/auth/google") {
      const state = randomBytes(16).toString("base64url");
      const nonce = randomBytes(16).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      setCookie(res, OAUTH_COOKIE, sign({ state, nonce, verifier, exp: Math.floor(Date.now() / 1000) + 600 }), 600);
      const q = new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri(req), response_type: "code",
        scope: "openid email profile", state, nonce,
        code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account",
      });
      res.writeHead(302, { location: `${authEp}?${q}` });
      res.end();
      return true;
    }

    if (p === "/auth/google/callback") {
      const fail = (reason) => { clearCookie(res, OAUTH_COOKIE); res.writeHead(302, { location: `/signin?reason=${reason}` }); res.end(); return true; };
      if (url.searchParams.get("error")) return fail("cancelled");
      const code = url.searchParams.get("code"), state = url.searchParams.get("state");
      const txn = unsign(cookies(req)[OAUTH_COOKIE]);
      clearCookie(res, OAUTH_COOKIE);
      if (!code || !state || !txn || txn.exp < Math.floor(Date.now() / 1000) || !ctEq(txn.state, state)) return fail("bad");
      const identity = await googleIdentityFromCode(code, req, txn.verifier, txn.nonce);
      if (!identity) return fail("verify");
      if (!isAllowed(identity.email)) return fail("not-allowed");
      setCookie(res, SESSION_COOKIE, sign({ email: identity.email, name: identity.name, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7 }), 60 * 60 * 24 * 7);
      res.writeHead(302, { location: "/" });
      res.end();
      return true;
    }

    if (p === "/signin") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(signInPage(url.searchParams.get("reason")));
      return true;
    }

    // Everything else requires a signed-in user who is STILL allowed. Re-checking the allowlist on
    // every request (not just at sign-in) means removing someone from PORTAL_ALLOWED_EMAILS cuts
    // their access on their next request, rather than letting a baked session run for days.
    const who = user(req);
    if (!who) {
      res.writeHead(302, { location: "/signin" });
      res.end();
      return true;
    }
    if (!isAllowed(who.email)) {
      clearCookie(res, SESSION_COOKIE);
      res.writeHead(302, { location: "/signin?reason=not-allowed" });
      res.end();
      return true;
    }
    return false; // signed in and allowed — let the caller serve the request
  }

  /* ------------------------------------------------------------------ */
  /* Relay: this portal acting as the shared auth relay for OTHER apps.  */
  /* It holds the Google client + the ONE registered redirect URI + its  */
  /* own signing key, so a deployed app signs people in through here and  */
  /* never needs its own Google-console step. It stores NO users/sessions */
  /* — it only relays the OAuth callback and mints a short-lived signed   */
  /* identity assertion the app verifies with the relay's public key.     */
  /* ------------------------------------------------------------------ */
  // The private key is multi-line PEM, so on the VM it comes from a file path; inline is for tests.
  const relayPrivPem =
    process.env.PORTAL_RELAY_PRIVATE_KEY ||
    (process.env.PORTAL_RELAY_PRIVATE_KEY_FILE && existsSync(process.env.PORTAL_RELAY_PRIVATE_KEY_FILE)
      ? readFileSync(process.env.PORTAL_RELAY_PRIVATE_KEY_FILE, "utf8")
      : "");
  const relayPubJwk = process.env.PORTAL_RELAY_PUBLIC_KEY || ""; // single-line JSON, served as-is
  const relayKid = process.env.PORTAL_RELAY_KID || "relay-1";
  const relayIssuer = process.env.PORTAL_RELAY_ISSUER || "dp-relay";
  const relayAdminSecret = process.env.PORTAL_RELAY_ADMIN_SECRET || "";
  const relayAllowFile = process.env.PORTAL_RELAY_ALLOW_FILE || "";
  // On only when the Google client, a signing key, and an allowlist file are all configured.
  const relayEnabled = enabled && !!relayPrivPem && !!relayAllowFile;
  const RELAY_COOKIE = "portal_relay";

  // Normalize to scheme://host (no path, no trailing slash). Only https, plus http://localhost
  // for local testing. "" on anything invalid (fail-closed).
  function normalizeOrigin(raw) {
    try {
      const u = new URL(String(raw || ""));
      const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
      if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocal)) return "";
      return u.origin;
    } catch { return ""; }
  }
  // Exact-match allowlist, re-read from disk each check (a freshly-registered app works with no
  // restart). Fail-closed: no file, unreadable, or origin absent -> not allowed.
  function relayAllowed(origin) {
    if (!origin || !relayAllowFile || !existsSync(relayAllowFile)) return false;
    try {
      return readFileSync(relayAllowFile, "utf8").split("\n").map((s) => s.trim()).filter(Boolean).includes(origin);
    } catch { return false; }
  }
  function relayRegister(origin) {
    const clean = normalizeOrigin(origin);
    if (!clean) return false;
    if (!relayAllowed(clean)) appendFileSync(relayAllowFile, clean + "\n");
    return true;
  }
  // Remove an origin so a torn-down app can no longer get assertions (guards against a later
  // owner of a freed subdomain minting valid identities).
  function relayDeregister(origin) {
    const clean = normalizeOrigin(origin);
    if (!clean || !relayAllowFile || !existsSync(relayAllowFile)) return false;
    try {
      const kept = readFileSync(relayAllowFile, "utf8").split("\n").map((s) => s.trim()).filter(Boolean).filter((o) => o !== clean);
      writeFileSync(relayAllowFile, kept.length ? kept.join("\n") + "\n" : "");
      return true;
    } catch { return false; }
  }
  function b64urlJson(o) { return Buffer.from(JSON.stringify(o)).toString("base64url"); }
  function signAssertion(claims) {
    const header = { alg: "RS256", kid: relayKid, typ: "JWT" };
    const input = `${b64urlJson(header)}.${b64urlJson(claims)}`;
    return `${input}.${cryptoSign("RSA-SHA256", Buffer.from(input), relayPrivPem).toString("base64url")}`;
  }
  function readJsonBody(req) {
    return new Promise((resolve) => {
      let b = ""; req.on("data", (d) => { b += d; if (b.length > 1e5) req.destroy(); });
      req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
      req.on("error", () => resolve({}));
    });
  }

  /**
   * Public relay endpoints (NOT behind the portal's own sign-in) plus the relay branch of the
   * shared /auth/google/callback. Returns true if it handled the request; false to fall through.
   */
  async function handleRelay(req, res, url) {
    if (!relayEnabled) return false;
    const p = url.pathname;
    const nowS = Math.floor(Date.now() / 1000);

    if (p === "/auth/relay/pubkey") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(relayPubJwk || "{}");
      return true;
    }

    if ((p === "/auth/relay/register" || p === "/auth/relay/deregister") && req.method === "POST") {
      const token = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
      if (!relayAdminSecret || !ctEq(token, relayAdminSecret)) { res.writeHead(401); res.end("no"); return true; }
      const body = await readJsonBody(req);
      const ok = p === "/auth/relay/register" ? relayRegister(body.origin) : relayDeregister(body.origin);
      res.writeHead(ok ? 200 : 400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok, origin: normalizeOrigin(body.origin) }));
      return true;
    }

    if (p === "/auth/relay/start") {
      const app = normalizeOrigin(url.searchParams.get("app"));
      const complete = url.searchParams.get("complete") || "";
      const appState = url.searchParams.get("state") || "";
      const appNonce = url.searchParams.get("nonce") || "";
      // Fail-closed: relay ONLY for an exact allowlisted origin, and only back to <origin>/auth/complete.
      if (!app || !relayAllowed(app)) { res.writeHead(403, { "content-type": "text/plain" }); res.end("This app is not registered for sign-in."); return true; }
      if (normalizeOrigin(complete) !== app || !/^https?:\/\/[^/]+\/auth\/complete$/.test(complete)) { res.writeHead(400); res.end("bad return"); return true; }
      const gstate = randomBytes(16).toString("base64url");
      const gnonce = randomBytes(16).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      setCookie(res, RELAY_COOKIE, sign({ gstate, gnonce, verifier, app, complete, appState, appNonce, exp: nowS + 600 }), 600);
      const q = new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri(req), response_type: "code",
        scope: "openid email profile", state: gstate, nonce: gnonce,
        code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account",
      });
      res.writeHead(302, { location: `${authEp}?${q}` });
      res.end();
      return true;
    }

    if (p === "/auth/google/callback") {
      const txn = unsign(cookies(req)[RELAY_COOKIE]);
      const state = url.searchParams.get("state");
      // Claim this callback ONLY if the returned state matches THIS relay flow's gstate. A stale
      // relay cookie (abandoned flow) must never hijack the portal's own login on the shared URL.
      if (!txn || !txn.app || !state || !ctEq(String(txn.gstate), state)) return false;
      clearCookie(res, RELAY_COOKIE);
      const backToApp = (reason) => {
        const dest = new URL(txn.complete);
        dest.searchParams.set("error", reason);
        dest.searchParams.set("state", txn.appState);
        res.writeHead(302, { location: dest.toString() });
        res.end();
        return true;
      };
      if (url.searchParams.get("error")) return backToApp("cancelled");
      const code = url.searchParams.get("code");
      if (!code || txn.exp < nowS) return backToApp("bad");
      const identity = await googleIdentityFromCode(code, req, txn.verifier, txn.gnonce);
      if (!identity) return backToApp("verify");
      const assertion = signAssertion({
        iss: relayIssuer, aud: txn.app, sub: identity.sub || "",
        email: identity.email, email_verified: true, name: identity.name || "",
        nonce: txn.appNonce, iat: nowS, exp: nowS + 120, jti: randomBytes(9).toString("hex"),
      });
      const dest = new URL(txn.complete);
      dest.searchParams.set("assertion", assertion);
      dest.searchParams.set("state", txn.appState);
      res.writeHead(302, { location: dest.toString() });
      res.end();
      return true;
    }

    return false;
  }

  return { enabled, handle, handleRelay, user, relayEnabled };
}

module.exports = { createGate };
