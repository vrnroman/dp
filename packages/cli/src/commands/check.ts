import { resolve, basename } from "node:path";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkApp, renderReport } from "@platform/conformance";
import { runBuildCheck } from "./preflight.ts";

export function runCheck(appDirArg: string): number {
  const appDir = resolve(appDirArg || ".");
  const report = checkApp(appDir);
  const label = report.manifest?.name ?? basename(appDir);
  process.stdout.write(renderReport(report, label) + "\n");
  return report.ok ? 0 : 1;
}

/**
 * The full deployability gate: the instant static check, and — only if it passes — a real
 * build in a throwaway copy. Powers `deployctl preflight` and `deployctl check --build`.
 */
export async function runCheckWithBuild(appDirArg: string): Promise<number> {
  const appDir = resolve(appDirArg || ".");
  const report = checkApp(appDir);
  const label = report.manifest?.name ?? basename(appDir);
  process.stdout.write(renderReport(report, label) + "\n");
  if (!report.ok) {
    process.stdout.write("\nFix the items above first. The build check did not run.\n");
    return 1;
  }
  process.stdout.write("\n");
  return await runBuildCheck(appDir);
}

/**
 * Hook mode, for wiring into a Claude Code Stop hook. Stays silent when the app is fine or
 * has no manifest yet; on real problems it writes the plain-English report to stderr and
 * exits 2, which hands the problems back to Claude to fix before it stops.
 */
export function runCheckHook(appDirArg: string): number {
  const appDir = resolve(appDirArg || ".");
  if (!existsSync(join(appDir, "app.deploy.yaml"))) return 0;
  const report = checkApp(appDir);
  if (report.ok) return 0;
  const label = report.manifest?.name ?? basename(appDir);
  process.stderr.write(renderReport(report, label) + "\n\nFix these before the app can deploy.\n");
  return 2;
}
