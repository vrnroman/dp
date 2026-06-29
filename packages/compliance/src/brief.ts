/**
 * brief.ts — the AI half: a short, plain-English approval brief for a human org approver.
 *
 * It is given ONLY the deterministic facts (from extract.ts) plus a small source digest, and asked
 * to (a) say what the app does in one or two sentences, (b) summarize the data it holds, and
 * (c) leave an advisory note + recommendation for the approver. The facts are authoritative; the
 * model narrates and advises, it does not source facts. Runs on `claude -p` (subscription) and is
 * traced to Langfuse. If no model is reachable, returns null and the review degrades to facts only.
 */
import { callClaude } from "./claude.ts";
import type { AppFacts } from "./extract.ts";

export interface Brief {
  /** One or two sentences: what this app does, for a non-technical reader. */
  summary: string;
  /** What it does for its users, slightly more concrete. */
  does: string;
  /** Plain-English summary of the data it stores. */
  dataSummary: string;
  /** Advisory note: anything the approver should scrutinize, or "Nothing notable." */
  approverNote: string;
  /** Advisory only — the deterministic verdict is authoritative. */
  recommendation: "approve" | "review" | "reject";
}

const PROMPT_SHAPE = `You are writing a one-screen DEPLOYMENT APPROVAL BRIEF for a non-technical person at an organization who must decide whether to allow an app to be deployed. You are given verified, machine-extracted facts about the app and a short digest of its files. Base everything ONLY on what you are given — do not invent capabilities, data, or systems. Never include secret values, tokens, or credentials.

Return ONLY a single JSON object (no markdown, no prose around it) with exactly these string fields:
{
  "summary": "1-2 sentences: what this app is and does, in plain language",
  "does": "what it does for its users, slightly more concrete (1-2 sentences)",
  "dataSummary": "what data it stores, in plain words; say 'No data is stored' if it stores none",
  "approverNote": "the single most important thing for the approver to check, or 'Nothing notable.'",
  "recommendation": "approve" | "review" | "reject"
}
Keep every field short. 'recommendation' is your advisory read: 'approve' if it looks routine and safe, 'review' if a human should confirm something, 'reject' only if it looks clearly unsafe.`;

/** Pull the first balanced JSON object out of model text (it may add stray prose despite instructions). */
function extractJson(text: string): unknown | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function coerceBrief(raw: unknown): Brief | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const rec = str(o.recommendation).toLowerCase();
  const recommendation = rec === "approve" || rec === "reject" ? rec : "review";
  const brief: Brief = {
    summary: str(o.summary),
    does: str(o.does),
    dataSummary: str(o.dataSummary),
    approverNote: str(o.approverNote) || "Nothing notable.",
    recommendation,
  };
  if (!brief.summary) return null;
  return brief;
}

export interface WriteBriefResult {
  brief: Brief | null;
  /** Set when the brief could not be produced (no CLI, not signed in, parse failure). */
  error?: string;
}

/**
 * Produce the approval brief. `digest` is a short, already-trimmed slice of the app's own text
 * (README, key pages) so the model can describe what it does without reading the tree itself.
 */
export async function writeBrief(facts: AppFacts, digest: string, appSlug: string): Promise<WriteBriefResult> {
  const prompt =
    `${PROMPT_SHAPE}\n\n` +
    `VERIFIED FACTS (JSON):\n${JSON.stringify(facts, null, 2)}\n\n` +
    `SOURCE DIGEST (truncated):\n${digest}\n`;

  try {
    const result = await callClaude(prompt, { name: "compliance-brief", appSlug });
    const brief = coerceBrief(extractJson(result.text));
    if (!brief) return { brief: null, error: "the model's reply was not in the expected shape" };
    return { brief };
  } catch (err) {
    return { brief: null, error: (err as Error).message };
  }
}
