import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { parseManifest, type Manifest } from "@platform/manifest";
import { complianceGate } from "../src/commands/up.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function manifestFor(rel: string): Manifest {
  const { manifest } = parseManifest(readFileSync(join(root, rel, "app.deploy.yaml"), "utf8"));
  return manifest as Manifest;
}

/** Run the gate with a temporary env, capturing everything it printed. */
async function runGate(rel: string, env: Record<string, string | undefined> = {}) {
  const dir = join(root, rel);
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    out += s;
    return true;
  };
  // Force non-interactive so a "needs-review" gate never blocks a test on stdin, whether the
  // suite runs in a terminal or piped in CI.
  const savedInTty = (process.stdin as { isTTY?: boolean }).isTTY;
  const savedOutTty = (process.stdout as { isTTY?: boolean }).isTTY;
  (process.stdin as { isTTY?: boolean }).isTTY = false;
  (process.stdout as { isTTY?: boolean }).isTTY = false;
  try {
    const code = await complianceGate(dir, manifestFor(rel));
    return { code, out };
  } finally {
    process.stdout.write = orig;
    (process.stdin as { isTTY?: boolean }).isTTY = savedInTty;
    (process.stdout as { isTTY?: boolean }).isTTY = savedOutTty;
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("BLOCKED: a banned dependency refuses the deploy before anything is built", async () => {
  const { code, out } = await runGate("fixtures/banned-tech", { DP_COMPLIANCE_APPROVED: undefined });
  assert.equal(code, 1);
  assert.match(out, /can't be put online/i);
  assert.match(out, /puppeteer/);
});

test("ALLOWED: a clean app passes the gate straight through", async () => {
  const { code, out } = await runGate("fixtures/clean-static");
  assert.equal(code, null);
  assert.match(out, /keeps to its own platform/i);
});

test("NEEDS-REVIEW, non-interactive, not approved: refused (fail closed, no hang)", async () => {
  const { code, out } = await runGate("fixtures/calls-external", { DP_COMPLIANCE_APPROVED: undefined });
  assert.equal(code, 1);
  assert.match(out, /confirm what it connects to/i);
  assert.match(out, /Stripe/);
  assert.match(out, /need a person's okay/i);
});

test("NEEDS-REVIEW with DP_COMPLIANCE_APPROVED=1: the gate lets it proceed", async () => {
  const { code, out } = await runGate("fixtures/calls-external", { DP_COMPLIANCE_APPROVED: "1" });
  assert.equal(code, null);
  assert.match(out, /going ahead/i);
});
