/**
 * Territory proof for the Vercel SHIP path — the one code path the quota wall kept `up`
 * from ever executing. Deploys the reference app to a THROWAWAY Vercel project with
 * placeholder database env (runtime DB calls are expected to error; we are proving build +
 * ship + URL parse, not the DB), confirms a real https://*.vercel.app URL serves the app,
 * then tears the project down so nothing confusing is left behind.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadTokens } from "../packages/cli/src/util/env.ts";
import { prepareDeployContext } from "../packages/cli/src/util/context.ts";
import * as vercel from "../packages/cli/src/providers/vercel.ts";

const root = dirname(fileURLToPath(import.meta.url));
const appDir = join(root, "..", "apps", "reference-web");
const NAME = "dp-ship-proof";

async function main() {
  const tokens = loadTokens();
  const acct = await vercel.account(tokens.vercelToken);
  console.log(`Vercel account: ${acct.email}`);

  const proj = await vercel.ensureProject(tokens.vercelToken, { name: NAME, rootDirectory: "" });
  console.log(`Project ready: ${proj.name} (${proj.id})`);

  // Placeholder env: enough for the build and for /signin to render; DB will error at runtime.
  await vercel.setEnv(tokens.vercelToken, proj.id, {
    DATABASE_URL: "postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder",
    SUPABASE_URL: "https://placeholder.supabase.co",
    SUPABASE_ANON_KEY: "placeholder",
    SUPABASE_SERVICE_ROLE_KEY: "placeholder",
    PLATFORM_AUTH_SECRET: "placeholder-secret-for-ship-proof-only",
  });
  console.log("Env set.");

  const ctx = prepareDeployContext(appDir);
  vercel.linkProject(ctx.dir, proj.id, acct.id);
  console.log(`Deploy context: ${ctx.dir}`);

  console.log("Building and shipping on Vercel (this can take a couple of minutes)...");
  const outcome = await vercel.deploy(tokens.vercelToken, ctx.dir);
  console.log(`SHIPPED. URL parsed from CLI output: ${outcome.url}`);

  try {
    // /signin does not touch the DB, so it should return 200 with the app's HTML.
    const res = await fetch(`${outcome.url}/signin`, { redirect: "manual" });
    const body = await res.text();
    const served = res.status === 200 && /Let me in|Sign in/.test(body);
    console.log(`GET ${outcome.url}/signin -> ${res.status} | app HTML served: ${served}`);
    // Home page is expected to error (DB unreachable); just report its status.
    const home = await fetch(`${outcome.url}/`, { redirect: "manual" });
    console.log(`GET ${outcome.url}/ -> ${home.status} (a 500 here is expected: placeholder DB)`);
    console.log(served ? "\nSHIP VERIFIED: a real Vercel URL serves the built app over HTTPS." : "\nSHIP UNCONFIRMED: see statuses above.");
  } finally {
    console.log("\nTearing down the throwaway project...");
    await vercel.deleteProject(tokens.vercelToken, proj.id);
    console.log("Deleted.");
  }
}

main().catch((err) => {
  console.error(`\nShip proof failed: ${err.message}`);
  process.exit(1);
});
