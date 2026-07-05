// Regression: a wrong/stale CSRF token on a /api/groups/* POST must NOT crash the portal. The
// unit test drives groups-admin.handle() with a tolerant fake response and so missed that the real
// server.js fell through to a second writeHead (ERR_HTTP_HEADERS_SENT) and killed the process,
// taking the deploy console AND the relay down. This spins up the real server and proves it lives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
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
