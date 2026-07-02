import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { parseManifest } from "@platform/manifest";
import { extractFacts } from "../src/extract.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function factsFor(rel: string) {
  const dir = join(root, rel);
  const { manifest } = parseManifest(readFileSync(join(dir, "app.deploy.yaml"), "utf8"));
  assert.ok(manifest, `fixture ${rel} should have a valid manifest`);
  return extractFacts(dir, manifest!);
}

test("extracts the real third-party systems an app connects to", () => {
  const f = factsFor("fixtures/calls-external");
  assert.ok(f.outboundHosts.includes("api.stripe.com"), JSON.stringify(f.outboundHosts));
  assert.ok(f.outboundHosts.includes("api.openai.com"), JSON.stringify(f.outboundHosts));
  assert.equal(f.makesNetworkCalls, true);
  assert.ok(f.capabilities.includes("makes outbound network requests"));
});

test("detects the personal data an app stores, and the secrets it needs", () => {
  const f = factsFor("fixtures/calls-external");
  assert.ok(f.data.personalData.includes("email addresses"));
  assert.ok(f.data.personalData.includes("phone numbers"));
  assert.ok(f.data.personalData.includes("names"));
  assert.deepEqual(f.secrets.required, ["STRIPE_SECRET_KEY"]);
  assert.equal(f.framework, "nextjs");
});

test("doc/marketing hosts in comments are NOT counted as connections", () => {
  // The reference app's next-env.d.ts links to nextjs.org in a comment — that is not a connection.
  const f = factsFor("apps/reference-web");
  assert.deepEqual(f.outboundHosts, [], "the golden app connects to nothing outside its platform");
  assert.ok(f.data.personalData.includes("email addresses"), "it does store emails (the allowlist)");
  assert.deepEqual(f.externalServices, [], "the golden app talks to no external services");
});

test("fuses the three signals into named external services (host, dependency, secret)", () => {
  const f = factsFor("fixtures/calls-external");
  const byKey = Object.fromEntries(f.externalServices.map((s) => [s.key, s]));

  // Stripe — from the host AND the secret, fused into one service, no literal `stripe` package.
  assert.ok(byKey.stripe, JSON.stringify(f.externalServices));
  assert.equal(byKey.stripe.category, "payments");
  assert.equal(byKey.stripe.secret, "STRIPE_SECRET_KEY");
  assert.ok(byKey.stripe.evidence.some((e) => e.includes("api.stripe.com")));
  assert.ok(byKey.stripe.evidence.some((e) => e.includes("STRIPE_SECRET_KEY")));

  // OpenAI — from the outbound host.
  assert.ok(byKey.openai && byKey.openai.category === "ai");

  // Amazon S3 — from the SDK dependency AND the AWS_S3_BUCKET secret (no literal S3 URL in source).
  assert.ok(byKey["aws-s3"], "S3 should be detected from the @aws-sdk/client-s3 dependency");
  assert.equal(byKey["aws-s3"].category, "object-storage");
  assert.equal(byKey["aws-s3"].secret, "AWS_S3_BUCKET");

  // A work queue — from the bullmq dependency.
  assert.ok(byKey.bullmq && byKey.bullmq.category === "queue");
});

test("a bare Stripe secret with no SDK and no URL still surfaces the service", () => {
  // The secret channel catches a SaaS an SDK/URL scan would miss.
  const { manifest } = parseManifest(
    "name: secret-only\nblueprint: web\nweb:\n  framework: nextjs\nenv:\n  required:\n    - STRIPE_SECRET_KEY\n",
  );
  const f = extractFacts(join(root, "fixtures/clean-static"), manifest!);
  // clean-static has no stripe host/dep; the manifest's secret alone must surface Stripe.
  assert.ok(f.externalServices.some((s) => s.key === "stripe" && s.secret === "STRIPE_SECRET_KEY"));
});

test("the platform's own database driver (pg) is NOT treated as an external service", () => {
  const f = factsFor("apps/reference-web");
  assert.ok(!f.externalServices.some((s) => s.category === "database"));
});

test("a secret read from process.env in code, not declared in the manifest, is still attributed", () => {
  // The manifest declares NO env at all; the fixture reads process.env.STRIPE_SECRET_KEY in code.
  // The code scan must still name the secret on the Stripe service (a dashboard-set secret pattern).
  const { manifest } = parseManifest("name: code-env-app\nblueprint: web\nweb:\n  framework: nextjs\n");
  const f = extractFacts(join(root, "fixtures/calls-external"), manifest!);
  const stripe = f.externalServices.find((s) => s.key === "stripe");
  assert.ok(stripe, "Stripe must be detected");
  assert.equal(stripe!.secret, "STRIPE_SECRET_KEY", "the secret is picked up from the process.env reference in code");
});
