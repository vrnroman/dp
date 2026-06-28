/**
 * Vercel provider — hosting and the live URL for the personal profile. Project setup and
 * env vars go through the Vercel API; the actual build-and-ship uses the Vercel CLI (run
 * via npx) because it handles uploading and building a Next.js app for us.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { exec } from "../util/exec.ts";

const API = "https://api.vercel.com";

async function api(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export interface Account {
  id: string;
  email: string;
}

export async function account(token: string): Promise<Account> {
  const res = await api(token, "/v2/user");
  if (!res.ok) throw new Error(`Could not read the Vercel account (${res.status}). Check the token.`);
  const json = (await res.json()) as { user: { id: string; email: string } };
  return { id: json.user.id, email: json.user.email };
}

export interface VercelProject {
  id: string;
  name: string;
}

export async function ensureProject(
  token: string,
  opts: { name: string; rootDirectory: string },
): Promise<VercelProject> {
  // Try to fetch an existing project first (re-run safety).
  const existing = await api(token, `/v9/projects/${opts.name}`);
  if (existing.ok) {
    const json = (await existing.json()) as VercelProject;
    return { id: json.id, name: json.name };
  }
  const body: Record<string, unknown> = { name: opts.name, framework: "nextjs" };
  if (opts.rootDirectory) body.rootDirectory = opts.rootDirectory;
  const res = await api(token, "/v11/projects", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Vercel could not create the project (${res.status}): ${trim(text)}`);
  const json = JSON.parse(text) as VercelProject;
  return { id: json.id, name: json.name };
}

export async function setEnv(
  token: string,
  projectId: string,
  vars: Record<string, string>,
): Promise<void> {
  for (const [key, value] of Object.entries(vars)) {
    const res = await api(token, `/v10/projects/${projectId}/env?upsert=true`, {
      method: "POST",
      body: JSON.stringify({
        key,
        value,
        type: "encrypted",
        target: ["production", "preview", "development"],
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      // 400 with "already exists" can happen on races; upsert=true should prevent it.
      if (!/already exists/i.test(text)) {
        throw new Error(`Could not set the setting ${key} on Vercel (${res.status}): ${trim(text)}`);
      }
    }
  }
}

/** Link the repo to the project by writing .vercel/project.json (no interactive login). */
export function linkProject(repoRoot: string, projectId: string, orgId: string): void {
  const dir = join(repoRoot, ".vercel");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "project.json"), JSON.stringify({ projectId, orgId }) + "\n");
}

export interface DeployOutcome {
  url: string;
  log: string;
}

/**
 * Build and ship. Returns the production URL parsed from the CLI output.
 *
 * The Vercel CLI prints the production URL early (before the build finishes), so we stream
 * its output and call `onUrl` the first time we see it. That lets the caller show the live
 * address right away, while the build is still running, instead of only at the very end.
 */
export async function deploy(
  token: string,
  repoRoot: string,
  onUrl?: (url: string) => void,
): Promise<DeployOutcome> {
  const URL_RE = /https:\/\/[a-z0-9.-]+\.vercel\.app/i;
  return new Promise<DeployOutcome>((resolve, reject) => {
    const child = spawn(
      "npx",
      ["--yes", "vercel@latest", "deploy", "--prod", "--yes", `--token=${token}`, "--cwd", repoRoot],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let buf = "";
    let fired = false;
    const onData = (d: Buffer) => {
      const s = d.toString();
      out += s;
      buf += s;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!fired && onUrl) {
          const m = line.match(URL_RE);
          if (m) {
            fired = true;
            onUrl(m[0]);
          }
        }
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      const urls = out.match(/https:\/\/[a-z0-9.-]+\.vercel\.app/gi) ?? [];
      // The production alias is the shortest matching URL (no random deployment hash).
      const url = urls.sort((a, b) => a.length - b.length)[0] ?? "";
      if (code !== 0 || !url) {
        reject(new Error(`The deploy step failed. Vercel said:\n${tail(out)}`));
        return;
      }
      resolve({ url, log: out });
    });
  });
}

export async function deleteProject(token: string, projectId: string): Promise<void> {
  const res = await api(token, `/v9/projects/${projectId}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Could not delete the Vercel project (${res.status}).`);
  }
}

function trim(text: string): string {
  try {
    const j = JSON.parse(text);
    return (j.error?.message || j.message || text).toString().slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}
function tail(text: string): string {
  return text.split("\n").slice(-12).join("\n");
}
