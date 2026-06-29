/**
 * claude.ts — the one place the compliance evaluator talks to a model.
 *
 * It runs the Claude Code CLI in print mode (`claude -p`) on the owner's **subscription**, NOT
 * the Anthropic API key. This matches how the echo-v0 bot runs: ANTHROPIC_API_KEY is stripped
 * from the child's environment so key-auth can never leak in, and auth comes from the logged-in
 * Claude Code session (or a CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`, if set).
 *
 * Every call is recorded as one Langfuse generation (see telemetry.ts) into deployment-platform's
 * OWN Langfuse project, so prompts, completions, token usage, cost, and latency are observable
 * without mixing into any other product's traces.
 */
import { spawn } from "node:child_process";
import { recordGeneration } from "./telemetry.ts";

export interface ClaudeResult {
  text: string;
  costUsd: number;
  durationMs: number;
  sessionId: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
}

export interface CallClaudeOptions {
  /** Telemetry/label for the call site, e.g. "compliance-brief". */
  name: string;
  model?: string;
  /** Read-only tool set, comma-separated. Default: none (pure text generation). */
  allowedTools?: string;
  timeoutMs?: number;
  /** Working directory for the CLI (lets read-only tools, if granted, see the app). */
  cwd?: string;
  /** The app being reviewed, for grouping traces. */
  appSlug?: string;
}

type ClaudeEnvelope = {
  is_error?: boolean;
  api_error_status?: number | null;
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  session_id?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

export class ClaudeError extends Error {}

const DEFAULT_MODEL = "claude-opus-4-8";

/**
 * Run one `claude -p` call and return the model's text. Records a Langfuse generation for every
 * outcome (success and failure). Throws ClaudeError on failure; callers that want graceful
 * degradation (no model available) should catch it.
 */
export function callClaude(prompt: string, opts: CallClaudeOptions): Promise<ClaudeResult> {
  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? 180_000;

  const args = ["-p", prompt, "--model", model, "--output-format", "json"];
  if (opts.allowedTools !== undefined) {
    // A tool set was named: grant exactly it (read-only sets are the norm here) and skip
    // permission prompts so print mode never hangs.
    args.push("--allowed-tools", opts.allowedTools, "--max-turns", "12", "--dangerously-skip-permissions");
  } else {
    // No tools: a single-shot text generation. Nothing to permit, so no skip flag needed.
    args.push("--max-turns", "1");
  }

  // Subscription auth only. Strip ANTHROPIC_API_KEY so key-auth can never leak in (echo's
  // "belt + suspenders"); pass through CLAUDE_CODE_OAUTH_TOKEN if the owner set one.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  return new Promise<ClaudeResult>((resolve, reject) => {
    const startTime = new Date();
    const child = spawn("claude", args, { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new ClaudeError(`claude -p timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new ClaudeError(`could not start claude: ${err.message}. Is the Claude Code CLI installed and signed in?`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const endTime = new Date();

      let parsed: ClaudeEnvelope | null = null;
      try {
        if (stdout.trim().length > 0) parsed = JSON.parse(stdout) as ClaudeEnvelope;
      } catch {
        /* not JSON — handled below */
      }

      const usage = parsed?.usage
        ? {
            inputTokens: parsed.usage.input_tokens,
            outputTokens: parsed.usage.output_tokens,
            cacheReadTokens: parsed.usage.cache_read_input_tokens,
            cacheCreationTokens: parsed.usage.cache_creation_input_tokens,
          }
        : undefined;

      const ok = !!parsed && parsed.is_error !== true && code === 0;
      const text = String(parsed?.result ?? "").trim();
      const errorMessage = ok
        ? undefined
        : parsed?.is_error
          ? `claude is_error (status=${parsed.api_error_status ?? "none"})`
          : `claude exited ${code}${stderr ? `: ${stderr.slice(0, 200)}` : ""}`;

      // Telemetry first, derived independently from the raw outputs, so it captures every outcome
      // and can never perturb the resolve/reject below.
      recordGeneration({
        name: opts.name,
        model,
        input: prompt,
        output: ok ? text : errorMessage,
        startTime,
        endTime,
        usage,
        costUsd: parsed?.total_cost_usd,
        durationMs: parsed?.duration_ms,
        appSlug: opts.appSlug,
        errorMessage,
      });

      if (!ok) {
        reject(new ClaudeError(errorMessage ?? "claude call failed"));
        return;
      }
      resolve({
        text,
        costUsd: Number(parsed?.total_cost_usd ?? 0),
        durationMs: Number(parsed?.duration_ms ?? 0),
        sessionId: String(parsed?.session_id ?? ""),
        usage,
      });
    });
  });
}
