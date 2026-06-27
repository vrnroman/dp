import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Per-app deploy state, stored next to the app as .deploy-state.json. This is what makes
 * `up` re-run safe (it reuses the same project instead of making a new one) and what `down`
 * reads to know exactly what to tear down. Never contains secrets the app does not already
 * hold; the db password is kept here so re-runs can rebuild the connection string.
 */
export interface DeployState {
  appName: string;
  slug: string;
  createdAt: string;
  supabase?: {
    ref: string;
    region: string;
    dbPassword: string;
    poolerHost?: string;
  };
  vercel?: {
    projectId: string;
    orgId: string;
  };
  authSecret?: string;
  url?: string;
}

function statePath(appDir: string): string {
  return join(appDir, ".deploy-state.json");
}

export function readState(appDir: string): DeployState | null {
  const p = statePath(appDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as DeployState;
  } catch {
    return null;
  }
}

export function writeState(appDir: string, state: DeployState): void {
  writeFileSync(statePath(appDir), JSON.stringify(state, null, 2) + "\n");
}

export function clearState(appDir: string): void {
  const p = statePath(appDir);
  if (existsSync(p)) rmSync(p);
}
