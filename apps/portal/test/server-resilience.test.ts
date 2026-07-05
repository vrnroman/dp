// Regression: a wrong/stale CSRF token on a /api/groups/* POST must NOT crash the portal. The
// unit test drives groups-admin.handle() with a tolerant fake response and so missed that the real
// server.js fell through to a second writeHead (ERR_HTTP_HEADERS_SENT) and killed the process,
// taking the deploy console AND the relay down. This spins up the real server and proves it lives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverJs = join(here, "..", "server.js");
const PORT = 8123;
const BASE = `http://127.0.0.1:${PORT}`;

async function waitUp(ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/healthz`);
    return r.ok;
  } catch {
    return false;
  }
}

test("a bad-CSRF POST to a groups endpoint does not crash the portal", async () => {
  const store = join(mkdtempSync(join(tmpdir(), "resil-")), "store.json");
  const child: ChildProcess = spawn(process.execPath, [serverJs], {
    env: { ...process.env, DP_STORE_FILE: store, PORT: String(PORT), HOST: "127.0.0.1" },
    stdio: "ignore",
  });
  try {
    assert.ok(await waitUp(), "portal should start and answer /healthz");

    // Fire the exact request the verifier used: a form POST with a wrong CSRF token.
    const bounce = await fetch(`${BASE}/api/groups/create`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "csrf=WRONGTOKEN&name=Anything",
      redirect: "manual",
    });
    assert.equal(bounce.status, 302, "bad CSRF should bounce, not error");

    // The bad-CSRF preview path (JSON) too.
    await fetch(`${BASE}/api/groups/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ csrf: "WRONGTOKEN", email: "x@y.com", appOrigin: "https://a.vercel.app" }),
    }).catch(() => {});

    // The whole point: the process is still alive and serving.
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(await healthy(), "portal must still be alive after a bad-CSRF POST");
  } finally {
    child.kill("SIGKILL");
  }
});

test("an unwritable store returns a graceful 500, it does not crash the portal", async () => {
  // Simulate the production failure that a mis-provisioned store dir caused (root-owned dir, app
  // user can't create the atomic temp file): a store whose directory has no write bit. A create
  // must return 500 and the process must stay up (before the fix it was an unhandled rejection).
  const dir = mkdtempSync(join(tmpdir(), "resil-ro-"));
  const store = join(dir, "store.json");
  writeFileSync(store, '{"version":1,"apps":{},"people":{},"groups":{},"members":{},"appRoles":{}}');
  chmodSync(dir, 0o555); // read+exec, NO write: temp-file creation in this dir will EACCES
  const PORT2 = 8125;
  const child: ChildProcess = spawn(process.execPath, [serverJs], {
    env: { ...process.env, DP_STORE_FILE: store, PORT: String(PORT2), HOST: "127.0.0.1" },
    stdio: "ignore",
  });
  try {
    const base = `http://127.0.0.1:${PORT2}`;
    const deadline = Date.now() + 5000;
    let up = false;
    while (Date.now() < deadline) { try { if ((await fetch(`${base}/healthz`)).ok) { up = true; break; } } catch {} await new Promise((r) => setTimeout(r, 100)); }
    assert.ok(up, "portal should start");

    // Read the CSRF token off the /groups page so this is a VALID mutation that only fails at write.
    const pageHtml = await (await fetch(`${base}/groups`)).text();
    const csrf = (pageHtml.match(/name="csrf" value="([a-f0-9]+)"/) || [])[1];
    assert.ok(csrf, "should render a CSRF token");

    const res = await fetch(`${base}/api/groups/create`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `csrf=${csrf}&name=WillFailToPersist`,
      redirect: "manual",
    });
    assert.equal(res.status, 500, "an unwritable store should yield a graceful 500");

    await new Promise((r) => setTimeout(r, 150));
    assert.ok((await fetch(`${base}/healthz`)).ok, "portal must still be alive after a store write failure");
  } finally {
    child.kill("SIGKILL");
    try { chmodSync(dir, 0o755); } catch {} // restore so the temp dir can be cleaned up
  }
});
