import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Tokens {
  supabaseAccessToken: string;
  vercelToken: string;
  supabaseRegion: string;
}

/**
 * Load the platform's provider tokens. These belong to the platform operator, not the
 * non-engineer. On a personal device they live in ~/.appgen/tokens.env.
 */
export function loadTokens(): Tokens {
  const path = join(homedir(), ".appgen", "tokens.env");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `Could not read provider tokens at ${path}. The platform needs a SUPABASE_ACCESS_TOKEN and a VERCEL_TOKEN to deploy.`,
    );
  }
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const supabaseAccessToken = env.SUPABASE_ACCESS_TOKEN || process.env.SUPABASE_ACCESS_TOKEN || "";
  const vercelToken = env.VERCEL_TOKEN || process.env.VERCEL_TOKEN || "";
  const supabaseRegion = env.SUPABASE_REGION || process.env.SUPABASE_REGION || "us-east-1";
  if (!supabaseAccessToken) throw new Error("SUPABASE_ACCESS_TOKEN is missing from the platform tokens.");
  if (!vercelToken) throw new Error("VERCEL_TOKEN is missing from the platform tokens.");
  return { supabaseAccessToken, vercelToken, supabaseRegion };
}
