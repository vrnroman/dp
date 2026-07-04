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
import { mkdtempSync, cpSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
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
      if (base.endsWith("-approval.md")) return false;
      return true;
    },
  });

  // Rewrite workspace @platform/* deps to vendored local copies.
  const pkgPath = join(tmp, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const deps: Record<string, string> = pkg.dependencies ?? {};

  // Detect TypeScript BEFORE vendoring (so the vendored @platform/* source doesn't count). A
  // Next.js app written in TypeScript needs the TS toolchain or the host build dies with
  // "you're trying to use TypeScript but do not have the required packages". That toolchain is
  // not a technology decision the user should have to make, so the platform provides it here (on
  // the deploy copy, never the user's app) when the app uses TS but did not declare it.
  const usesTypescript = existsSync(join(tmp, "tsconfig.json")) || hasTsSource(tmp);
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

  // Provide the TS toolchain for a TypeScript app that did not declare it. Match @types/react to
  // the app's own React major so the types never conflict with the app's version.
  if (usesTypescript) {
    const dev: Record<string, string> = pkg.devDependencies ?? {};
    const all = { ...deps, ...dev };
    const reactMajor = majorOf(all.react) ?? majorOf(all["react-dom"]) ?? 18;
    const ensure = (name: string, version: string) => {
      if (!all[name]) dev[name] = version;
    };
    ensure("typescript", "^5");
    ensure("@types/node", "^20");
    ensure("@types/react", `^${reactMajor}`);
    ensure("@types/react-dom", `^${reactMajor}`);
    // The platform's auth binding uses `pg`; a TS build type-checks it and needs the pg types.
    if (all.pg) ensure("@types/pg", "^8");
    pkg.devDependencies = dev;

    // The platform's own vendored packages (@platform/*) import with explicit `.ts` extensions,
    // which a modern TypeScript's type-check (run by `next build`) rejects unless the tsconfig
    // opts in. Since the platform is what vendors that code, it enables the option on the deploy
    // copy (valid because a Next build never emits via tsc). Without this, the app's build dies on
    // the vendored source under any TypeScript newer than the pin the reference app happens to use.
    if (vendored) allowTsExtensions(join(tmp, "tsconfig.json"));
  }

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  // A minimal ignore so the host does not try to ship local build output.
  writeFileSync(join(tmp, ".vercelignore"), ["node_modules", ".next", ".git", ".deploy-state.json"].join("\n") + "\n");

  return { dir: tmp };
}

/** Enable `.ts`-extension imports on the deploy copy's tsconfig (the vendored @platform/* source
 *  uses them). Patches an existing tsconfig; if there is none, writes a minimal one Next will
 *  extend. `noEmit` is required for the option and is always correct for a Next app. */
function allowTsExtensions(tsconfigPath: string): void {
  let cfg: { compilerOptions?: Record<string, unknown> } = {};
  if (existsSync(tsconfigPath)) {
    try {
      cfg = JSON.parse(readFileSync(tsconfigPath, "utf8"));
    } catch {
      cfg = {};
    }
  }
  cfg.compilerOptions = cfg.compilerOptions ?? {};
  cfg.compilerOptions.allowImportingTsExtensions = true;
  cfg.compilerOptions.noEmit = true;
  writeFileSync(tsconfigPath, JSON.stringify(cfg, null, 2) + "\n");
}

/** The leading major version from a semver range like "^19.0.0" / "19" / "~18.2". Null if none. */
function majorOf(range: string | undefined): number | null {
  if (!range) return null;
  const m = range.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

/** True if the tree contains any .ts/.tsx source (skipping deps and build output). Shallow-ish
 *  recursive walk, capped so it stays fast on a large app. */
function hasTsSource(dir: string): boolean {
  const SKIP_SCAN = new Set(["node_modules", ".next", ".git", ".vercel", "vendor", "dist", ".turbo"]);
  const stack = [dir];
  let budget = 4000; // plenty for any real app; a hard stop against pathological trees
  while (stack.length && budget-- > 0) {
    const cur = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (SKIP_SCAN.has(name)) continue;
      const full = join(cur, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if ((name.endsWith(".ts") || name.endsWith(".tsx")) && !name.endsWith(".d.ts")) {
        return true;
      }
    }
  }
  return false;
}
