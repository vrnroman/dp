#!/usr/bin/env node
/**
 * Conformance hook for Claude Code.
 *
 * Wire this as a Stop hook (and optionally a PostToolUse hook) in the app project's
 * .claude/settings.json. It runs the same conformance check the platform runs before a
 * deploy, so Claude finds and fixes problems while building instead of at deploy time.
 *
 * The hook is for fast feedback. It is NOT the trust boundary; the platform always checks
 * again inside `deployctl up`, because a hook can be skipped.
 *
 * Behaviour:
 *   - No app.deploy.yaml in the project yet  -> stay quiet, exit 0.
 *   - Conformance passes                     -> exit 0.
 *   - Conformance has errors                  -> print the plain-English report to stderr
 *                                                and exit 2, which hands it back to Claude.
 *   - Checker not installed                   -> stay quiet, exit 0 (never break a session).
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

async function main() {
  const input = await readStdin();
  let payload = {};
  try {
    payload = JSON.parse(input || "{}");
  } catch {
    /* ignore */
  }
  const projectDir = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Nothing to check until the app declares itself with a manifest.
  if (!existsSync(join(projectDir, "app.deploy.yaml"))) process.exit(0);

  const conformance = await loadChecker(projectDir);
  if (!conformance) process.exit(0); // checker not available; do not nag.

  const report = conformance.checkApp(projectDir);
  if (report.ok) process.exit(0);

  const label = report.manifest?.name ?? "your app";
  process.stderr.write(conformance.renderReport(report, label) + "\n");
  process.stderr.write("\nFix these before the app can deploy.\n");
  process.exit(2);
}

async function loadChecker(projectDir) {
  // Prefer the version installed in the project.
  for (const base of [projectDir, process.env.PLATFORM_HOME]) {
    if (!base) continue;
    try {
      const require = createRequire(join(base, "package.json"));
      const path = require.resolve("@platform/conformance");
      return await import(path);
    } catch {
      /* try next */
    }
  }
  // Fall back to a bare import (works if it is globally resolvable).
  try {
    return await import("@platform/conformance");
  } catch {
    return null;
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
    setTimeout(() => resolve(data), 500);
  });
}

main();
