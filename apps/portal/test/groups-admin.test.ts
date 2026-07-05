// The owner's /groups screen: its HTTP endpoints drive the central store (create group, add
// member, map roles), the live "try it as" preview resolves roles, and every mutation requires the
// CSRF token. The page renders the app registry, groups, and empty states.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createStore } = require("../store.js");
const { createGroupsAdmin } = require("../groups-admin.js");

const APP = "https://guestbook.vercel.app";
const ROLES = [
  { name: "viewer", can: "read the guestbook" },
  { name: "editor", can: "leave notes" },
];
const CSRF = "csrf-token-123";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "ga-"));
  const store = createStore(join(dir, "store.json"));
  store.registerApp(APP, { declaredRoles: ROLES, defaultRole: "viewer", ownerEmail: "owner@x.com" });
  return createGroupsAdmin({ store, csrf: CSRF });
}

function fakeReq(path: string, opts: { method?: string; json?: unknown; form?: Record<string, string | string[]> } = {}) {
  const listeners: Record<string, ((d?: unknown) => void)[]> = {};
  let body = "";
  let contentType = "";
  if (opts.json !== undefined) { body = JSON.stringify(opts.json); contentType = "application/json"; }
  else if (opts.form) {
    const ps = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.form)) (Array.isArray(v) ? v : [v]).forEach((x) => ps.append(k, x));
    body = ps.toString(); contentType = "application/x-www-form-urlencoded";
  }
  const req: Record<string, unknown> = {
    url: path, method: opts.method || "GET",
    headers: { host: "portal.example", "content-type": contentType },
    on(ev: string, cb: (d?: unknown) => void) { (listeners[ev] ||= []).push(cb); return req; },
  };
  if ((opts.method || "GET") === "POST") {
    queueMicrotask(() => {
      if (body) (listeners["data"] || []).forEach((cb) => cb(Buffer.from(body)));
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
  };
}
const U = (p: string) => new URL(p, "https://portal.example");

async function post(ga: ReturnType<typeof createGroupsAdmin>, path: string, form: Record<string, string | string[]>) {
  const res = fakeRes();
  await ga.handle(fakeReq(path, { method: "POST", form }), res, U(path));
  return res;
}

test("GET /groups renders the screen with the registered app and empty-state copy", async () => {
  const ga = fresh();
  const res = fakeRes();
  const handled = await ga.handle(fakeReq("/groups"), res, U("/groups"));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Groups &amp; access/);
  assert.match(res.body, /guestbook\.vercel\.app/);
  assert.match(res.body, /Try it as someone/);
  assert.match(res.body, /No groups yet/); // empty state
});

test("create / add-member / set-roles drive the store", async () => {
  const ga = fresh();
  await post(ga, "/api/groups/create", { csrf: CSRF, name: "Family" });
  const store = ga._store ?? null; // not exported; verify through the page instead
  // Re-render and confirm the group shows up.
  const res = fakeRes();
  await ga.handle(fakeReq("/groups"), res, U("/groups"));
  assert.match(res.body, /Family/);

  // Grab the group id from the rendered hidden input.
  const gid = (res.body.match(/name="groupId" value="(g[a-f0-9]+)"/) || [])[1];
  assert.ok(gid, "group id should render");

  const addRes = await post(ga, "/api/groups/add-member", { csrf: CSRF, groupId: gid, email: "Mom@Example.com" });
  assert.equal(addRes.statusCode, 302);
  const setRes = await post(ga, "/api/groups/set-roles", { csrf: CSRF, groupId: gid, appOrigin: APP, role: ["editor", "admin"] });
  assert.equal(setRes.statusCode, 302);

  // The preview reflects the mapping, fail-closed (admin was undeclared, so dropped).
  const preview = fakeRes();
  await ga.handle(fakeReq("/api/groups/preview", { method: "POST", json: { csrf: CSRF, email: "mom@example.com", appOrigin: APP } }), preview, U("/api/groups/preview"));
  const out = JSON.parse(preview.body);
  assert.deepEqual(out.can.sort(), ["leave notes", "read the guestbook"]);
});

test("the live preview resolves the default role for a stranger", async () => {
  const ga = fresh();
  const res = fakeRes();
  await ga.handle(fakeReq("/api/groups/preview", { method: "POST", json: { csrf: CSRF, email: "nobody@x.com", appOrigin: APP } }), res, U("/api/groups/preview"));
  const out = JSON.parse(res.body);
  assert.deepEqual(out.can, ["read the guestbook"]); // default viewer only
});

test("a bad CSRF token performs no mutation", async () => {
  const ga = fresh();
  const res = await post(ga, "/api/groups/create", { csrf: "wrong", name: "Sneaky" });
  assert.equal(res.statusCode, 302); // bounced back
  const page = fakeRes();
  await ga.handle(fakeReq("/groups"), page, U("/groups"));
  assert.doesNotMatch(page.body, /Sneaky/); // nothing was created
});
