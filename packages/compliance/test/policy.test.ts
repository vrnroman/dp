import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { parseManifest } from "@platform/manifest";
import { extractFacts, type AppFacts } from "../src/extract.ts";
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

test("a clean app with no external systems gets an allowed verdict (straight deployment)", () => {
  const v = evaluatePolicy(factsFor("fixtures/clean-static"));
  assert.equal(v.decision, "allowed", JSON.stringify(v.findings, null, 2));
  assert.equal(v.findings.filter((f) => f.level !== "ok").length, 0);
});

test("detected external services and personal-data-without-sign-in flip the verdict to needs-review", () => {
  const facts = factsFor("fixtures/calls-external");
  const v = evaluatePolicy(facts);
  assert.equal(v.decision, "needs-review");

  // Each external system is surfaced as ONE service line the approver confirms (Stripe, OpenAI,
  // S3, the queue) — not as raw hosts. A host explained by a service is folded into it.
  const serviceFindings = v.findings.filter((f) => f.topic === "service" && f.level === "flag");
  const detail = serviceFindings.map((f) => f.detail).join("\n");
  assert.match(detail, /Stripe/);
  assert.match(detail, /STRIPE_SECRET_KEY/); // the secret it rides on is named
  assert.match(detail, /OpenAI/);
  assert.match(detail, /Amazon S3/);
  assert.match(detail, /queue/i);

  // api.stripe.com / api.openai.com are claimed by their services, so they are NOT loose hosts.
  assert.equal(v.unapprovedHosts.length, 0, JSON.stringify(v.unapprovedHosts));
  assert.ok(!v.findings.some((f) => f.topic === "outbound" && f.level === "flag"));

  // Personal data with no sign-in is still flagged.
  assert.ok(v.findings.some((f) => f.topic === "data" && /no sign-in/i.test(f.detail)));
});

test("a banned dependency (the default puppeteer/playwright rule) is a hard block", () => {
  const v = evaluatePolicy(factsFor("fixtures/banned-tech"));
  assert.equal(v.decision, "blocked");
  assert.ok(v.findings.some((f) => f.level === "deny" && f.topic === "dependency" && /puppeteer/.test(f.detail)));
});

test("a banned dependency that is dev-only (test tooling) does NOT block", () => {
  // @playwright/test in devDependencies never ships to the serverless runtime, so it must not
  // trip the runtime banned list, even though its name contains "playwright".
  const facts: AppFacts = {
    name: "dev-tools",
    blueprint: "web",
    framework: "nextjs",
    runtime: null,
    dependencies: [
      { name: "next", version: "15", dev: false },
      { name: "@playwright/test", version: "1", dev: true },
      { name: "puppeteer-core", version: "23", dev: true },
    ],
    outboundHosts: [],
    externalServices: [],
    makesNetworkCalls: false,
    data: { hasDatabase: false, storageBuckets: [], authTier: "none", personalData: [] },
    secrets: { required: [], optional: [] },
    capabilities: [],
  };
  const v = evaluatePolicy(facts);
  assert.notEqual(v.decision, "blocked", JSON.stringify(v.findings));
  // But the same package as a RUNTIME dependency is still a hard block.
  const runtime = evaluatePolicy({ ...facts, dependencies: [{ name: "puppeteer", version: "23", dev: false }] });
  assert.equal(runtime.decision, "blocked");
});

test("approving a service in policy suppresses its review flag", () => {
  const facts = factsFor("fixtures/calls-external");
  // Approve every fingerprinted service; personal-data-without-auth remains the only flag.
  const keys = facts.externalServices.map((s) => s.key);
  const v = evaluatePolicy(facts, { ...DEFAULT_POLICY, approvedServices: keys });
  assert.ok(!v.findings.some((f) => f.topic === "service" && f.level === "flag"));
  assert.ok(v.findings.some((f) => f.topic === "service" && f.level === "ok"));
  // Still needs review, but now only for the personal-data-without-sign-in item.
  assert.equal(v.decision, "needs-review");
  assert.ok(v.findings.some((f) => f.topic === "data" && f.level === "flag"));
});

test("the outbound allowlist supports leading-wildcard host globs on loose hosts", () => {
  // A loose host (not one of a named service) exercises the glob matcher directly.
  const base: AppFacts = {
    name: "synthetic",
    blueprint: "web",
    framework: "nextjs",
    runtime: null,
    dependencies: [],
    outboundHosts: ["api.acme-crm.com"],
    externalServices: [],
    makesNetworkCalls: true,
    data: { hasDatabase: false, storageBuckets: [], authTier: "none", personalData: [] },
    secrets: { required: [], optional: [] },
    capabilities: [],
  };
  const flagged = evaluatePolicy(base);
  assert.deepEqual(flagged.unapprovedHosts, ["api.acme-crm.com"]);
  assert.equal(flagged.decision, "needs-review");

  const allowed = evaluatePolicy(base, { ...DEFAULT_POLICY, outboundAllowlist: [...DEFAULT_POLICY.outboundAllowlist, "*.acme-crm.com"] });
  assert.equal(allowed.unapprovedHosts.length, 0);
  assert.equal(allowed.decision, "allowed");
});
