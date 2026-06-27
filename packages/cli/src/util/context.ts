/**
 * Build a self-contained deploy context.
 *
 * The reference app lives inside an npm workspace and depends on @platform/auth via a
 * workspace link. That link does not survive being uploaded to a host on its own. Rather
 * than wrestle each host's monorepo handling, we copy the app into a throwaway directory
 * and vendor the platform package inside it as a local file: dependency. The result is a
 * plain, standalone app any host can install and build. The user's real app directory is
 * never touched.
 */
import { mkdtempSync, cpSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP = new Set([
  "node_modules",
  ".next",
  ".vercel",
  ".git",
  ".turbo",
  "dist",
  ".deploy-state.json",
]);

/** Absolute path to the repo root (two levels up from packages/cli/src/util). */
export function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

export interface DeployContext {
  dir: string;
}

/**
 * Copy `appDir` into a temp directory and vendor any @platform/* workspace dependency it
 * declares, rewriting the dependency to a local path. Returns the temp directory to deploy.
 */
export function prepareDeployContext(appDir: string): DeployContext {
  const tmp = mkdtempSync(join(tmpdir(), "deployctl-"));
  cpSync(appDir, tmp, {
    recursive: true,
    filter: (src) => {
      const base = src.split("/").pop() ?? "";
      if (SKIP.has(base)) return false;
      if (base.endsWith("-card.html")) return false;
      return true;
    },
  });

  // Rewrite workspace @platform/* deps to vendored local copies.
  const pkgPath = join(tmp, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const deps: Record<string, string> = pkg.dependencies ?? {};
  const vendorDir = join(tmp, "vendor");
  let vendored = false;
  for (const name of Object.keys(deps)) {
    if (!name.startsWith("@platform/")) continue;
    const short = name.replace("@platform/", "");
    const srcPkg = join(repoRoot(), "packages", short);
    if (!existsSync(srcPkg)) continue;
    if (!vendored) {
      mkdirSync(vendorDir, { recursive: true });
      vendored = true;
    }
    const dest = join(vendorDir, short);
    cpSync(srcPkg, dest, {
      recursive: true,
      filter: (s) => (s.split("/").pop() ?? "") !== "node_modules",
    });
    deps[name] = `file:./vendor/${short}`;
  }
  pkg.dependencies = deps;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  // A minimal ignore so the host does not try to ship local build output.
  writeFileSync(join(tmp, ".vercelignore"), ["node_modules", ".next", ".git", ".deploy-state.json"].join("\n") + "\n");

  return { dir: tmp };
}
