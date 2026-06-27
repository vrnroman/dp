import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { checkApp, renderReport } from "@platform/conformance";
import type { Manifest } from "@platform/manifest";
import { loadTokens } from "../util/env.ts";
import { readState, writeState, type DeployState } from "../util/state.ts";
import { prepareDeployContext } from "../util/context.ts";
import { Narrator } from "../ui/narrate.ts";
import { printReceipt, printTerminalQR, writeCard } from "../ui/receipt.ts";
import * as supabase from "../providers/supabase.ts";
import * as vercel from "../providers/vercel.ts";
import { runMigrations, seedAllowlist, canConnect } from "../providers/postgres.ts";

export interface UpOptions {
  dryRun?: boolean;
}

export async function runUp(appDirArg: string, opts: UpOptions): Promise<number> {
  const appDir = resolve(appDirArg || ".");

  // The trust boundary. Even if a hook already checked, the platform checks again.
  const report = checkApp(appDir);
  if (!report.ok) {
    process.stdout.write(renderReport(report, report.manifest?.name ?? "your app") + "\n");
    process.stdout.write("\nThe app is not ready to deploy yet. Fix the items above and run this again.\n");
    return 1;
  }
  const manifest = report.manifest as Manifest;

  if (manifest.blueprint !== "web") {
    process.stdout.write(
      `This version of the platform can deploy "web" apps. "${manifest.blueprint}" apps are coming.\n`,
    );
    return 1;
  }
  const slug = manifest.name;
  const appName = titleCase(slug);

  // Check required secrets up front, before creating anything.
  const required = manifest.env?.required ?? [];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    process.stdout.write(
      `This app needs ${missing.length === 1 ? "a secret" : "some secrets"} before it can go live: ${missing.join(", ")}.\n` +
        `Set ${missing.length === 1 ? "it" : "them"} in your environment and run this again. For example: export ${missing[0]}=...\n`,
    );
    return 1;
  }

  const tokens = loadTokens();
  const acct = await vercel.account(tokens.vercelToken);
  const ownerEmail = acct.email;
  const members = (manifest.auth?.allowlist ?? []).filter(
    (e) => e.trim().toLowerCase() !== ownerEmail.toLowerCase(),
  );
  const peopleCount = 1 + members.length;

  if (opts.dryRun) {
    printPlan(manifest, slug, ownerEmail, peopleCount, tokens.supabaseRegion);
    return 0;
  }

  let state: DeployState = readState(appDir) ?? {
    appName,
    slug,
    createdAt: new Date().toISOString(),
  };

  const n = new Narrator();
  try {
    // 1. Database
    n.start("Setting up where your data lives");
    if (!state.supabase) {
      const orgId = await supabase.firstOrgId(tokens.supabaseAccessToken);
      const dbPassword = randomBytes(18).toString("base64url");
      const created = await supabase.createProject(tokens.supabaseAccessToken, {
        name: slug,
        orgId,
        region: tokens.supabaseRegion,
        dbPass: dbPassword,
      });
      state.supabase = { ref: created.ref, region: created.region, dbPassword };
      writeState(appDir, state);
    }
    n.update("Waiting for your database to come online (this takes a couple of minutes)");
    await supabase.waitHealthy(tokens.supabaseAccessToken, state.supabase.ref, (status) =>
      n.update(`Getting your database ready (${humanStatus(status)})`),
    );
    const keys = await supabase.getKeys(tokens.supabaseAccessToken, state.supabase.ref);
    n.done("Your database is ready");

    // The allowlist for simple-auth also lives in Postgres, so we need a working connection
    // whenever the app has a database OR simple sign-in. Find the right pooler cluster by
    // actually connecting (DNS cannot tell the clusters apart).
    const needsDb = !!manifest.database || manifest.auth?.tier === "simple";
    let dbUrl: string | null = null;
    if (needsDb) {
      n.start("Connecting to your database");
      for (const candidate of supabase.poolerCandidates(state.supabase.ref, state.supabase.region, state.supabase.dbPassword)) {
        if (await canConnect(candidate.url)) {
          dbUrl = candidate.url;
          state.supabase.poolerHost = candidate.host;
          writeState(appDir, state);
          break;
        }
      }
      if (!dbUrl) {
        throw new Error(
          "The database is up but the platform could not connect to it. This is usually temporary; wait a minute and run this again.",
        );
      }
      n.done("Connected to your database");
    }

    // Always have a stable session secret, whatever the auth tier, so re-runs do not
    // invalidate existing sessions.
    if (!state.authSecret) {
      state.authSecret = randomBytes(32).toString("base64url");
      writeState(appDir, state);
    }

    // 2. Tables (only when the app actually declares a database)
    if (manifest.database) {
      n.start("Creating your tables");
      const migReport = await runMigrations(dbUrl as string, join(appDir, manifest.database.migrations));
      n.done(
        migReport.applied.length
          ? `Your tables are ready (${migReport.applied.length} set up)`
          : "Your tables were already in place",
      );
    }

    // 3. Front door (auth)
    if (manifest.auth?.tier === "simple") {
      n.start("Putting up the front door");
      await seedAllowlist(dbUrl as string, ownerEmail, members);
      n.done(`Front door ready. ${peopleCount} ${peopleCount === 1 ? "person" : "people"} can get in for now`);
    }

    // 4. Storage
    if (manifest.storage?.buckets?.length) {
      n.start("Setting up photo storage");
      for (const bucket of manifest.storage.buckets) {
        await supabase.ensurePublicBucket(supabase.projectUrl(state.supabase.ref), keys.serviceRole, bucket);
      }
      n.done("Storage ready");
    }

    // 5. Web home (Vercel project + settings)
    n.start("Giving your app a home on the web");
    const proj = await vercel.ensureProject(tokens.vercelToken, { name: slug, rootDirectory: "" });
    state.vercel = { projectId: proj.id, orgId: acct.id };
    writeState(appDir, state);

    const envVars: Record<string, string> = {
      SUPABASE_URL: supabase.projectUrl(state.supabase.ref),
      SUPABASE_ANON_KEY: keys.anon,
      SUPABASE_SERVICE_ROLE_KEY: keys.serviceRole,
      PLATFORM_AUTH_SECRET: state.authSecret,
    };
    if (dbUrl) envVars.DATABASE_URL = dbUrl;
    for (const k of required) envVars[k] = process.env[k] as string;
    for (const k of manifest.env?.optional ?? []) if (process.env[k]) envVars[k] = process.env[k] as string;
    await vercel.setEnv(tokens.vercelToken, proj.id, envVars);
    n.done("Web home ready");

    // 6. Build and ship
    n.start("Sending your app live (building and shipping, about a minute)");
    const ctx = prepareDeployContext(appDir);
    vercel.linkProject(ctx.dir, proj.id, acct.id);
    const outcome = await vercel.deploy(tokens.vercelToken, ctx.dir);
    state.url = outcome.url;
    writeState(appDir, state);
    n.done("Your app is live");

    // 7. The Deed
    const info = {
      appName,
      slug,
      url: outcome.url,
      ownerEmail,
      peopleCount,
      hasDatabase: !!manifest.database,
      hasStorage: !!manifest.storage?.buckets?.length,
    };
    printReceipt(info);
    await printTerminalQR(outcome.url);
    const cardPath = await writeCard(appDir, info);
    process.stdout.write(`\n  I saved a card you can open or share: ${cardPath}\n\n`);
    return 0;
  } catch (err) {
    n.fail("Something stopped the deploy");
    process.stdout.write(`\n${(err as Error).message}\n`);
    process.stdout.write(
      `\nNothing is half-broken. Fix the issue above and run this again; the platform reuses what it already set up.\n`,
    );
    return 1;
  }
}

function printPlan(
  manifest: Manifest,
  slug: string,
  ownerEmail: string,
  peopleCount: number,
  region: string,
): void {
  const lines = [
    `Here is what deploying "${titleCase(slug)}" will do. Nothing has happened yet.`,
    "",
    `  Give your app a home on the web at a ${slug}.vercel.app address.`,
  ];
  if (manifest.database) lines.push(`  Create your own database and set up your tables.`);
  if (manifest.auth?.tier === "simple")
    lines.push(`  Put up a front door. ${peopleCount} ${peopleCount === 1 ? "person" : "people"} can get in (you are the owner: ${ownerEmail}).`);
  if (manifest.storage?.buckets?.length) lines.push(`  Set up storage for photos and files.`);
  lines.push("");
  lines.push(`  Everything runs on the free tier in ${region}. Run without --dry-run to do it for real.`);
  process.stdout.write(lines.join("\n") + "\n");
}

function humanStatus(status: string): string {
  switch (status) {
    case "ACTIVE_HEALTHY":
      return "ready";
    case "COMING_UP":
    case "PROVISIONING":
    case "RESTORING":
      return "starting up";
    case "INACTIVE":
      return "waking up";
    default:
      return "starting up";
  }
}

function titleCase(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}
