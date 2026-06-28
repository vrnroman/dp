/**
 * GCP VM provider — the "org" profile, v1.
 *
 * Instead of Vercel + Supabase, this binding deploys an app onto a machine the owner owns:
 * a Compute Engine VM that already runs Caddy (automatic HTTPS via Let's Encrypt) in front
 * of per-app systemd services. Each app gets its own subdomain on sslip.io
 * (<slug>.<ip-with-dashes>.sslip.io), its own loopback port, and its own systemd unit.
 *
 * The same code can drive the VM from the owner's laptop (over `gcloud compute ssh`/`scp`)
 * or from a process already running ON the VM (plain local exec) — set DP_TARGET=local for
 * the latter. That is what lets the browser portal, itself deployed on the VM, deploy apps.
 *
 * v1 deploys DB-less web/static apps (auth tier none). A Postgres (Cloud SQL) binding and a
 * login gate are the next cells.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEPLOY_SH = join(HERE, "gcp-vm-deploy.sh");
const TEARDOWN_SH = join(HERE, "gcp-vm-teardown.sh");

const PORT_MIN = 8080;
const PORT_MAX = 8099;

export interface VmConfig {
  instance: string;
  project: string;
  zone: string;
  ip: string;
  user: string;
  /** the base domain all apps hang off, e.g. 34-11-212-4.sslip.io */
  baseDomain: string;
}

export function vmConfig(): VmConfig {
  const ip = process.env.DP_VM_IP || "34.11.212.4";
  return {
    instance: process.env.DP_VM_INSTANCE || "claude-agent",
    project: process.env.DP_VM_PROJECT || "roman-vm",
    zone: process.env.DP_VM_ZONE || "us-west1-a",
    user: process.env.DP_VM_USER || "tianyuezhou",
    ip,
    baseDomain: process.env.DP_VM_DOMAIN || ip.replace(/\./g, "-") + ".sslip.io",
  };
}

type Target = { mode: "ssh" | "local" };
function target(): Target {
  return { mode: process.env.DP_TARGET === "local" ? "local" : "ssh" };
}

export type OnLine = (line: string) => void;

interface RunResult {
  code: number;
  out: string;
}

/** Spawn a command, streaming each stdout/stderr line to onLine while capturing all of it. */
function runStreaming(cmd: string, args: string[], onLine?: OnLine): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let buf = "";
    const onData = (d: Buffer) => {
      const s = d.toString();
      out += s;
      buf += s;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (onLine && line.trim()) onLine(line);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", (code) => {
      if (onLine && buf.trim()) onLine(buf);
      resolve({ code: code ?? 1, out });
    });
    child.on("error", (err) => resolve({ code: 1, out: out + String(err) }));
  });
}

/** Run a shell command on the target (VM over ssh, or this machine in local mode). */
function runOnTarget(cfg: VmConfig, command: string, onLine?: OnLine): Promise<RunResult> {
  if (target().mode === "local") {
    return runStreaming("bash", ["-c", command], onLine);
  }
  return runStreaming(
    "gcloud",
    ["compute", "ssh", cfg.instance, "--project", cfg.project, "--zone", cfg.zone, "--command", command],
    onLine,
  );
}

/** Copy local files into the target user's home directory. */
async function copyToHome(cfg: VmConfig, files: string[], onLine?: OnLine): Promise<void> {
  if (target().mode === "local") {
    for (const f of files) copyFileSync(f, join(homedir(), basename(f)));
    return;
  }
  const res = await runStreaming(
    "gcloud",
    ["compute", "scp", ...files, `${cfg.instance}:/home/${cfg.user}/`, "--project", cfg.project, "--zone", cfg.zone],
    onLine,
  );
  if (res.code !== 0) throw new Error(`Could not copy files to the VM:\n${tail(res.out)}`);
}

function basename(p: string): string {
  return p.split("/").pop() as string;
}

/** Tar the prepared app directory into a single archive the VM can unpack. */
function tarContext(ctxDir: string, slug: string): string {
  const tmp = mkdtempSync(join(tmpdir(), "dp-tar-"));
  const tgz = join(tmp, `dp-${slug}.tgz`);
  return tgz; // path computed; caller runs tar
}

/** Pick a free loopback port for this app, reusing one already assigned to it if given. */
export async function pickPort(cfg: VmConfig, reuse?: number): Promise<number> {
  if (reuse && reuse >= PORT_MIN && reuse <= PORT_MAX) return reuse;
  const probe =
    "( ss -ltn 2>/dev/null | grep -oE ':[0-9]+ ' | tr -d ': '; " +
    "grep -rhoE '127\\.0\\.0\\.1:[0-9]+' /etc/caddy/conf.d 2>/dev/null | grep -oE '[0-9]+$' ) | sort -un";
  const res = await runOnTarget(cfg, probe);
  const used = new Set(
    res.out
      .split(/\s+/)
      .map((s) => parseInt(s, 10))
      .filter((n) => !Number.isNaN(n)),
  );
  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    if (!used.has(p)) return p;
  }
  throw new Error(`No free port in ${PORT_MIN}-${PORT_MAX} on the VM. Take an app down first.`);
}

export interface VmDeployResult {
  url: string;
  port: number;
  service: string;
  appDir: string;
  hostname: string;
}

/**
 * Deploy a prepared (vendored, standalone) app directory onto the VM. Streams the VM-side
 * progress lines to onLine. Returns the live facts. Does not write deploy state — the
 * caller persists it.
 */
export async function deployToVm(opts: {
  ctxDir: string;
  slug: string;
  port: number;
  onLine?: OnLine;
}): Promise<VmDeployResult> {
  const cfg = vmConfig();
  const { ctxDir, slug, port, onLine } = opts;
  const hostname = `${slug}.${cfg.baseDomain}`;
  const service = `dp-${slug}`;
  const appDir = `/home/${cfg.user}/dp-apps/${slug}`;

  // 1. Pack the app into a single archive next to the scripts we ship.
  const tgz = tarContext(ctxDir, slug);
  try {
    const tarRes = await runStreaming("tar", ["czf", tgz, "-C", ctxDir, "."]);
    if (tarRes.code !== 0) throw new Error(`Could not package the app:\n${tail(tarRes.out)}`);

    // 2. Ship the archive and the deploy scripts to the VM (or place them locally).
    await copyToHome(cfg, [tgz, DEPLOY_SH], onLine);

    // 3. Run the VM-side deploy as root. It is idempotent and protects the existing front door.
    const remoteScript = `$HOME/${basename(DEPLOY_SH)}`;
    const cmd = `sudo bash ${remoteScript} ${shq(slug)} ${shq(String(port))} ${shq(hostname)} ${shq(cfg.baseDomain)} ${shq(cfg.user)}`;
    const res = await runOnTarget(cfg, cmd, onLine);
    if (res.code !== 0) {
      throw new Error(
        `The VM could not bring the app up.\n${tail(res.out)}\n` +
          `Nothing is half-broken: the existing apps on the VM were left untouched. Fix the issue and run this again.`,
      );
    }
    if (!/RESULT url=/.test(res.out)) {
      throw new Error(`The deploy finished without confirming success.\n${tail(res.out)}`);
    }

    return { url: `https://${hostname}`, port, service, appDir, hostname };
  } finally {
    try {
      rmSync(dirname(tgz), { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Wait for the public HTTPS URL to actually answer with a valid certificate — the
 * "ribbon-cutting". Caddy issues the Let's Encrypt cert on the first request to a new
 * hostname, so the first several attempts can fail while that happens.
 */
export async function waitForPublic(url: string, onLine?: OnLine, attempts = 30): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const res = await runStreaming("curl", ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "8", url]);
    const code = res.out.trim();
    if (code === "200") {
      if (onLine) onLine(`DP> the door answered (${code})`);
      return true;
    }
    if (onLine && i % 3 === 0) onLine(`DP> knocking on the door… (${code || "no answer yet"})`);
    await sleep(3000);
  }
  return false;
}

/** Tear down everything one app created on the VM. Leaves other apps and shared config intact. */
export async function teardownOnVm(slug: string, onLine?: OnLine): Promise<void> {
  const cfg = vmConfig();
  await copyToHome(cfg, [TEARDOWN_SH], onLine);
  const remoteScript = `$HOME/${basename(TEARDOWN_SH)}`;
  const cmd = `sudo bash ${remoteScript} ${shq(slug)} ${shq(cfg.user)}`;
  const res = await runOnTarget(cfg, cmd, onLine);
  if (res.code !== 0 || !/RESULT removed=/.test(res.out)) {
    throw new Error(`Could not fully take the app down on the VM:\n${tail(res.out)}`);
  }
}

function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
function tail(text: string): string {
  return text.split("\n").slice(-16).join("\n");
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
