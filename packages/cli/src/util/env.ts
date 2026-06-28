import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Tokens {
  supabaseAccessToken: string;
  vercelToken: string;
  supabaseRegion: string;
}

/**
 * Load the provider tokens used to deploy on the personal profile (Vercel + Supabase).
 *
 * Two sources, in priority order:
 *  1. The environment (SUPABASE_ACCESS_TOKEN / VERCEL_TOKEN / SUPABASE_REGION). This is how
 *     the portal injects the END USER's own tokens, per deploy.
 *  2. The operator's ~/.appgen/tokens.env file, for the owner running the CLI on their device.
 *
 * The environment ALWAYS wins, so an injected user token is never shadowed by the operator's
 * file. When DP_TOKENS_ENV_ONLY=1 (the portal sets this), the file is not read at all: a
 * deploy with no supplied token fails closed instead of silently using the operator's account.
 */
export function loadTokens(): Tokens {
  const envOnly = process.env.DP_TOKENS_ENV_ONLY === "1";

  const fileEnv: Record<string, string> = {};
  if (!envOnly) {
    const path = join(homedir(), ".appgen", "tokens.env");
    try {
      const text = readFileSync(path, "utf8");
      for (const line of text.split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m) fileEnv[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    } catch {
      // No operator file is fine as long as the environment supplies the tokens below.
    }
  }

  const supabaseAccessToken = process.env.SUPABASE_ACCESS_TOKEN || fileEnv.SUPABASE_ACCESS_TOKEN || "";
  const vercelToken = process.env.VERCEL_TOKEN || fileEnv.VERCEL_TOKEN || "";
  const supabaseRegion = process.env.SUPABASE_REGION || fileEnv.SUPABASE_REGION || "us-east-1";
  if (!vercelToken) {
    throw new Error(
      "No Vercel token was provided. The personal profile deploys to your own Vercel account, so it needs a VERCEL_TOKEN.",
    );
  }
  return { supabaseAccessToken, vercelToken, supabaseRegion };
}
