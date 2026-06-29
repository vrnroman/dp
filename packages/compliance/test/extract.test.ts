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
});
