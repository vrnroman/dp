// End-to-end: DP central groups -> the relay resolves a person's roles for a specific app and
// embeds them in the signed assertion -> the app-side verifier reads those roles -> the signed
// session carries them. Proves SPEC-central-groups.md acceptance #2 and #3 with mock Google and a
// local JSON store, plus the security floor (a tampered `roles` claim is refused).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { verifyRelayAssertion, type Jwk } from "../../../packages/auth/src/oauth.ts";
import { signSession, verifySession, type User } from "../../../packages/auth/src/core.ts";

const require = createRequire(import.meta.url);
const { createGate } = require("../auth-gate.js");
const { createStore } = require("../store.js");

const CLIENT_ID = "relay-client.apps.googleusercontent.com";
const APP_ORIGIN = "https://guestbook.vercel.app";
const RELAY_ISS = "dp-relay-test";
const ADMIN = "admin-secret-xyz";
const OWNER = "owner@example.com";
const ROLES = [
  { name: "viewer", can: "read the guestbook" },
  { name: "editor", can: "leave notes" },
];

const g = generateKeyPairSync("rsa", { modulusLength: 2048 });
const GKID = "g-kid";
const GJWK = { ...(g.publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: GKID, alg: "RS256", use: "sig" };
const r = generateKeyPairSync("rsa", { modulusLength: 2048 });
const RKID = "relay-kid";
const RELAY_PRIV_PEM = r.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const RELAY_PUB_JWK_STR = JSON.stringify({ ...(r.publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: RKID, alg: "RS256", use: "sig" });
const RELAY_PUB_JWK = JSON.parse(RELAY_PUB_JWK_STR) as Jwk;

function b64url(o: unknown): string { return Buffer.from(JSON.stringify(o)).toString("base64url"); }

let armedNonce = "";
let armedEmail = "person@example.com";
let armedName = "A Person";
function googleIdToken(nonce: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", kid: GKID, typ: "JWT" };
  const claims = { iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "google-" + armedEmail, email: armedEmail, email_verified: true, name: armedName, iat: now, exp: now + 3600, nonce };
  const input = `${b64url(header)}.${b64url(claims)}`;
  return `${input}.${cryptoSign("RSA-SHA256", Buffer.from(input), g.privateKey).toString("base64url")}`;
}

let mock: http.Server;
let base = "";
let allowFile = "";
let store: ReturnType<typeof createStore>;

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
  const dir = mkdtempSync(join(tmpdir(), "central-"));
  allowFile = join(dir, "allow.txt");
  writeFileSync(allowFile, "");
  store = createStore(join(dir, "store.json"));
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
  process.env.PORTAL_RELAY_PUBLIC_KEY = RELAY_PUB_JWK_STR;
  process.env.PORTAL_RELAY_KID = RKID;
  process.env.PORTAL_RELAY_ISSUER = RELAY_ISS;
  process.env.PORTAL_RELAY_ADMIN_SECRET = ADMIN;
  process.env.PORTAL_RELAY_ALLOW_FILE = allowFile;
  return createGate({ store });
}

function fakeReq(path: string, opts: { cookie?: string; method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const listeners: Record<string, ((d?: unknown) => void)[]> = {};
  const req: Record<string, unknown> = {
    url: path, method: opts.method || "GET",
    headers: { host: "portal.example", cookie: opts.cookie || "", ...(opts.headers || {}) },
    on(ev: string, cb: (d?: unknown) => void) { (listeners[ev] ||= []).push(cb); return req; },
  };
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
const relayOpts = { publicKey: RELAY_PUB_JWK, issuer: RELAY_ISS, audience: APP_ORIGIN };

// Drive a full relay sign-in for `email` and return the roles the app-side verifier reads out of
// the minted assertion (plus the raw assertion, for tamper tests).
async function signInAndGetRoles(gt: ReturnType<typeof createGate>, email: string, name = "A Person") {
  armedEmail = email;
  armedName = name;
  const appState = "app-state";
  const appNonce = "app-nonce";
  const startPath = `/auth/relay/start?app=${encodeURIComponent(APP_ORIGIN)}&complete=${encodeURIComponent(APP_ORIGIN + "/auth/complete")}&state=${appState}&nonce=${appNonce}`;
  const startRes = fakeRes();
  await gt.handleRelay(fakeReq(startPath), startRes, U(startPath));
  const gUrl = new URL(startRes.location);
  armedNonce = gUrl.searchParams.get("nonce")!;
  const gstate = gUrl.searchParams.get("state")!;
  const relayCookie = cookieValue(startRes.setCookies, "portal_relay");
  const cbPath = `/auth/google/callback?code=abc&state=${gstate}`;
  const cbRes = fakeRes();
  await gt.handleRelay(fakeReq(cbPath, { cookie: `portal_relay=${encodeURIComponent(relayCookie)}` }), cbRes, U(cbPath));
  const assertion = new URL(cbRes.location).searchParams.get("assertion")!;
  const v = verifyRelayAssertion(assertion, relayOpts);
  assert.ok(v.ok, "assertion should verify");
  return { roles: (v as { ok: true; roles: string[] }).roles, assertion };
}

test("register carries the app's declared roles into the store", async () => {
  const gt = gate();
  const res = fakeRes();
  await gt.handleRelay(
    fakeReq("/auth/relay/register", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}` },
      body: JSON.stringify({ origin: APP_ORIGIN, declaredRoles: ROLES, defaultRole: "viewer", ownerEmail: OWNER }),
    }),
    res,
    U("/auth/relay/register"),
  );
  assert.equal(res.statusCode, 200);
  const app = store.getApp(APP_ORIGIN);
  assert.ok(app);
  assert.deepEqual(app.declaredRoles.map((r: { name: string }) => r.name), ["viewer", "editor"]);
  assert.equal(app.defaultRole, "viewer");
  assert.equal(app.ownerEmail, OWNER);
});

test("a group member's mapped role rides into the assertion; a stranger gets only the default", async () => {
  const gt = gate();
  const editors = store.createGroup("Editors");
  store.setGroupRolesForApp(APP_ORIGIN, editors.id, ["editor"]);
  store.addMember(editors.id, "member@example.com");

  const member = await signInAndGetRoles(gt, "member@example.com");
  assert.deepEqual(member.roles, ["editor", "viewer"]);

  const stranger = await signInAndGetRoles(gt, "stranger@example.com");
  assert.deepEqual(stranger.roles, ["viewer"]);
});

test("the app owner implicitly holds every declared role", async () => {
  const gt = gate();
  const owner = await signInAndGetRoles(gt, OWNER);
  assert.deepEqual(owner.roles, ["editor", "viewer"]);
});

test("fail-closed: a group mapped to an UNDECLARED role grants nothing extra", async () => {
  const gt = gate();
  const admins = store.createGroup("WouldBeAdmins");
  store.setGroupRolesForApp(APP_ORIGIN, admins.id, ["admin", "superuser"]); // neither declared
  store.addMember(admins.id, "wannabe@example.com");
  const v = await signInAndGetRoles(gt, "wannabe@example.com");
  assert.deepEqual(v.roles, ["viewer"]); // only the default; the undeclared mapping grants nothing
  assert.ok(!v.roles.includes("admin"));
});

test("tampering with the roles claim breaks the signature (assertion refused)", async () => {
  const gt = gate();
  const { assertion } = await signInAndGetRoles(gt, OWNER);
  const [h, p, s] = assertion.split(".");
  const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  claims.roles = ["editor", "viewer", "admin"]; // forge an extra role
  const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${s}`;
  const v = verifyRelayAssertion(forged, relayOpts);
  assert.equal(v.ok, false); // signature no longer matches the tampered payload
});

test("the signed session carries relay roles and rejects tampering", () => {
  const secret = "sess-secret";
  const user: User = { email: "member@example.com", role: "member", roles: ["editor", "viewer"] };
  const token = signSession(user, secret);
  const back = verifySession(token, secret);
  assert.deepEqual(back?.roles, ["editor", "viewer"]);

  // Flip a byte in the payload: the HMAC no longer matches, so the whole session is rejected.
  const [body, sig] = token.split(".");
  const decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  decoded.roles = ["editor", "viewer", "admin"];
  const forged = `${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${sig}`;
  assert.equal(verifySession(forged, secret), null);
});
