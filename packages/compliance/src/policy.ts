/**
 * policy.ts — the deterministic compliance verdict.
 *
 * This is the seed of an organization's deploy policy. Today it runs against the PERSONAL stack
 * as a proof of concept; the same shape is what the org cell will enforce once its stack exists.
 * The verdict here is authoritative and rule-based (no model); the AI brief's recommendation is
 * advisory only. Rules answer "*may* this ship?", on top of the deployability gate's "*can* it?".
 *
 * Three outcomes:
 *   - blocked       — a hard rule is violated (e.g. a banned dependency). Does not ship.
 *   - needs-review  — nothing forbidden, but something a human should approve (an unknown external
 *                     system, personal data without sign-in, a powerful capability).
 *   - allowed       — meets policy; safe to auto-approve.
 */
import { hostsClaimedByServices, type AppFacts } from "./extract.ts";

export interface OrgPolicy {
  /** Frameworks the platform is allowed to run. A web app on anything else is blocked. */
  allowedFrameworks: string[];
  /** Dependency names (exact or substring) that must never ship. */
  bannedDependencies: string[];
  /** Host globs the app may talk to without review, e.g. "*.supabase.co". */
  outboundAllowlist: string[];
  /** External-service keys (see the fingerprint table) pre-approved without review. */
  approvedServices: string[];
  /** Flag (for review) an app that stores personal data but has no sign-in. */
  requireAuthIfPersonalData: boolean;
  /** Flag (for review) powerful capabilities like running OS commands. */
  flagRiskyCapabilities: boolean;
}

/**
 * The default policy. Deliberately permissive for the personal-cell POC: it approves the stack
 * the platform itself provisions (Supabase + Vercel) and flags anything outside it for a human.
 * An org would tighten this — a stricter allowlist, a real banned list, framework limits.
 */
export const DEFAULT_POLICY: OrgPolicy = {
  allowedFrameworks: ["nextjs", "vite", "remix", "astro"],
  // Example org rules, not a moral list: heavyweight headless browsers bundle Chromium and want a
  // long-running process, which the personal Vercel serverless model cannot host. A real org
  // tightens this into its own banned list. Substring match, so "-core" and scoped variants hit too.
  bannedDependencies: ["puppeteer", "playwright"],
  outboundAllowlist: [
    "*.supabase.co",
    "*.supabase.com",
    "*.supabase.in",
    "*.vercel.app",
    "*.vercel.com",
    "vercel.com",
  ],
  approvedServices: [],
  requireAuthIfPersonalData: true,
  flagRiskyCapabilities: true,
};

export type FindingLevel = "ok" | "flag" | "deny";

export interface PolicyFinding {
  level: FindingLevel;
  topic: string;
  detail: string;
}

export type Decision = "allowed" | "needs-review" | "blocked";

export interface Verdict {
  decision: Decision;
  findings: PolicyFinding[];
  /** Hosts that are not on the allowlist — the headline "which systems" review item. */
  unapprovedHosts: string[];
  /** Keys of the external services that need a human's OK (not on the approved-services list). */
  flaggedServices: string[];
}

/** Match a host against a glob like "*.supabase.co" (only a leading "*." wildcard is supported). */
function hostMatches(host: string, glob: string): boolean {
  if (glob.startsWith("*.")) {
    const suffix = glob.slice(1); // ".supabase.co"
    return host === glob.slice(2) || host.endsWith(suffix);
  }
  return host === glob;
}

export function evaluatePolicy(facts: AppFacts, policy: OrgPolicy = DEFAULT_POLICY): Verdict {
  const findings: PolicyFinding[] = [];

  // 1. Framework must be one the platform can run (web apps only — workers/static have no framework).
  if (facts.blueprint === "web" && facts.framework && !policy.allowedFrameworks.includes(facts.framework)) {
    findings.push({
      level: "deny",
      topic: "framework",
      detail: `Built with "${facts.framework}", which is not an approved framework (${policy.allowedFrameworks.join(", ")}).`,
    });
  }

  // 2. Banned dependencies are a hard stop — but only RUNTIME dependencies. A dev-only tool
  //    (a test runner or linter like @playwright/test) never ships to the serverless runtime, so
  //    banning it would wrongly refuse a normal app; we skip dev dependencies here.
  for (const dep of facts.dependencies) {
    if (dep.dev) continue;
    const hit = policy.bannedDependencies.find((b) => dep.name === b || dep.name.includes(b));
    if (hit) {
      findings.push({
        level: "deny",
        topic: "dependency",
        detail: `Uses the dependency "${dep.name}", which is on the banned list.`,
      });
    }
  }

  // 3. External systems — the core review surface. Anything off the allowlist needs a human OK.
  //
  // Two channels feed this: named SERVICES (Stripe, S3, a queue — fused from dependency, secret,
  // and host signals, so an SDK-only SaaS with no literal URL still surfaces) and raw HOSTS the
  // code hits. A host already explained by a named service is not listed twice: the service line
  // "claims" it, so we fold it in there instead.
  const claimedHosts = hostsClaimedByServices(facts.externalServices);
  const flaggedServices: string[] = [];

  for (const svc of facts.externalServices) {
    if (policy.approvedServices.includes(svc.key)) {
      findings.push({ level: "ok", topic: "service", detail: `${svc.label} (approved).` });
      continue;
    }
    flaggedServices.push(svc.key);
    const needs = svc.secret ? ` It uses the secret ${svc.secret}.` : "";
    findings.push({
      level: "flag",
      topic: "service",
      detail: `${svc.label}.${needs} Confirm this external service is expected and allowed.`,
    });
  }

  // Raw hosts NOT already covered by a named service.
  const looseHosts = facts.outboundHosts.filter((h) => !claimedHosts.has(h));
  const unapprovedHosts = looseHosts.filter(
    (h) => !policy.outboundAllowlist.some((g) => hostMatches(h, g)),
  );
  for (const host of unapprovedHosts) {
    findings.push({
      level: "flag",
      topic: "outbound",
      detail: `Connects to ${host}, which is not on the approved-systems list. Confirm this is expected and allowed.`,
    });
  }
  for (const host of looseHosts.filter((h) => !unapprovedHosts.includes(h))) {
    findings.push({ level: "ok", topic: "outbound", detail: `Connects to ${host} (approved infrastructure).` });
  }

  // 4. Personal data without a sign-in gate.
  if (policy.requireAuthIfPersonalData && facts.data.personalData.length && facts.data.authTier === "none") {
    findings.push({
      level: "flag",
      topic: "data",
      detail: `Stores personal data (${facts.data.personalData.join(", ")}) but has no sign-in, so it would be open to anyone with the link. Confirm this is intended.`,
    });
  }

  // 5. Powerful capabilities worth a human glance.
  if (policy.flagRiskyCapabilities) {
    for (const cap of facts.capabilities) {
      if (cap === "makes outbound network requests") continue; // covered by the outbound list
      findings.push({ level: "flag", topic: "capability", detail: `The app ${cap}. Confirm this is necessary.` });
    }
  }

  const hasDeny = findings.some((f) => f.level === "deny");
  const hasFlag = findings.some((f) => f.level === "flag");
  const decision: Decision = hasDeny ? "blocked" : hasFlag ? "needs-review" : "allowed";

  return { decision, findings, unapprovedHosts, flaggedServices };
}
