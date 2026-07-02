/**
 * @platform/compliance — the compliance evaluator.
 *
 * It answers the question the deployability gate does not: not "*can* this app ship?" but
 * "*may* it ship?" — does it meet the organization's rules, and what should a human approve?
 * It produces, for one app:
 *   1. verified FACTS (deterministic)        — what it's built with, what it connects to, what data it holds
 *   2. a policy VERDICT (deterministic)      — allowed / needs-review / blocked
 *   3. an approval BRIEF (AI, via claude -p) — a short plain-English write-up for a human approver
 *
 * Built and proven on the PERSONAL stack first; the same shape applies to the org cell later.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Manifest } from "@platform/manifest";
import { extractFacts, hostsClaimedByServices, type AppFacts } from "./extract.ts";
import { evaluatePolicy, DEFAULT_POLICY, type OrgPolicy, type Verdict } from "./policy.ts";
import { writeBrief, type Brief } from "./brief.ts";

export type { AppFacts, ExternalService } from "./extract.ts";
export type { OrgPolicy, Verdict, PolicyFinding, Decision } from "./policy.ts";
export type { Brief } from "./brief.ts";
export { DEFAULT_POLICY, evaluatePolicy } from "./policy.ts";
export { extractFacts } from "./extract.ts";
export { flushTelemetry, isTelemetryEnabled } from "./telemetry.ts";

export interface Review {
  facts: AppFacts;
  verdict: Verdict;
  brief: Brief | null;
  briefError?: string;
}

export interface ReviewOptions {
  policy?: OrgPolicy;
  /** Skip the AI brief (deterministic facts + verdict only). */
  skipBrief?: boolean;
}

export async function review(appDir: string, manifest: Manifest, opts: ReviewOptions = {}): Promise<Review> {
  const facts = extractFacts(appDir, manifest);
  const verdict = evaluatePolicy(facts, opts.policy ?? DEFAULT_POLICY);

  if (opts.skipBrief) return { facts, verdict, brief: null };

  const digest = buildDigest(appDir);
  const { brief, error } = await writeBrief(facts, digest, facts.name);
  return { facts, verdict, brief, briefError: error };
}

/** A small, already-trimmed slice of the app's own text so the model can describe what it does. */
function buildDigest(appDir: string): string {
  const parts: string[] = [];
  // README first — it usually says what the app is.
  for (const name of ["README.md", "readme.md", "README"]) {
    const p = join(appDir, name);
    if (existsSync(p)) {
      try {
        parts.push(`# ${name}\n` + readFileSync(p, "utf8").slice(0, 3500));
      } catch {
        /* ignore */
      }
      break;
    }
  }
  // A couple of route/page files, to ground "what it does" in the actual UI.
  const pages = findFiles(appDir, /(^|\/)(page|index|app)\.(tsx|ts|jsx|js)$/i, 3);
  for (const p of pages) {
    try {
      parts.push(`# ${p.replace(appDir + "/", "")}\n` + readFileSync(p, "utf8").slice(0, 1500));
    } catch {
      /* ignore */
    }
  }
  return parts.join("\n\n").slice(0, 9000);
}

function findFiles(dir: string, re: RegExp, limit: number, acc: string[] = []): string[] {
  if (acc.length >= limit) return acc;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (acc.length >= limit) break;
    if (["node_modules", ".next", ".git", ".vercel", "dist", "build"].includes(entry)) continue;
    const full = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) findFiles(full, re, limit, acc);
    else if (re.test(full)) acc.push(full);
  }
  return acc;
}

const DECISION_HEADLINE: Record<Verdict["decision"], string> = {
  allowed: "ALLOWED — meets policy, safe to approve",
  "needs-review": "NEEDS REVIEW — a person should confirm the items below",
  blocked: "BLOCKED — does not meet policy and cannot ship",
};

/** Render the approval brief as plain-English terminal text — the artifact an approver reads. */
export function renderApprovalCard(r: Review): string {
  const f = r.facts;
  const L: string[] = [];
  L.push(`DEPLOYMENT APPROVAL BRIEF — ${f.name}`);
  L.push("");
  if (r.brief) {
    L.push(`What it does:   ${r.brief.summary}`);
    if (r.brief.does && r.brief.does !== r.brief.summary) L.push(`                ${r.brief.does}`);
  } else {
    L.push(`What it does:   (AI brief unavailable${r.briefError ? ` — ${r.briefError}` : ""})`);
  }

  const built = [f.framework, ...f.dependencies.filter((d) => !d.dev).slice(0, 4).map((d) => d.name)]
    .filter(Boolean)
    .join(", ");
  L.push(`Built with:     ${built || "—"}${f.runtime ? ` (${f.runtime})` : ""}`);
  L.push(`Sign-in:        ${describeAuth(f.data.authTier)}`);

  const dataLine = r.brief?.dataSummary
    ? r.brief.dataSummary
    : f.data.hasDatabase
      ? "Stores data in a database."
      : "No database.";
  const pd = f.data.personalData.length ? ` Personal data: ${f.data.personalData.join(", ")}.` : "";
  L.push(`Data:           ${dataLine}${pd}`);

  // Named services (Stripe, S3, a queue) claim the hosts they explain, so a host is not shown twice.
  const claimedHosts = hostsClaimedByServices(f.externalServices);
  const looseHosts = f.outboundHosts.filter((h) => !claimedHosts.has(h));

  L.push(`Connects out to:`);
  if (f.externalServices.length === 0 && looseHosts.length === 0) {
    L.push(`                - nothing outside its own platform`);
  } else {
    for (const svc of f.externalServices) {
      const flagged = r.verdict.flaggedServices.includes(svc.key);
      const sec = svc.secret ? ` [${svc.secret}]` : "";
      L.push(`                - ${svc.label}${sec}${flagged ? "   <-- NEEDS REVIEW" : "   (approved)"}`);
    }
    for (const h of looseHosts) {
      const flagged = r.verdict.unapprovedHosts.includes(h);
      L.push(`                - ${h}${flagged ? "   <-- NEEDS REVIEW (not on approved list)" : "   (approved)"}`);
    }
  }

  if (f.secrets.required.length || f.secrets.optional.length) {
    const req = f.secrets.required.map((s) => `${s} (required)`);
    const opt = f.secrets.optional.map((s) => `${s} (optional)`);
    L.push(`Needs secrets:  ${[...req, ...opt].join(", ")}`);
  }
  const caps = f.capabilities.filter((c) => c !== "makes outbound network requests");
  if (caps.length) L.push(`Capabilities:   ${caps.join("; ")}`);

  L.push("");
  L.push(`VERDICT: ${DECISION_HEADLINE[r.verdict.decision]}`);
  const actionable = r.verdict.findings.filter((x) => x.level !== "ok");
  for (const x of actionable) {
    L.push(`  ${x.level === "deny" ? "✗" : "•"} ${x.detail}`);
  }
  if (r.brief) {
    L.push("");
    L.push(`Advisory (AI):  recommends "${r.brief.recommendation}" — ${r.brief.approverNote}`);
  }
  return L.join("\n");
}

/** Same content as a Markdown document, for saving as a shareable approval record. */
export function renderApprovalMarkdown(r: Review): string {
  const f = r.facts;
  const L: string[] = [];
  L.push(`# Deployment approval brief — ${f.name}`);
  L.push("");
  L.push(`**Verdict:** ${DECISION_HEADLINE[r.verdict.decision]}`);
  L.push("");
  if (r.brief) {
    L.push(`**What it does:** ${r.brief.summary} ${r.brief.does}`);
    L.push("");
    L.push(`**Data:** ${r.brief.dataSummary}` + (f.data.personalData.length ? ` _(personal data: ${f.data.personalData.join(", ")})_` : ""));
  }
  L.push("");
  L.push(`**Built with:** ${[f.framework, ...f.dependencies.filter((d) => !d.dev).map((d) => d.name)].filter(Boolean).join(", ")}`);
  L.push(`**Sign-in:** ${describeAuth(f.data.authTier)}`);
  L.push("");
  const claimed = hostsClaimedByServices(f.externalServices);
  const loose = f.outboundHosts.filter((h) => !claimed.has(h));
  L.push(`**Connects out to:**`);
  if (f.externalServices.length === 0 && loose.length === 0) L.push(`- nothing outside its own platform`);
  for (const svc of f.externalServices) {
    const flagged = r.verdict.flaggedServices.includes(svc.key);
    L.push(`- ${svc.label}${svc.secret ? ` (uses ${svc.secret})` : ""}${flagged ? " — **needs review**" : " — approved"}`);
  }
  for (const h of loose) {
    L.push(`- ${h}${r.verdict.unapprovedHosts.includes(h) ? " — **needs review** (not on approved list)" : " — approved"}`);
  }
  if (f.secrets.required.length || f.secrets.optional.length) {
    L.push("");
    L.push(`**Secrets:** ${[...f.secrets.required.map((s) => `${s} (required)`), ...f.secrets.optional.map((s) => `${s} (optional)`)].join(", ")}`);
  }
  const checks = r.verdict.findings.filter((x) => x.level !== "ok");
  if (checks.length) {
    L.push("");
    L.push(`**To check before approving:**`);
    for (const x of checks) L.push(`- ${x.detail}`);
  }
  if (r.brief) {
    L.push("");
    L.push(`_Advisory (AI): recommends "${r.brief.recommendation}". ${r.brief.approverNote}_`);
  }
  L.push("");
  return L.join("\n");
}

function describeAuth(tier: string): string {
  switch (tier) {
    case "simple":
      return "yes — email allowlist (only invited people get in)";
    case "proper":
      return "yes — full sign-in";
    default:
      return "none — open to anyone with the link";
  }
}
