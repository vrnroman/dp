// End-to-end test of the auth RELAY: app -> relay -> (mock Google) -> relay mints a signed
// identity assertion -> the app-side verifier (verifyRelayAssertion) accepts it. Exercises the
// allowlist fail-closed control, the Google leg, assertion minting, and cross-verification,
// without a live Google.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { verifyRelayAssertion, type Jwk } from "../../../packages/auth/src/oauth.ts";

const require = createRequire(import.meta.url);
const { createGate } = require("../auth-gate.js");

const CLIENT_ID = "relay-client.apps.googleusercontent.com";
const APP_ORIGIN = "https://myapp.vercel.app";
const RELAY_ISS = "dp-relay-test";
const ADMIN = "admin-secret-xyz";

// Mock Google signing key.
const g = generateKeyPairSync("rsa", { modulusLength: 2048 });
const GKID = "g-kid";
const GJWK = { ...(g.publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: GKID, alg: "RS256", use: "sig" };
// The relay's own signing key.
const r = generateKeyPairSync("rsa", { modulusLength: 2048 });
const RKID = "relay-kid";
const RELAY_PRIV_PEM = r.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const RELAY_PUB_JWK = JSON.stringify({ ...(r.publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: RKID, alg: "RS256", use: "sig" });

function b64url(o: unknown): string { return Buffer.from(JSON.stringify(o)).toString("base64url"); }
function googleIdToken(nonce: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", kid: GKID, typ: "JWT" };
  const claims = { iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "google-123", email: "person@example.com", email_verified: true, name: "A Person", iat: now, exp: now + 3600, nonce };
  const input = `${b64url(header)}.${b64url(claims)}`;
  return `${input}.${cryptoSign("RSA-SHA256", Buffer.from(input), g.privateKey).toString("base64url")}`;
}

let armedNonce = "";
let mock: http.Server;
let base = "";
let allowFile = "";

before(async () => {
  mock = http.createServer((req, res) => {
    if ((req.url || "").startsWith("/token")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id_token: googleIdToken(armedNonce), token_type: "Bearer" }));
    } else if ((req.url || "").startsWith("/certs")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [GJWK] }));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((res) => mock.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;
  allowFile = join(mkdtempSync(join(tmpdir(), "relay-")), "allow.txt");
  writeFileSync(allowFile, ""); // starts empty
});
after(() => mock.close());

function gate() {
  process.env.PORTAL_GOOGLE_CLIENT_ID = CLIENT_ID;
  process.env.PORTAL_GOOGLE_CLIENT_SECRET = "portal-secret";
  process.env.PORTAL_AUTH_SECRET = "stable-secret";
  process.env.PORTAL_BASE_URL = "https://portal.example";
  process.env.PORTAL_GOOGLE_TOKEN_OVERRIDE = `${base}/token`;
  process.env.PORTAL_GOOGLE_JWKS_OVERRIDE = `${base}/certs`;
  process.env.PORTAL_GOOGLE_AUTH_OVERRIDE = `${base}/auth`;
  process.env.PORTAL_RELAY_PRIVATE_KEY = RELAY_PRIV_PEM;
  process.env.PORTAL_RELAY_PUBLIC_KEY = RELAY_PUB_JWK;
  process.env.PORTAL_RELAY_KID = RKID;
  process.env.PORTAL_RELAY_ISSUER = RELAY_ISS;
  process.env.PORTAL_RELAY_ADMIN_SECRET = ADMIN;
  process.env.PORTAL_RELAY_ALLOW_FILE = allowFile;
  return createGate();
}

function fakeReq(path: string, opts: { cookie?: string; method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const listeners: Record<string, ((d?: unknown) => void)[]> = {};
  const req: Record<string, unknown> = {
    url: path, method: opts.method || "GET",
    headers: { host: "portal.example", cookie: opts.cookie || "", ...(opts.headers || {}) },
    on(ev: string, cb: (d?: unknown) => void) { (listeners[ev] ||= []).push(cb); return req; },
  };
  // Deliver a POST body asynchronously on the next tick.
  if (opts.method === "POST") {
    queueMicrotask(() => {
      if (opts.body) (listeners["data"] || []).forEach((cb) => cb(Buffer.from(opts.body!)));
      (listeners["end"] || []).forEach((cb) => cb());
    });
  }
  return req as unknown as http.IncomingMessage;
}
function fakeRes() {
  const headers: Record<string, unknown> = {};
  return {
    statusCode: 0, body: "",
    setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = v; },
    getHeader(k: string) { return headers[k.toLowerCase()]; },
    writeHead(code: number, h?: Record<string, string>) { this.statusCode = code; if (h) for (const k of Object.keys(h)) this.setHeader(k, h[k]); },
    end(b?: string) { if (b) this.body = b; },
    get location() { return headers["location"] as string; },
    get setCookies(): string[] { const c = headers["set-cookie"]; return Array.isArray(c) ? (c as string[]) : c ? [c as string] : []; },
  };
}
function cookieValue(setCookies: string[], name: string): string {
  for (const c of setCookies) { const m = c.match(new RegExp(`^${name}=([^;]+)`)); if (m) return decodeURIComponent(m[1]); }
  return "";
}
const U = (p: string) => new URL(p, "https://portal.example");

test("register requires the admin secret", async () => {
  const gt = gate();
  const bad = fakeRes();
  await gt.handleRelay(fakeReq("/auth/relay/register", { method: "POST", body: JSON.stringify({ origin: APP_ORIGIN }) }), bad, U("/auth/relay/register"));
  assert.equal(bad.statusCode, 401);

  const ok = fakeRes();
  await gt.handleRelay(fakeReq("/auth/relay/register", { method: "POST", headers: { authorization: `Bearer ${ADMIN}` }, body: JSON.stringify({ origin: APP_ORIGIN }) }), ok, U("/auth/relay/register"));
  assert.equal(ok.statusCode, 200);
});

test("the pubkey endpoint serves the relay public JWK", async () => {
  const gt = gate();
  const res = fakeRes();
  await gt.handleRelay(fakeReq("/auth/relay/pubkey"), res, U("/auth/relay/pubkey"));
  assert.equal(res.statusCode, 200);
  assert.equal((JSON.parse(res.body) as Jwk).kid, RKID);
});

test("relay/start refuses an unregistered app origin (fail-closed)", async () => {
  const gt = gate();
  const res = fakeRes();
  const stranger = "https://evil.vercel.app";
  await gt.handleRelay(fakeReq(`/auth/relay/start?app=${encodeURIComponent(stranger)}&complete=${encodeURIComponent(stranger + "/auth/complete")}&state=s&nonce=n`), res, U(`/auth/relay/start?app=${encodeURIComponent(stranger)}&complete=${encodeURIComponent(stranger + "/auth/complete")}&state=s&nonce=n`));
  assert.equal(res.statusCode, 403);
});

test("relay/start refuses a return URL on a different origin (open-redirect defense)", async () => {
  const gt = gate();
  const res = fakeRes();
  const p = `/auth/relay/start?app=${encodeURIComponent(APP_ORIGIN)}&complete=${encodeURIComponent("https://evil.vercel.app/auth/complete")}&state=s&nonce=n`;
  await gt.handleRelay(fakeReq(p), res, U(p));
  assert.equal(res.statusCode, 400);
});

test("full relay flow: registered app gets a signed assertion the app-side verifier accepts", async () => {
  const gt = gate();
  // 1. register the app
  await gt.handleRelay(fakeReq("/auth/relay/register", { method: "POST", headers: { authorization: `Bearer ${ADMIN}` }, body: JSON.stringify({ origin: APP_ORIGIN }) }), fakeRes(), U("/auth/relay/register"));

  // 2. app's own state+nonce
  const appState = "app-state-abc";
  const appNonce = "app-nonce-xyz";
  const startPath = `/auth/relay/start?app=${encodeURIComponent(APP_ORIGIN)}&complete=${encodeURIComponent(APP_ORIGIN + "/auth/complete")}&state=${appState}&nonce=${appNonce}`;
  const startRes = fakeRes();
  await gt.handleRelay(fakeReq(startPath), startRes, U(startPath));
  assert.equal(startRes.statusCode, 302, "relay/start should redirect to Google");
  const gUrl = new URL(startRes.location);
  const gstate = gUrl.searchParams.get("state")!;
  const gnonce = gUrl.searchParams.get("nonce")!;
  assert.equal(gUrl.searchParams.get("redirect_uri"), "https://portal.example/auth/google/callback");
  assert.equal(gUrl.searchParams.get("code_challenge_method"), "S256");
  const relayCookie = cookieValue(startRes.setCookies, "portal_relay");
  assert.ok(relayCookie);

  // 3. Google returns to the relay callback (relay cookie present -> relay branch)
  armedNonce = gnonce; // mock Google echoes the relay's gnonce into the id_token
  const cbPath = `/auth/google/callback?code=abc&state=${gstate}`;
  const cbRes = fakeRes();
  const handled = await gt.handleRelay(fakeReq(cbPath, { cookie: `portal_relay=${encodeURIComponent(relayCookie)}` }), cbRes, U(cbPath));
  assert.equal(handled, true);
  assert.equal(cbRes.statusCode, 302);
  const back = new URL(cbRes.location);
  assert.equal(back.origin + back.pathname, `${APP_ORIGIN}/auth/complete`);
  assert.equal(back.searchParams.get("state"), appState, "the app's state is echoed back");
  const assertion = back.searchParams.get("assertion")!;
  assert.ok(assertion);

  // 4. the app verifies the assertion with the relay's PUBLIC key
  const pub = JSON.parse(RELAY_PUB_JWK) as Jwk;
  const good = verifyRelayAssertion(assertion, { publicKey: pub, issuer: RELAY_ISS, audience: APP_ORIGIN, nonce: appNonce });
  assert.ok(good.ok, good.ok ? "" : good.reason);
  if (good.ok) { assert.equal(good.identity.email, "person@example.com"); assert.equal(good.identity.sub, "google-123"); }

  // and it is bound to THIS app: a different audience is refused
  assert.equal(verifyRelayAssertion(assertion, { publicKey: pub, issuer: RELAY_ISS, audience: "https://other.vercel.app", nonce: appNonce }).ok, false);
  // and to THIS sign-in: a different nonce is refused
  assert.equal(verifyRelayAssertion(assertion, { publicKey: pub, issuer: RELAY_ISS, audience: APP_ORIGIN, nonce: "wrong" }).ok, false);
});

test("deregister removes an app so it can no longer get assertions (teardown safety)", async () => {
  const gt = gate();
  const target = "https://torn-down.vercel.app";
  const reg = (path: string) => fakeReq(path, { method: "POST", headers: { authorization: `Bearer ${ADMIN}` }, body: JSON.stringify({ origin: target }) });
  await gt.handleRelay(reg("/auth/relay/register"), fakeRes(), U("/auth/relay/register"));

  // it's allowed now
  const okStart = fakeRes();
  const sp = `/auth/relay/start?app=${encodeURIComponent(target)}&complete=${encodeURIComponent(target + "/auth/complete")}&state=s&nonce=n`;
  await gt.handleRelay(fakeReq(sp), okStart, U(sp));
  assert.equal(okStart.statusCode, 302);

  // deregister requires the admin token
  const noAuth = fakeRes();
  await gt.handleRelay(fakeReq("/auth/relay/deregister", { method: "POST", body: JSON.stringify({ origin: target }) }), noAuth, U("/auth/relay/deregister"));
  assert.equal(noAuth.statusCode, 401);

  // deregister with the token
  const dereg = fakeRes();
  await gt.handleRelay(reg("/auth/relay/deregister"), dereg, U("/auth/relay/deregister"));
  assert.equal(dereg.statusCode, 200);

  // now it's refused (fail-closed again)
  const refused = fakeRes();
  await gt.handleRelay(fakeReq(sp), refused, U(sp));
  assert.equal(refused.statusCode, 403);
});

test("a stale relay cookie does NOT hijack a portal-login callback (state mismatch falls through)", async () => {
  // A relay cookie whose gstate does not match the returned state must be ignored by the relay
  // branch (handleRelay returns false), so the portal's own login on the shared callback still works.
  const gt = gate();
  await gt.handleRelay(fakeReq("/auth/relay/register", { method: "POST", headers: { authorization: `Bearer ${ADMIN}` }, body: JSON.stringify({ origin: APP_ORIGIN }) }), fakeRes(), U("/auth/relay/register"));
  const startPath = `/auth/relay/start?app=${encodeURIComponent(APP_ORIGIN)}&complete=${encodeURIComponent(APP_ORIGIN + "/auth/complete")}&state=s2&nonce=n2`;
  const startRes = fakeRes();
  await gt.handleRelay(fakeReq(startPath), startRes, U(startPath));
  const relayCookie = cookieValue(startRes.setCookies, "portal_relay");
  // A portal-login callback (different state) arrives with the stale relay cookie present.
  const cbPath = `/auth/google/callback?code=abc&state=PORTAL-LOGIN-STATE`;
  const cbRes = fakeRes();
  const handled = await gt.handleRelay(fakeReq(cbPath, { cookie: `portal_relay=${encodeURIComponent(relayCookie)}` }), cbRes, U(cbPath));
  assert.equal(handled, false, "the relay must NOT claim a callback whose state is not its gstate");
});

test("relay callback with the matching state but a Google error hands the app a cancelled error", async () => {
  const gt = gate();
  await gt.handleRelay(fakeReq("/auth/relay/register", { method: "POST", headers: { authorization: `Bearer ${ADMIN}` }, body: JSON.stringify({ origin: APP_ORIGIN }) }), fakeRes(), U("/auth/relay/register"));
  const startPath = `/auth/relay/start?app=${encodeURIComponent(APP_ORIGIN)}&complete=${encodeURIComponent(APP_ORIGIN + "/auth/complete")}&state=s3&nonce=n3`;
  const startRes = fakeRes();
  await gt.handleRelay(fakeReq(startPath), startRes, U(startPath));
  const relayCookie = cookieValue(startRes.setCookies, "portal_relay");
  const gstate = new URL(startRes.location).searchParams.get("state")!;
  const cbPath = `/auth/google/callback?error=access_denied&state=${gstate}`;
  const cbRes = fakeRes();
  const handled = await gt.handleRelay(fakeReq(cbPath, { cookie: `portal_relay=${encodeURIComponent(relayCookie)}` }), cbRes, U(cbPath));
  assert.equal(handled, true);
  assert.match(cbRes.location, /error=cancelled/);
  assert.equal(new URL(cbRes.location).searchParams.get("assertion"), null);
});
