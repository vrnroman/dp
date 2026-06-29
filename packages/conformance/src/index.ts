/**
 * @platform/conformance — the gate that decides whether an app is shippable.
 *
 * It is deliberately shallow but discriminating: a handful of high-signal checks that
 * catch the things that actually break a deploy or leak a secret, each reported in plain
 * English with a copy-pasteable fix. It never edits the app. The same checker runs in two
 * places: as a Claude Code hook during the build (fast feedback) and inside the platform
 * before a deploy (the real trust boundary, because a hook can be skipped).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { parseManifest, type Manifest } from "@platform/manifest";

export type Level = "error" | "warn";

export interface Finding {
  level: Level;
  where: string;
  problem: string;
  fix: string;
}

export interface CheckReport {
  ok: boolean;
  manifest: Manifest | null;
  passed: string[];
  findings: Finding[];
}

const MANIFEST_FILE = "app.deploy.yaml";
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".vercel", "dist", "build", ".turbo", "coverage", "vendor"]);
// We scan EVERY text file under the app tree for leaked secrets, not an allowlist of folders
// or extensions. A secret is just as dangerous in a .sql migration, a .toml config, or a
// .html file as in a .ts file, and all of those ship. So we invert: read every file (minus
// SKIP_DIRS, lockfiles, and oversized files), and decide binary-vs-text by the file's actual
// bytes, not its name. That way a secret hidden in a file misnamed ".png" is still caught,
// while a real image is skipped.
const NOISE_FILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"]);
const MAX_SCAN_BYTES = 512 * 1024;

// The frameworks the platform knows how to build, and the npm package that proves the app
// actually uses each one. A manifest can SAY `framework: nextjs`, but if `next` is not in the
// dependencies the host build dies with a cryptic "next: command not found" AFTER we have
// already cloned and pushed. We catch that mismatch here, up front, in plain English.
const FRAMEWORK_PACKAGE: Record<string, string> = {
  nextjs: "next",
  vite: "vite",
  remix: "@remix-run/dev",
  astro: "astro",
};

// High-signal secret patterns. A hit is almost always a real leak, not a false positive.
const SECRET_PATTERNS: Array<{ re: RegExp; name: string }> = [
  { re: /postgres(?:ql)?:\/\/[^\s'"`]+:[^\s'"`]+@[^\s'"`]+/i, name: "a database connection string with a password in it" },
  { re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/, name: "what looks like a Supabase or JWT key" },
  { re: /sk-[A-Za-z0-9]{24,}/, name: "what looks like an API secret key" },
  { re: /SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*['"`]eyJ/, name: "a hardcoded service role key" },
];

export function checkApp(appDir: string): CheckReport {
  const findings: Finding[] = [];
  const passed: string[] = [];

  // 1. Manifest must exist and be valid.
  const manifestPath = join(appDir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    findings.push({
      level: "error",
      where: MANIFEST_FILE,
      problem: "This app has no deploy file, so the platform does not know how to ship it.",
      fix: `Add an ${MANIFEST_FILE} at the top of the app with at least 'name:' and 'blueprint:'.`,
    });
    return { ok: false, manifest: null, passed, findings };
  }

  const { manifest, issues } = parseManifest(readFileSync(manifestPath, "utf8"));
  for (const i of issues) {
    findings.push({ level: "error", where: `${MANIFEST_FILE} (${i.path})`, problem: i.problem, fix: i.fix });
  }
  if (!manifest) {
    return { ok: false, manifest: null, passed, findings };
  }
  passed.push("The deploy file is valid.");

  // 2. If a database is declared, the migrations folder must exist.
  if (manifest.database) {
    const migDir = join(appDir, manifest.database.migrations);
    if (!existsSync(migDir) || !statSync(migDir).isDirectory()) {
      findings.push({
        level: "error",
        where: manifest.database.migrations,
        problem: "The app says it uses a database but the migrations folder is missing.",
        fix: `Create the folder '${manifest.database.migrations}' and put your .sql files in it. At least one file that creates your tables.`,
      });
    } else {
      const sql = readdirSync(migDir).filter((f) => f.endsWith(".sql"));
      if (sql.length === 0) {
        findings.push({
          level: "warn",
          where: manifest.database.migrations,
          problem: "The migrations folder is empty, so the database will start with no tables.",
          fix: `Add a .sql file in '${manifest.database.migrations}' that creates the tables your app reads and writes.`,
        });
      } else {
        passed.push(`Found ${sql.length} database migration${sql.length === 1 ? "" : "s"}.`);
      }
    }
  }

  // 3. Source scan: no hardcoded secrets or connection strings.
  const files = collectSource(appDir);
  let leaks = 0;
  for (const file of files) {
    let buf: Buffer;
    try {
      buf = readFileSync(file);
    } catch {
      continue;
    }
    if (isProbablyBinary(buf)) continue;
    const text = buf.toString("utf8");
    for (const { re, name } of SECRET_PATTERNS) {
      const m = text.match(re);
      if (m) {
        leaks++;
        findings.push({
          level: "error",
          where: relative(appDir, file),
          problem: `This file contains ${name}. Secrets in code get published with the app and can be stolen.`,
          fix: `Remove the secret from the code. Read it from process.env instead, and let the platform supply it. For the database, use process.env.DATABASE_URL.`,
        });
      }
    }
  }
  if (leaks === 0) passed.push("No secrets are hardcoded in the app.");

  // 4. Standard surface: a web app with a database should read DATABASE_URL, not invent its own.
  if (manifest.blueprint === "web" && manifest.database) {
    const usesEnv = files.some((f) => {
      try {
        return /process\.env\.DATABASE_URL/.test(readFileSync(f, "utf8"));
      } catch {
        return false;
      }
    });
    if (!usesEnv) {
      findings.push({
        level: "warn",
        where: "(source)",
        problem: "The app declares a database but never reads process.env.DATABASE_URL.",
        fix: "Connect to the database using process.env.DATABASE_URL so the platform can point the app at the right database.",
      });
    } else {
      passed.push("The app reads its database connection from the environment.");
    }
  }

  // 5. Build sanity for web: there must be a build script.
  if (manifest.blueprint === "web") {
    const pkgPath = join(appDir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (!pkg.scripts?.build) {
          findings.push({
            level: "warn",
            where: "package.json",
            problem: "There is no 'build' script, so the platform may not know how to build the app.",
            fix: 'Add a "build" script to package.json. For Next.js that is "build": "next build".',
          });
        } else {
          passed.push("The app has a build script.");
        }
      } catch {
        findings.push({
          level: "error",
          where: "package.json",
          problem: "package.json is not valid JSON.",
          fix: "Fix the formatting in package.json so it is valid JSON.",
        });
      }
    }
  }

  // 6. Template shape: a web app must match a framework the platform can build, and that
  //    framework's package must actually be installed. This is the difference between a clean
  //    up-front refusal and a cryptic host build failure discovered after the fact.
  if (manifest.blueprint === "web") {
    const deps = readDeps(appDir);
    const declared = manifest.web?.framework;
    if (declared) {
      const pkgName = FRAMEWORK_PACKAGE[declared];
      if (pkgName && deps && !deps.has(pkgName)) {
        findings.push({
          level: "error",
          where: "package.json",
          problem: `The deploy file says this is a ${declared} app, but "${pkgName}" is not in package.json, so the platform cannot build it.`,
          fix: `Add ${pkgName} to the app (run \`npm install ${pkgName}\`), or change web.framework in app.deploy.yaml to the framework the app actually uses (${Object.keys(FRAMEWORK_PACKAGE).join(", ")}).`,
        });
      } else if (pkgName) {
        passed.push(`This is a ${declared} app and ${pkgName} is installed.`);
      }
    } else {
      // No framework named: try to detect one so the platform knows how to build it.
      const detected = deps && Object.entries(FRAMEWORK_PACKAGE).find(([, p]) => deps.has(p))?.[0];
      if (detected) {
        passed.push(`Detected a ${detected} app, which the platform knows how to build.`);
      } else {
        findings.push({
          level: "warn",
          where: "app.deploy.yaml",
          problem: "This is a web app but it does not name a framework and the platform could not detect one, so it may not know how to build it.",
          fix: `Add 'web:' then 'framework: nextjs' to app.deploy.yaml (or vite, remix, astro), and make sure that framework is installed.`,
        });
      }
    }
  }

  const ok = findings.every((f) => f.level !== "error");
  return { ok, manifest, passed, findings };
}

/** Read the union of dependencies + devDependencies from package.json, or null if there is
 *  no readable package.json. Used to confirm a declared framework is actually present. */
function readDeps(appDir: string): Set<string> | null {
  const pkgPath = join(appDir, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
  } catch {
    return null;
  }
}

function collectSource(appDir: string): string[] {
  const out: string[] = [];
  walk(appDir, out);
  return out;
}

function walk(dir: string, out: string[]): void {
  for (const entry of safeReaddir(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSafe(full);
    if (!st) continue;
    if (st.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (NOISE_FILES.has(entry)) continue;
    if (st.size > MAX_SCAN_BYTES) continue;
    out.push(full);
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
function statSafe(p: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/**
 * Decide whether a file is binary by looking at its bytes, not its name. A NUL byte, or a
 * high share of control characters in the first few KB, means binary (a real image or font);
 * we skip those. Everything else is treated as text and scanned, so a secret hidden in a
 * file misnamed ".png" is still read.
 */
function isProbablyBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  if (n === 0) return false;
  let control = 0;
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 0) return true; // a NUL byte is the clearest binary signal
    // Tab (9), LF (10), CR (13) are fine; other low control chars are suspicious. Bytes
    // >= 32 (including high-bit UTF-8 continuation bytes) are treated as text.
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) control++;
  }
  return control / n > 0.3;
}

/** Render a report as plain-English terminal text. Used by the CLI and the hooks. */
export function renderReport(report: CheckReport, appLabel: string): string {
  const lines: string[] = [];
  if (report.ok && report.findings.length === 0) {
    lines.push(`Your app "${appLabel}" is ready to deploy.`);
    for (const p of report.passed) lines.push(`  ok   ${p}`);
    return lines.join("\n");
  }

  const errors = report.findings.filter((f) => f.level === "error");
  const warns = report.findings.filter((f) => f.level === "warn");

  if (errors.length) {
    lines.push(`Your app "${appLabel}" is not ready to deploy yet. Here is what to fix:`);
    lines.push("");
    errors.forEach((f, i) => {
      lines.push(`  ${i + 1}. ${f.problem}`);
      lines.push(`     Where: ${f.where}`);
      lines.push(`     Fix:   ${f.fix}`);
      lines.push("");
    });
  } else {
    lines.push(`Your app "${appLabel}" can deploy. A couple of things are worth a look:`);
    lines.push("");
  }

  if (warns.length) {
    lines.push(errors.length ? "Worth a look too:" : "");
    warns.forEach((f) => {
      lines.push(`  - ${f.problem}`);
      lines.push(`    Fix: ${f.fix}`);
    });
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}
