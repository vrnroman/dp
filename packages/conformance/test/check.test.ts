import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkApp } from "../src/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("the golden reference app passes conformance", () => {
  const report = checkApp(join(root, "apps", "reference-web"));
  assert.equal(report.ok, true, JSON.stringify(report.findings, null, 2));
  assert.ok(report.passed.length >= 4);
});

test("the bad fixture fails, and for the right reasons", () => {
  const report = checkApp(join(root, "fixtures", "bad-web"));
  assert.equal(report.ok, false);

  const errors = report.findings.filter((f) => f.level === "error");
  // missing migrations folder
  assert.ok(errors.some((f) => /migrations folder is missing/i.test(f.problem)));
  // hardcoded connection string
  assert.ok(errors.some((f) => /connection string/i.test(f.problem)));
  // hardcoded key
  assert.ok(errors.some((f) => /JWT key|Supabase/i.test(f.problem)));

  // every finding has a copy-pasteable fix
  for (const f of report.findings) assert.ok(f.fix.length > 0);
});

test("a secret hidden outside app/ and lib/ (e.g. utils/) is still caught", () => {
  // Regression: the scanner must walk the whole tree, not an allowlist of folders.
  const report = checkApp(join(root, "fixtures", "leaky-utils"));
  assert.equal(report.ok, false);
  assert.ok(
    report.findings.some((f) => f.level === "error" && /JWT key|Supabase/i.test(f.problem)),
    "the service-role key in utils/supabase/server.ts must be flagged",
  );
  // And it must never affirm safety when it found a leak.
  assert.ok(!report.passed.some((p) => /No secrets/i.test(p)));
});

test("secrets in shipped non-code files (.sql migration, .toml config) are caught", () => {
  // Regression: scan by text, not by an extension allowlist. A service-role key in a
  // migration that the platform RUNS on deploy is the worst case.
  const report = checkApp(join(root, "fixtures", "leaky-sql"));
  assert.equal(report.ok, false);
  const wheres = report.findings.filter((f) => f.level === "error").map((f) => f.where);
  assert.ok(
    wheres.some((w) => w.includes("0001_init.sql")),
    "the secret in the .sql migration must be flagged",
  );
  assert.ok(
    wheres.some((w) => w.includes("config.toml")),
    "the secret in the .toml config must be flagged",
  );
  assert.ok(!report.passed.some((p) => /No secrets/i.test(p)));
});

test("a web app that claims a framework it has not installed is refused up front", () => {
  // Regression: the gate must catch "framework: nextjs but next is not in package.json"
  // here, not let it become a cryptic host build failure after clone + push.
  const report = checkApp(join(root, "fixtures", "wrong-framework"));
  assert.equal(report.ok, false);
  assert.ok(
    report.findings.some(
      (f) => f.level === "error" && /nextjs/i.test(f.problem) && /next/.test(f.fix),
    ),
    "the missing next dependency must be flagged with a fix",
  );
});

test("an app with no manifest is a single clear error", () => {
  const report = checkApp(join(root, "packages")); // no app.deploy.yaml here
  assert.equal(report.ok, false);
  assert.equal(report.findings.length, 1);
  assert.match(report.findings[0].problem, /no deploy file/i);
});
