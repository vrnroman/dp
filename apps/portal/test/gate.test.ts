// End-to-end test of the portal's Google front door (auth-gate.js), driven through a MOCK
// Google so the real authorization-code flow — redirect, state/nonce, code exchange, id_token
// verification, session issue, and the gate on protected routes — is exercised without a live
// Google or a browser.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createGate } = require("../auth-gate.js");

const CLIENT_ID = "portal-client.apps.googleusercontent.com";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "portal-kid";
const JWK = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: KID, alg: "RS256", use: "sig" };

function b64url(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}
function makeIdToken(nonce: string, over: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", kid: KID, typ: "JWT" };
  const claims = {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "portal-user-1",
    email: "deployer@example.com",
    email_verified: true,
    name: "Dee Ployer",
    iat: now,
    exp: now + 3600,
    nonce,
    ...over,
  };
  const input = `${b64url(header)}.${b64url(claims)}`;
  const sig = cryptoSign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
  return `${input}.${sig}`;
}

// The mock Google. /token returns an id_token carrying the nonce the test last armed; /certs
// returns the JWKS. (In a real flow Google binds the nonce to the code; the mock reads it from a
// mutable holder the test sets after parsing the auth redirect.)
let armedNonce = "";
let mock: http.Server;
let base = "";

before(async () => {
  mock = http.createServer((req, res) => {
    if ((req.url || "").startsWith("/token")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id_token: makeIdToken(armedNonce), access_token: "x", token_type: "Bearer" }));
    } else if ((req.url || "").startsWith("/certs")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [JWK] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
  const addr = mock.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
after(() => mock.close());

function setBaseEnv() {
  process.env.PORTAL_GOOGLE_CLIENT_ID = CLIENT_ID;
  process.env.PORTAL_GOOGLE_CLIENT_SECRET = "portal-secret";
  process.env.PORTAL_AUTH_SECRET = "stable-portal-secret";
  process.env.PORTAL_BASE_URL = "http://portal.local";
  process.env.PORTAL_GOOGLE_AUTH_OVERRIDE = `${base}/auth`;
  process.env.PORTAL_GOOGLE_TOKEN_OVERRIDE = `${base}/token`;
  process.env.PORTAL_GOOGLE_JWKS_OVERRIDE = `${base}/certs`;
  delete process.env.PORTAL_ALLOWED_EMAILS;
  delete process.env.PORTAL_OPEN;
}
// Default gate for the happy-path tests: open signup (any Google account), since the portal is
// now fail-closed without an allowlist or an explicit PORTAL_OPEN=1.
function gate() {
  setBaseEnv();
  process.env.PORTAL_OPEN = "1";
  return createGate();
}

function fakeReq(path: string, cookie = "") {
  return { url: path, method: "GET", headers: { host: "portal.local", cookie } } as unknown as http.IncomingMessage;
}
function fakeRes() {
  const headers: Record<string, unknown> = {};
  return {
    statusCode: 0,
    ended: false,
    body: "",
    setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = v; },
    getHeader(k: string) { return headers[k.toLowerCase()]; },
    writeHead(code: number, h?: Record<string, string>) { this.statusCode = code; if (h) for (const k of Object.keys(h)) this.setHeader(k, h[k]); },
    end(b?: string) { if (b) this.body = b; this.ended = true; },
    get location() { return headers["location"] as string; },
    get setCookies(): string[] { const c = headers["set-cookie"]; return Array.isArray(c) ? (c as string[]) : c ? [c as string] : []; },
  };
}
function cookieValue(setCookies: string[], name: string): string {
  for (const c of setCookies) {
    const m = c.match(new RegExp(`^${name}=([^;]+)`));
    if (m) return decodeURIComponent(m[1]);
  }
  return "";
}

test("the gate is enabled when the Google client is configured", () => {
  assert.equal(gate().enabled, true);
});

test("an unauthenticated request is redirected to sign in", async () => {
  const g = gate();
  const res = fakeRes();
  const handled = await g.handle(fakeReq("/"), res, new URL("http://portal.local/"));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 302);
  assert.equal(res.location, "/signin");
});

test("a full Google sign-in issues a session and opens the door", async () => {
  const g = gate();

  // 1. Start: /auth/google sets the oauth cookie and redirects to (mock) Google.
  const startRes = fakeRes();
  await g.handle(fakeReq("/auth/google"), startRes, new URL("http://portal.local/auth/google"));
  assert.equal(startRes.statusCode, 302);
  const authUrl = new URL(startRes.location);
  const state = authUrl.searchParams.get("state")!;
  const nonce = authUrl.searchParams.get("nonce")!;
  assert.ok(state && nonce);
  assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
  const oauthCookie = cookieValue(startRes.setCookies, "portal_oauth");
  assert.ok(oauthCookie, "the oauth transaction cookie must be set");

  // 2. Arm the mock to echo this nonce, then hit the callback with the matching state + cookie.
  armedNonce = nonce;
  const cbRes = fakeRes();
  await g.handle(
    fakeReq(`/auth/google/callback?code=abc123&state=${state}`, `portal_oauth=${encodeURIComponent(oauthCookie)}`),
    cbRes,
    new URL(`http://portal.local/auth/google/callback?code=abc123&state=${state}`),
  );
  assert.equal(cbRes.statusCode, 302, "callback should redirect after success");
  assert.equal(cbRes.location, "/");
  const session = cookieValue(cbRes.setCookies, "portal_session");
  assert.ok(session, "a session cookie must be issued");

  // 3. The signed-in user is recognized, and protected routes now pass through.
  const who = g.user(fakeReq("/", `portal_session=${encodeURIComponent(session)}`));
  assert.ok(who);
  assert.equal(who.email, "deployer@example.com");
  const passRes = fakeRes();
  const handled = await g.handle(
    fakeReq("/", `portal_session=${encodeURIComponent(session)}`),
    passRes,
    new URL("http://portal.local/"),
  );
  assert.equal(handled, false, "a signed-in request should fall through to the app");
});

test("a callback with a mismatched state is refused (CSRF)", async () => {
  const g = gate();
  const startRes = fakeRes();
  await g.handle(fakeReq("/auth/google"), startRes, new URL("http://portal.local/auth/google"));
  const oauthCookie = cookieValue(startRes.setCookies, "portal_oauth");
  const cbRes = fakeRes();
  await g.handle(
    fakeReq(`/auth/google/callback?code=abc&state=WRONG`, `portal_oauth=${encodeURIComponent(oauthCookie)}`),
    cbRes,
    new URL(`http://portal.local/auth/google/callback?code=abc&state=WRONG`),
  );
  assert.equal(cbRes.statusCode, 302);
  assert.match(cbRes.location, /\/signin\?reason=/);
  assert.equal(cookieValue(cbRes.setCookies, "portal_session"), "", "no session on a bad state");
});

test("fail-closed: Google on but no allowlist and no PORTAL_OPEN admits NOBODY", async () => {
  setBaseEnv(); // no allowlist, no PORTAL_OPEN
  const g = createGate();
  const startRes = fakeRes();
  await g.handle(fakeReq("/auth/google"), startRes, new URL("http://portal.local/auth/google"));
  const authUrl = new URL(startRes.location);
  armedNonce = authUrl.searchParams.get("nonce")!;
  const state = authUrl.searchParams.get("state")!;
  const oauthCookie = cookieValue(startRes.setCookies, "portal_oauth");
  const cbRes = fakeRes();
  await g.handle(
    fakeReq(`/auth/google/callback?code=abc&state=${state}`, `portal_oauth=${encodeURIComponent(oauthCookie)}`),
    cbRes,
    new URL(`http://portal.local/auth/google/callback?code=abc&state=${state}`),
  );
  assert.match(cbRes.location, /reason=not-allowed/, "a verified stranger must NOT get into the deploy console by default");
  assert.equal(cookieValue(cbRes.setCookies, "portal_session"), "");
});

test("revoking an email cuts access live on the next request", async () => {
  // Sign in while allowed, then simulate the owner removing the email (a new gate with the same
  // stable secret but an allowlist that no longer includes them). The baked session is rejected.
  const gOpen = gate(); // PORTAL_OPEN=1
  const startRes = fakeRes();
  await gOpen.handle(fakeReq("/auth/google"), startRes, new URL("http://portal.local/auth/google"));
  const authUrl = new URL(startRes.location);
  armedNonce = authUrl.searchParams.get("nonce")!;
  const state = authUrl.searchParams.get("state")!;
  const oauthCookie = cookieValue(startRes.setCookies, "portal_oauth");
  const cbRes = fakeRes();
  await gOpen.handle(
    fakeReq(`/auth/google/callback?code=abc&state=${state}`, `portal_oauth=${encodeURIComponent(oauthCookie)}`),
    cbRes,
    new URL(`http://portal.local/auth/google/callback?code=abc&state=${state}`),
  );
  const session = cookieValue(cbRes.setCookies, "portal_session");
  assert.ok(session);

  // The owner revokes: allowlist now excludes this person (and PORTAL_OPEN is off).
  setBaseEnv();
  process.env.PORTAL_ALLOWED_EMAILS = "someone-else@example.com";
  const gRevoked = createGate();
  const res = fakeRes();
  const handled = await gRevoked.handle(
    fakeReq("/", `portal_session=${encodeURIComponent(session)}`),
    res,
    new URL("http://portal.local/"),
  );
  assert.equal(handled, true, "a revoked session must be intercepted, not served");
  assert.match(res.location, /\/signin\?reason=not-allowed/);
  delete process.env.PORTAL_ALLOWED_EMAILS;
});

test("an allowlist keeps a non-listed Google account out (invite-only portal)", async () => {
  setBaseEnv();
  process.env.PORTAL_ALLOWED_EMAILS = "someone-else@example.com";
  const g = createGate();
  const startRes = fakeRes();
  await g.handle(fakeReq("/auth/google"), startRes, new URL("http://portal.local/auth/google"));
  const authUrl = new URL(startRes.location);
  armedNonce = authUrl.searchParams.get("nonce")!;
  const state = authUrl.searchParams.get("state")!;
  const oauthCookie = cookieValue(startRes.setCookies, "portal_oauth");
  const cbRes = fakeRes();
  await g.handle(
    fakeReq(`/auth/google/callback?code=abc&state=${state}`, `portal_oauth=${encodeURIComponent(oauthCookie)}`),
    cbRes,
    new URL(`http://portal.local/auth/google/callback?code=abc&state=${state}`),
  );
  assert.match(cbRes.location, /reason=not-allowed/);
  assert.equal(cookieValue(cbRes.setCookies, "portal_session"), "");
  delete process.env.PORTAL_ALLOWED_EMAILS;
});
