import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { checkApp, renderReport } from "@platform/conformance";
import { review, type Review } from "@platform/compliance";
import type { Manifest } from "@platform/manifest";
import { buildPreflight, buildTimeEnv } from "./preflight.ts";
import { loadTokens } from "../util/env.ts";
import { readState, writeState, type DeployState } from "../util/state.ts";
import { prepareDeployContext } from "../util/context.ts";
import { Narrator } from "../ui/narrate.ts";
import { printReceipt, printTerminalQR, writeCard } from "../ui/receipt.ts";
import * as supabase from "../providers/supabase.ts";
import * as vercel from "../providers/vercel.ts";
import { runMigrations, seedAllowlist, ensureGroupsTables, canConnect } from "../providers/postgres.ts";
import { vmConfig, pickPort, deployToVm, waitForPublic } from "../providers/gcp-vm.ts";

export interface UpOptions {
  dryRun?: boolean;
  /** Skip the real build that runs before provisioning. The host will still build it. */
  skipBuildCheck?: boolean;
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

  // The compliance gate: "*may* this ship?", on top of the deployability gate's "*can* it?".
  // It runs EARLY (before we spend a minute building, let alone provision) because refusing on
  // policy should be the first thing that happens, not the last. It is fail-closed: a "blocked"
  // verdict never deploys; a "needs-review" verdict (an unapproved external service, personal
  // data with no sign-in, a powerful capability) needs a person's OK first, which arrives either
  // as DP_COMPLIANCE_APPROVED=1 (the portal, after the user approved the list in the browser) or
  // an interactive y/N here; anything non-interactive and unapproved is refused, never hung on.
  // DP_SKIP_REVIEW=1 is the owner's own escape hatch (the portal must never set it).
  if (!opts.dryRun && process.env.DP_SKIP_REVIEW !== "1") {
    const gate = await complianceGate(appDir, manifest);
    if (gate !== null) return gate;
  }

  // The deployability gate's deep half: actually build the app in a throwaway copy BEFORE a
  // single cloud resource is created. A build break becomes a plain-English refusal here,
  // instead of a cryptic host build failure discovered after we have provisioned (and, on
  // personal, created the user's Supabase project). Skipped on a dry run or when opted out.
  const skipBuild = opts.skipBuildCheck || process.env.DP_SKIP_BUILD_CHECK === "1";
  if (!opts.dryRun && !skipBuild) {
    const bn = new Narrator();
    bn.start("Making sure your app builds before anything goes live (this can take a minute)");
    // Build with the same env names the host would have — the app's declared secrets (real if
    // supplied) plus placeholders for what the platform injects on deploy — so a build that
    // reads env at build time does not fail here on an undefined variable.
    const build = await buildPreflight(appDir, { onStep: (t) => bn.update(t), env: buildTimeEnv(manifest) });
    if (!build.ok) {
      bn.fail(build.summary);
      if (build.detail) process.stdout.write("\n" + build.detail + "\n");
      process.stdout.write("\nNothing was put online. Fix the problem above and run this again.\n");
      return 1;
    }
    if (build.ran) bn.done(build.summary);
    else bn.done();
  }

  // The org profile deploys onto the owner's own machine (a GCP VM), not Vercel/Supabase.
  // It is its own self-contained path; everything below this point is personal-only.
  //
  // Routing is decided here, and a caller can FORCE it via DP_FORCE_PROFILE regardless of what
  // the app's manifest says. The portal sets DP_FORCE_PROFILE=personal so an untrusted repo can
  // never route itself onto the owner's VM by writing `profile: org` (in any YAML spelling).
  const resolvedProfile = process.env.DP_FORCE_PROFILE ?? manifest.profile ?? "personal";
  if (resolvedProfile === "org") {
    return await runUpOrg(appDir, manifest, slug, appName, opts);
  }

  // Loading tokens can refuse (no Vercel token supplied). Catch it so the user gets a plain
  // message instead of an uncaught stack trace, the same way the account check below does.
  let tokens: ReturnType<typeof loadTokens>;
  try {
    tokens = loadTokens();
  } catch (err) {
    process.stdout.write(`${(err as Error).message}\nNothing was put online.\n`);
    return 1;
  }
  // The Vercel token is the first thing every personal deploy needs. Check it here, gracefully,
  // so a wrong or expired token (a non-engineer pasting it into the portal) gets a plain message
  // instead of a stack trace.
  let acct: Awaited<ReturnType<typeof vercel.account>>;
  try {
    acct = await vercel.account(tokens.vercelToken);
  } catch (err) {
    process.stdout.write(
      `That Vercel token did not work, so the app cannot go live on Vercel yet.\n${(err as Error).message}\nDouble-check the token and try again.\n`,
    );
    return 1;
  }
  const ownerEmail = acct.email;
  // With Google sign-in, the owner is recognized by their GOOGLE email, which can differ from the
  // Vercel account email (e.g. Vercel-via-GitHub, or a work email). Let the owner name it so they
  // are never locked out of their own app; default to the Vercel email as the best guess.
  const identityOwnerEmail = (process.env.GOOGLE_OWNER_EMAIL || ownerEmail).trim().toLowerCase();
  const members = (manifest.auth?.allowlist ?? []).filter(
    (e) => e.trim().toLowerCase() !== identityOwnerEmail.toLowerCase(),
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
    // Supabase is only needed when the app actually uses it: a database, simple sign-in (its
    // allowlist lives in Postgres), or storage. A plain web app with no sign-in goes straight
    // to Vercel, so we never provision (or count against the user's quota for) a database it
    // would never touch.
    const usesSupabase =
      !!manifest.database ||
      manifest.auth?.tier === "simple" ||
      manifest.auth?.tier === "proper" ||
      !!manifest.storage?.buckets?.length;
    if (usesSupabase && !tokens.supabaseAccessToken) {
      throw new Error(
        "This app needs a database, sign-in, or storage, which run on Supabase, but no Supabase access token was provided.",
      );
    }

    let keys: { anon: string; serviceRole: string } | null = null;
    let dbUrl: string | null = null;

    if (usesSupabase) {
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
      keys = await supabase.getKeys(tokens.supabaseAccessToken, state.supabase.ref);
      n.done("Your database is ready");

      // The allowlist for simple-auth also lives in Postgres, so we need a working connection
      // whenever the app has a database OR simple sign-in. Find the right pooler cluster by
      // actually connecting (DNS cannot tell the clusters apart).
      const needsDb =
        !!manifest.database || manifest.auth?.tier === "simple" || manifest.auth?.tier === "proper";
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
    } else if (manifest.auth?.tier === "proper") {
      // Google sign-in. The owner (this Vercel account) is recognized as owner; the platform's
      // groups/people machinery lives in the app's own database. Open signup lets anyone in with
      // the default role; invite signup limits it to the allowlist.
      const openSignup = manifest.auth?.signup !== "invite";
      n.start("Putting up the front door (Google sign-in)");
      await ensureGroupsTables(dbUrl as string);
      // Seed the owner (by their Google identity email) plus, in invite mode, the allowlist.
      await seedAllowlist(dbUrl as string, identityOwnerEmail, openSignup ? [] : members);
      n.done(
        openSignup
          ? "Front door ready. Anyone can sign in with Google; you decide what each person can do."
          : `Front door ready. ${peopleCount} ${peopleCount === 1 ? "person" : "people"} can sign in with Google for now.`,
      );
    }

    // 4. Storage
    if (manifest.storage?.buckets?.length) {
      n.start("Setting up photo storage");
      for (const bucket of manifest.storage.buckets) {
        await supabase.ensurePublicBucket(supabase.projectUrl(state.supabase!.ref), keys!.serviceRole, bucket);
      }
      n.done("Storage ready");
    }

    // 5. Web home (Vercel project + settings)
    n.start("Giving your app a home on the web");
    const proj = await vercel.ensureProject(tokens.vercelToken, { name: slug, rootDirectory: "" });
    state.vercel = { projectId: proj.id, orgId: acct.id };
    writeState(appDir, state);

    const envVars: Record<string, string> = {
      PLATFORM_AUTH_SECRET: state.authSecret,
    };
    if (usesSupabase && keys && state.supabase) {
      envVars.SUPABASE_URL = supabase.projectUrl(state.supabase.ref);
      envVars.SUPABASE_ANON_KEY = keys.anon;
      envVars.SUPABASE_SERVICE_ROLE_KEY = keys.serviceRole;
    }
    if (dbUrl) envVars.DATABASE_URL = dbUrl;

    // Google sign-in (proper tier). Two ways it can be wired, in priority order:
    //  1. RELAY (zero setup): if a platform auth relay is configured (DP_RELAY_URL + admin token),
    //     the deploy registers this app's origin with the relay and injects the relay URL + its
    //     PUBLIC key. The app signs people in THROUGH the relay, so no Google-console step is ever
    //     needed per app, and the Google client SECRET never touches this app's env.
    //  2. DIRECT: otherwise the app talks to Google itself with an injected client id/secret (which
    //     needs the app's callback registered in the Google console once).
    let googleMissing = false;
    let relayActive = false;
    if (manifest.auth?.tier === "proper") {
      envVars.PLATFORM_OWNER_EMAIL = identityOwnerEmail;
      envVars.PLATFORM_SIGNUP_MODE = manifest.auth?.signup === "invite" ? "invite" : "open";
      if (manifest.auth?.roles?.length) envVars.PLATFORM_ROLES = JSON.stringify(manifest.auth.roles);
      if (manifest.auth?.default) envVars.PLATFORM_DEFAULT_ROLE = manifest.auth.default;

      const appUrl = (process.env.GOOGLE_BASE_URL || `https://${slug}.vercel.app`).replace(/\/+$/, "");
      const relayBase = (process.env.DP_RELAY_URL || "").replace(/\/+$/, "");
      const relayAdmin = process.env.DP_RELAY_ADMIN_TOKEN || "";
      if (relayBase && relayAdmin) {
        const pub = await relaySetup(relayBase, relayAdmin, appUrl, {
          declaredRoles: manifest.auth?.roles ?? [],
          defaultRole: manifest.auth?.default ?? null,
          ownerEmail: identityOwnerEmail,
        });
        if (pub) {
          envVars.PLATFORM_AUTH_RELAY_URL = relayBase;
          envVars.PLATFORM_RELAY_PUBLIC_KEY = pub;
          envVars.PLATFORM_RELAY_ISSUER = process.env.DP_RELAY_ISSUER || "dp-relay";
          // Do NOT pin PLATFORM_APP_ORIGIN to the guessed slug: the app derives its origin from the
          // actual request host at runtime, so the relay hand-back lands on the SAME host the cookie
          // was set on (works even if Vercel assigned a different production domain). We still
          // register the best deploy-time guess (or GOOGLE_BASE_URL); a mismatch fails loud at the
          // relay (not-registered) rather than silently on a missing cookie.
          relayActive = true;
          // Remember what we registered so `down` can deregister it (a freed origin must not keep
          // getting valid identity assertions if someone else later claims that subdomain).
          state.relay = { origin: appUrl, url: relayBase };
          writeState(appDir, state);
        }
      }
      if (!relayActive) {
        // Direct-Google fallback. Pin the callback origin only when the owner named a custom domain.
        if (process.env.GOOGLE_BASE_URL) envVars.PLATFORM_BASE_URL = process.env.GOOGLE_BASE_URL.replace(/\/+$/, "");
        if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
          envVars.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
          envVars.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
        } else {
          googleMissing = true;
        }
      }
    }

    for (const k of required) envVars[k] = process.env[k] as string;
    for (const k of manifest.env?.optional ?? []) if (process.env[k]) envVars[k] = process.env[k] as string;
    await vercel.setEnv(tokens.vercelToken, proj.id, envVars);
    n.done("Web home ready");
    if (manifest.auth?.tier === "proper" && relayActive) {
      process.stdout.write(
        `\n  Sign-in is on. People sign in with Google automatically through the platform, with no\n` +
          `  setup on your side. You are the owner as ${identityOwnerEmail}.\n\n`,
      );
    } else if (manifest.auth?.tier === "proper") {
      const callback = `${(process.env.GOOGLE_BASE_URL || `https://${slug}.vercel.app`).replace(/\/+$/, "")}/auth/google/callback`;
      if (googleMissing) {
        process.stdout.write(
          `\n  One more step to turn on sign-in: add your Google keys. At\n` +
            `  https://console.cloud.google.com/apis/credentials create an OAuth client and add this\n` +
            `  exact "Authorized redirect URI":\n` +
            `    ${callback}\n` +
            `  (if your live address is not ${slug}.vercel.app, register that one, or set GOOGLE_BASE_URL).\n` +
            `  Then set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET and run this again. You are the owner\n` +
            `  as ${identityOwnerEmail} (set GOOGLE_OWNER_EMAIL if you sign in with a different Google\n` +
            `  account). Until then the app is live but "Continue with Google" will not sign anyone in.\n\n`,
        );
      } else {
        process.stdout.write(
          `\n  Google sign-in is on. Make sure this exact redirect URI is registered in your Google\n` +
            `  OAuth client: ${callback}\n` +
            `  You are the owner as ${identityOwnerEmail}.\n\n`,
        );
      }
    }

    // 6. Build and ship
    n.start("Sending your app live (building and shipping, about a minute)");
    const ctx = prepareDeployContext(appDir);
    vercel.linkProject(ctx.dir, proj.id, acct.id);
    // Vercel knows the address before the build finishes, so announce it early. The portal
    // picks this up and shows the link straight away, marked as going live.
    const outcome = await vercel.deploy(tokens.vercelToken, ctx.dir, (url) => {
      n.update(`Your address is ${url} (it goes live the moment the build finishes)`);
    });
    state.url = outcome.url;
    writeState(appDir, state);

    // Relay mode: register the ACTUAL production origin now that we know it. Vercel can assign a
    // suffixed domain (e.g. <slug>-five.vercel.app), so the deploy-time guess is often wrong; the
    // app derives its origin from the request, so the relay must have the real one allowlisted or
    // sign-in would fail closed. Best-effort, and it updates the record `down` deregisters.
    if (relayActive && outcome.url) {
      const relayBase = (process.env.DP_RELAY_URL || "").replace(/\/+$/, "");
      const adminToken = process.env.DP_RELAY_ADMIN_TOKEN || "";
      if (relayBase && adminToken) {
        try {
          const realOrigin = new URL(outcome.url).origin;
          await fetch(`${relayBase}/auth/relay/register`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
            body: JSON.stringify({
              origin: realOrigin,
              declaredRoles: manifest.auth?.roles ?? [],
              defaultRole: manifest.auth?.default ?? null,
              ownerEmail: identityOwnerEmail,
            }),
            signal: AbortSignal.timeout(8000),
          });
          state.relay = { origin: realOrigin, url: relayBase };
          writeState(appDir, state);
        } catch {
          /* the deploy-time guess is already registered; a mismatch is surfaced by the app if any */
        }
      }
    }
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

/**
 * The org profile: deploy onto the owner's own Google Cloud VM. No Vercel, no Supabase.
 * The app becomes a systemd service behind Caddy at <slug>.<vm-ip>.sslip.io, with HTTPS.
 * v1 ships DB-less web/static apps; a database (Cloud SQL) and a login gate come next.
 */
async function runUpOrg(
  appDir: string,
  manifest: Manifest,
  slug: string,
  appName: string,
  opts: UpOptions,
): Promise<number> {
  const cfg = vmConfig();
  const hostname = `${slug}.${cfg.baseDomain}`;

  if (manifest.database) {
    process.stdout.write(
      `The org profile can deploy apps without a database for now. "${slug}" declares a database, which is coming to this profile next.\n`,
    );
    return 1;
  }

  // v1 of the org profile serves apps openly (anyone with the link). It does not yet stand
  // up a sign-in, so refuse rather than deploy a "private" app wide open while telling the
  // owner it is gated.
  if (manifest.auth && manifest.auth.tier && manifest.auth.tier !== "none") {
    process.stdout.write(
      `The org profile can't add a sign-in yet, so it would put "${slug}" online open to anyone with the link.\n` +
        `Your app asks for a "${manifest.auth.tier}" sign-in. Set auth tier to none to deploy it openly here, or use the personal profile, which has sign-in. A sign-in for this profile is coming next.\n`,
    );
    return 1;
  }

  // v1 cannot deliver secret keys to the VM, so an app that needs one would crash there.
  // Refuse up front instead of failing halfway.
  const requiredEnv = manifest.env?.required ?? [];
  if (requiredEnv.length) {
    process.stdout.write(
      `The org profile can't hand secret keys to an app yet, and "${slug}" needs ${requiredEnv.join(", ")}.\n` +
        `That is coming next. For now, deploy apps that need no secrets here, or use the personal profile.\n`,
    );
    return 1;
  }

  if (opts.dryRun) {
    const lines = [
      `Here is what deploying "${appName}" to your own Google Cloud will do. Nothing has happened yet.`,
      "",
      `  Put your app on your VM "${cfg.instance}" (project ${cfg.project}).`,
      `  Run it as its own background service, started automatically and kept alive.`,
      `  Give it a web address with HTTPS at https://${hostname}.`,
      "",
      `  It reuses the machine you already pay for. Run without --dry-run to do it for real.`,
    ];
    process.stdout.write(lines.join("\n") + "\n");
    return 0;
  }

  if (!existsSync(join(appDir, "package.json"))) {
    process.stdout.write(
      `The org profile needs an app with a package.json and a "start" script that listens on the PORT it is given. "${slug}" has no package.json.\n`,
    );
    return 1;
  }

  let state: DeployState = readState(appDir) ?? {
    appName,
    slug,
    createdAt: new Date().toISOString(),
  };

  const n = new Narrator();
  const narrateLine = (line: string) => {
    const m = line.match(/^DP>\s?(.*)/);
    if (m) n.update(humanizeOrg(m[1]));
  };

  try {
    n.start("Packing your app to send to your machine");
    const ctx = prepareDeployContext(appDir);
    n.done("Packed your app");

    const port = await pickPort(cfg, state.gcpVm?.port);

    n.start("Sending your app to your own Google Cloud and starting it");
    const result = await deployToVm({ ctxDir: ctx.dir, slug, port, onLine: narrateLine });
    state.gcpVm = {
      instance: cfg.instance,
      project: cfg.project,
      zone: cfg.zone,
      port: result.port,
      service: result.service,
      appDir: result.appDir,
      hostname: result.hostname,
    };
    state.url = result.url;
    writeState(appDir, state);
    n.done("Your app is installed and running on your machine");

    n.start("Knocking on the door to make sure it answers (HTTPS can take a moment)");
    const live = await waitForPublic(result.url, narrateLine);
    if (!live) {
      n.fail("It is running, but the public address did not answer yet");
      process.stdout.write(
        `\nYour app is installed and running on your machine, but ${result.url} did not return a page yet.\n` +
          `This is almost always the HTTPS certificate still being issued. Give it a minute and open it; if it stays down, run this again.\n`,
      );
      return 1;
    }
    n.done("It answered. Your app is live.");

    const info = {
      appName,
      slug,
      url: result.url,
      ownerEmail: "",
      peopleCount: 1,
      hasDatabase: false,
      hasStorage: false,
      open: manifest.auth?.tier !== "simple",
    };
    printReceipt(info);
    await printTerminalQR(result.url);
    const cardPath = await writeCard(appDir, info);
    process.stdout.write(`\n  I saved a card you can open or share: ${cardPath}\n\n`);
    return 0;
  } catch (err) {
    n.fail("Something stopped the deploy");
    process.stdout.write(`\n${(err as Error).message}\n`);
    return 1;
  }
}

/** Turn the VM script's terse progress lines into the platform's warm, plain-English voice. */
function humanizeOrg(line: string): string {
  if (/installing dependencies/i.test(line)) return "Setting your app up on the machine";
  if (/^building/i.test(line)) return "Building your app";
  if (/answered locally/i.test(line)) return "Your app started";
  if (/placing the app/i.test(line)) return "Unpacking your app on the machine";
  if (/writing service/i.test(line)) return "Giving your app a permanent home";
  if (/per-app Caddy includes/i.test(line)) return "Preparing the front door";
  if (/the door answered/i.test(line)) return "The door answered";
  if (/knocking on the door/i.test(line)) return "Knocking on the door…";
  if (/front door/i.test(line)) return "Checking the front door is healthy";
  return line;
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
  if (manifest.auth?.tier === "proper")
    lines.push(
      manifest.auth?.signup === "invite"
        ? `  Put up a Google sign-in. Only the people you invite can get in (you are the owner: ${ownerEmail}).`
        : `  Put up a Google sign-in. Anyone can sign in; you decide what each person can do (you are the owner: ${ownerEmail}).`,
    );
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

/**
 * Register an app's origin with the platform auth relay and fetch the relay's public key, so the
 * app can sign people in through the relay with no per-app Google setup. Best-effort: returns the
 * relay's public-key JWK (as a JSON string) on success, or null to fall back to direct-Google.
 */
async function relaySetup(
  relayBase: string,
  adminToken: string,
  appOrigin: string,
  appInfo?: { declaredRoles?: unknown; defaultRole?: string | null; ownerEmail?: string },
): Promise<string | null> {
  try {
    const reg = await fetch(`${relayBase}/auth/relay/register`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      // The app's declared roles / default / owner ride along so the relay's central store knows
      // what this app offers and the owner's groups screen can map groups to its roles.
      body: JSON.stringify({ origin: appOrigin, ...(appInfo || {}) }),
      signal: AbortSignal.timeout(8000),
    });
    if (!reg.ok) return null;
    const pk = await fetch(`${relayBase}/auth/relay/pubkey`, { signal: AbortSignal.timeout(8000) });
    if (!pk.ok) return null;
    const text = (await pk.text()).trim();
    const parsed = JSON.parse(text) as { kid?: string };
    if (!parsed || typeof parsed !== "object" || !parsed.kid) return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * The compliance gate. Returns null to let the deploy proceed, or an exit code to stop it.
 * Deterministic facts + verdict only (no AI brief) — the gate must be fast and never depend on a
 * model being reachable. Fail-closed on every uncertain path.
 */
export async function complianceGate(appDir: string, manifest: Manifest): Promise<number | null> {
  let result: Review;
  try {
    result = await review(appDir, manifest, { skipBrief: true });
  } catch (err) {
    // If the review itself cannot run, we do not know whether the app is allowed — so we refuse.
    process.stdout.write(
      `The safety review could not run, so nothing was deployed.\n${(err as Error).message}\n` +
        `This is unusual. Try again; if it keeps failing, something is wrong with the app files.\n`,
    );
    return 1;
  }
  const { verdict } = result;

  if (verdict.decision === "blocked") {
    process.stdout.write("This app can't be put online as-is. The platform's rules do not allow:\n\n");
    for (const f of verdict.findings.filter((x) => x.level === "deny")) {
      process.stdout.write(`  - ${f.detail}\n`);
    }
    process.stdout.write(
      `\nNothing was put online. Remove the item${
        verdict.findings.filter((x) => x.level === "deny").length === 1 ? "" : "s"
      } above and run this again.\n`,
    );
    return 1;
  }

  if (verdict.decision === "allowed") {
    process.stdout.write("Safety review: this app keeps to its own platform, nothing to approve. Proceeding.\n");
    return null;
  }

  // needs-review — a person must confirm the list below.
  const flags = verdict.findings.filter((x) => x.level === "flag");
  const reviewList = [
    "Before this goes live, please confirm what it connects to and uses:",
    "",
    ...flags.map((f) => `  - ${f.detail}`),
    "",
  ].join("\n");

  if (process.env.DP_COMPLIANCE_APPROVED === "1") {
    process.stdout.write(reviewList);
    process.stdout.write("You approved these, so the deploy is going ahead.\n");
    return null;
  }

  process.stdout.write(reviewList);

  // Interactive terminal: ask the person directly. Non-interactive and unapproved: refuse (never
  // block on stdin that will not come).
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const yes = await askYesNo("Approve these and put it online? [y/N] ");
    if (yes) return null;
    process.stdout.write("\nOkay, nothing was put online.\n");
    return 1;
  }

  process.stdout.write(
    "\nThis app connects to outside systems that need a person's okay before it goes live. Nothing was put online.\n" +
      "Approve it in the portal, or once you have confirmed the list above, run it again with your approval.\n",
  );
  return 1;
}

/** Ask a yes/no question on the terminal. Defaults to no on empty input or EOF. */
function askYesNo(question: string): Promise<boolean> {
  return new Promise((resolvePrompt) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolvePrompt(/^y(es)?$/i.test(answer.trim()));
    });
  });
}
