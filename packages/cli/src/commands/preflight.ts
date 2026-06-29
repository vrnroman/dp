/**
 * The build preflight — the deep half of the deployability gate.
 *
 * The static conformance check (in @platform/conformance) answers "does this app have the
 * right shape?" instantly and safely, which is why it can run as a Claude Code hook on every
 * save. But the only way to truly know an app deploys is to BUILD it. Until now the first real
 * build happened on the host (Vercel, or the owner's VM), so a build break was discovered
 * AFTER we had cloned, pushed, and — on personal — created the user's Supabase project. The
 * non-engineer then saw a wall of host build log, not a plain-English reason.
 *
 * This builds the app the same way the host would — a standalone, vendored copy, a clean
 * `npm install`, then the build — in a throwaway directory that never touches the user's app.
 * If it fails, we hand back the part of the build output that actually failed, in plain words,
 * and refuse before a single cloud resource is created. It is deliberately NOT part of the
 * hook or `check`: it installs packages and runs a build, so it is opt-in and runs inside `up`.
 */
import { rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { Manifest } from "@platform/manifest";
import { prepareDeployContext } from "../util/context.ts";
import { Narrator } from "../ui/narrate.ts";

export interface BuildPreflightResult {
  /** false only when the build itself broke (or dependencies would not install). */
  ok: boolean;
  /** false when there was nothing to build (no package.json / no build step). */
  ran: boolean;
  /** plain-English one-liner, suitable to show a non-engineer. */
  summary: string;
  /** the distilled, failing tail of the build output. Present only when ok === false. */
  detail?: string;
}

export interface BuildPreflightOptions {
  /** Coarse progress callback ("Installing the building blocks", "Building your app"). */
  onStep?: (text: string) => void;
  /**
   * Extra environment for the install + build. The build runs before provisioning, so it has
   * none of the values the platform supplies on deploy. Pass `buildTimeEnv(manifest)` so an
   * app that reads its declared env (or DATABASE_URL/SUPABASE_*) at build time sees the same
   * names defined that it would on the host, instead of failing on an undefined variable.
   */
  env?: Record<string, string>;
}

/**
 * The environment a build should see, reconstructed from the manifest before anything is
 * provisioned. Two kinds of value, both present on the real host build:
 *   - the app's own declared secrets (env.required / env.optional) — real values when the
 *     operator has supplied them, a harmless placeholder for a required one they have not (on
 *     a real deploy a required secret is always present, so defining it here is faithful);
 *   - the values the PLATFORM injects on deploy (DATABASE_URL, the SUPABASE_* keys, the auth
 *     secret) — placeholders, because the real ones do not exist until we provision. A build
 *     that only needs these defined will pass; a build that actually connects to them at build
 *     time will still (correctly) fail.
 * Placeholders are never valid credentials, so this can never make a build falsely "work."
 */
export function buildTimeEnv(manifest: Manifest, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  const PLACEHOLDER = "deployctl-build-time-placeholder";

  // Values the platform supplies on deploy. Mirror exactly which ones `up` would set.
  if (manifest.database) {
    env.DATABASE_URL = `postgresql://placeholder:placeholder@127.0.0.1:5432/${manifest.name}`;
  }
  const usesSupabase =
    !!manifest.database || manifest.auth?.tier === "simple" || !!manifest.storage?.buckets?.length;
  if (usesSupabase) {
    env.SUPABASE_URL = "https://placeholder.supabase.co";
    env.SUPABASE_ANON_KEY = PLACEHOLDER;
    env.SUPABASE_SERVICE_ROLE_KEY = PLACEHOLDER;
  }
  // `up` always sets the auth secret, whatever the tier.
  env.PLATFORM_AUTH_SECRET = PLACEHOLDER;

  // The app's own declared secrets win over any placeholder.
  for (const k of manifest.env?.required ?? []) {
    env[k] = source[k] != null ? (source[k] as string) : `${PLACEHOLDER}-${k}`;
  }
  for (const k of manifest.env?.optional ?? []) {
    if (source[k] != null) env[k] = source[k] as string;
  }
  return env;
}

/**
 * Build the app in an isolated copy and report, in plain English, whether it builds.
 * Never throws: any failure becomes a { ok: false } result with a human-readable summary.
 */
export async function buildPreflight(
  appDir: string,
  opts: BuildPreflightOptions = {},
): Promise<BuildPreflightResult> {
  const step = opts.onStep ?? (() => {});

  // Nothing with a package.json means nothing for the platform to build (e.g. a static site).
  if (!existsSync(join(appDir, "package.json"))) {
    return { ok: true, ran: false, summary: "This app has no build step, so there is nothing to build." };
  }

  let ctxDir: string | null = null;
  try {
    // Build EXACTLY what the host would: the standalone, vendored copy, not the workspace app.
    const ctx = prepareDeployContext(appDir);
    ctxDir = ctx.dir;

    const hasBuildScript = (() => {
      try {
        const pkg = JSON.parse(readFileSync(join(ctxDir, "package.json"), "utf8"));
        return typeof pkg.scripts?.build === "string" && pkg.scripts.build.trim().length > 0;
      } catch {
        return false;
      }
    })();

    // 1. Dependencies. We use `npm install` (not `npm ci`): preparing the deploy context
    //    rewrites @platform/* deps to local file: paths, which any copied lockfile would not
    //    match. Keep it quiet and non-interactive.
    step("Gathering the building blocks your app needs");
    const install = await run("npm", ["install", "--no-audit", "--no-fund", "--no-progress"], ctxDir, opts.env);
    if (install.code !== 0) {
      return {
        ok: false,
        ran: true,
        summary: "The app's building blocks could not be gathered, so it cannot be put online yet.",
        detail: distill(install.output),
      };
    }

    if (!hasBuildScript) {
      return {
        ok: true,
        ran: false,
        summary: "The app's building blocks are in place. It has no build step to check.",
      };
    }

    // 2. The build itself — the real test of deployability.
    step("Building your app, the same way the internet will");
    const build = await run("npm", ["run", "build"], ctxDir, opts.env);
    if (build.code !== 0) {
      return {
        ok: false,
        ran: true,
        summary: "Your app did not build, so it would not have come online. Here is the part that failed:",
        detail: distill(build.output),
      };
    }

    return { ok: true, ran: true, summary: "Your app builds cleanly and is ready to go online." };
  } catch (err) {
    return {
      ok: false,
      ran: true,
      summary: "The platform could not check whether your app builds.",
      detail: String((err as Error).message ?? err),
    };
  } finally {
    if (ctxDir) {
      try {
        rmSync(ctxDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

/** Run a command, capturing combined stdout + stderr. Never rejects; inspect .code. */
function run(
  cmd: string,
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      // CI=1 and NO_COLOR make tools terse and free of ANSI escapes, so the distilled error
      // we show a non-engineer is clean text. extraEnv (the reconstructed build-time env) goes
      // last so it overrides anything ambient — e.g. the owner's real DATABASE_URL is replaced
      // by a placeholder, so a build check never touches real infrastructure.
      env: { ...process.env, CI: "1", NO_COLOR: "1", npm_config_audit: "false", npm_config_fund: "false", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const onData = (d: Buffer) => {
      output += d.toString();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
    child.on("error", (err) => resolve({ code: 1, output: output + String(err) }));
  });
}

// Build logs are long and noisy. Keep the lines that actually carry the failure: the tail,
// minus blank lines and npm's own boilerplate, so what we show is the error, not the chatter.
const NOISE = /^(npm warn|npm notice|npm WARN|npm http|added \d+ package|found \d+ vulnerabilit|run `npm|>|\s*$)/;

function distill(output: string): string {
  const lines = output.split("\n").map((l) => l.replace(/\s+$/, ""));
  const meaningful = lines.filter((l) => l.trim().length > 0 && !NOISE.test(l));
  const tail = (meaningful.length ? meaningful : lines.filter((l) => l.trim().length > 0)).slice(-18);
  return tail.join("\n");
}

/** `deployctl preflight [app]` and `deployctl check --build`: static gate + a real build. */
export async function runBuildCheck(appDir: string, manifest: Manifest | null): Promise<number> {
  const n = new Narrator();
  n.start("Checking your app actually builds (this can take a minute)");
  const result = await buildPreflight(appDir, {
    onStep: (t) => n.update(t),
    env: manifest ? buildTimeEnv(manifest) : undefined,
  });
  if (result.ok) {
    n.done(result.summary);
    return 0;
  }
  n.fail(result.summary);
  if (result.detail) process.stdout.write("\n" + result.detail + "\n");
  process.stdout.write("\nFix the problem above and run this again. Nothing was put online.\n");
  return 1;
}
