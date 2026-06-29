import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { parseManifest } from "@platform/manifest";
import { extractFacts } from "../src/extract.ts";
import { evaluatePolicy, DEFAULT_POLICY } from "../src/policy.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function factsFor(rel: string) {
  const dir = join(root, rel);
  const { manifest } = parseManifest(readFileSync(join(dir, "app.deploy.yaml"), "utf8"));
  return extractFacts(dir, manifest!);
}

test("an app that only uses its own platform infrastructure is auto-approved", () => {
  const v = evaluatePolicy(factsFor("apps/reference-web"));
  assert.equal(v.decision, "allowed", JSON.stringify(v.findings, null, 2));
  assert.equal(v.unapprovedHosts.length, 0);
});

test("an unknown external system and personal-data-without-sign-in are flagged for review", () => {
  const v = evaluatePolicy(factsFor("fixtures/calls-external"));
  assert.equal(v.decision, "needs-review");
  assert.ok(v.unapprovedHosts.includes("api.stripe.com"));
  assert.ok(v.unapprovedHosts.includes("api.openai.com"));
  assert.ok(v.findings.some((f) => f.topic === "outbound" && /api\.stripe\.com/.test(f.detail)));
  assert.ok(
    v.findings.some((f) => f.topic === "data" && /no sign-in/i.test(f.detail)),
    "personal data with auth tier none must be flagged",
  );
});

test("a banned dependency is a hard block", () => {
  const facts = factsFor("fixtures/calls-external");
  const policy = { ...DEFAULT_POLICY, bannedDependencies: ["next"] };
  const v = evaluatePolicy(facts, policy);
  assert.equal(v.decision, "blocked");
  assert.ok(v.findings.some((f) => f.level === "deny" && f.topic === "dependency"));
});

test("the outbound allowlist supports leading-wildcard host globs", () => {
  const facts = factsFor("fixtures/calls-external");
  // Add stripe + openai to the allowlist via wildcards; only-approved hosts → no outbound flags.
  const policy = { ...DEFAULT_POLICY, outboundAllowlist: [...DEFAULT_POLICY.outboundAllowlist, "*.stripe.com", "*.openai.com"] };
  const v = evaluatePolicy(facts, policy);
  assert.equal(v.unapprovedHosts.length, 0);
  // Still needs review because of personal-data-without-auth, but not for outbound now.
  assert.ok(!v.findings.some((f) => f.topic === "outbound" && f.level === "flag"));
});
