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
  /** org profile: the app runs as a systemd service behind Caddy on the owner's VM. */
  gcpVm?: {
    instance: string;
    project: string;
    zone: string;
    /** the loopback port the service listens on (reused on redeploy). */
    port: number;
    /** the service unit name, dp-<slug>. */
    service: string;
    /** absolute path to the app directory on the VM. */
    appDir: string;
    hostname: string;
  };
  authSecret?: string;
  url?: string;
  /** relay mode: the origin registered with the auth relay, so `down` can deregister it. */
  relay?: { origin: string; url: string };
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
