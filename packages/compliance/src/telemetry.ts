/**
 * telemetry.ts — Langfuse observability for the compliance evaluator's LLM calls.
 *
 * The evaluator runs on the Claude Code CLI (`claude -p`, subscription auth), NOT the
 * Anthropic SDK, so there is no SDK auto-instrumentation. We treat each `claude -p` round-trip
 * as one Langfuse *generation* and POST it to the Langfuse ingestion API ourselves. This mirrors
 * the proven approach in the echo-v0 bot, kept deliberately minimal here.
 *
 * Design constraints (same as echo):
 *  - ZERO npm dependencies. The ingestion API is one authenticated POST; we build the batch by
 *    hand. Keeps the package install-free beyond its workspace deps.
 *  - Fully OPT-IN. With LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY unset the module is a no-op,
 *    so tests and offline runs never emit.
 *  - NEVER throws into the caller. Telemetry is fire-and-forget; a Langfuse outage must not
 *    break a deploy review.
 *
 * IMPORTANT: this uses its OWN Langfuse project keys (separate from echo and any other project),
 * so deployment-platform traces never mix with another product's.
 */
import { randomUUID } from "node:crypto";

type TelemetryConfig = {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  /** Whether to send prompts + completions (true) or only metrics (false). */
  captureIo: boolean;
  /** Max chars of input/output to send (guards pathological payloads). */
  maxIoChars: number;
};

const DEFAULT_BASE_URL = "https://cloud.langfuse.com";
const DEFAULT_MAX_IO_CHARS = 200_000;
const DEFAULT_MODEL = "claude-opus-4-8";

// Memoized so we read env + decide enabled/disabled once per process, resettable for tests.
let configCache: TelemetryConfig | null | undefined;

function readConfig(): TelemetryConfig | null {
  if (configCache !== undefined) return configCache;

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim();
  if (!publicKey || !secretKey) {
    configCache = null;
    return configCache;
  }

  const rawBase =
    process.env.LANGFUSE_BASE_URL?.trim() || process.env.LANGFUSE_HOST?.trim() || DEFAULT_BASE_URL;
  const captureIo = process.env.LANGFUSE_CAPTURE_IO !== "0";
  const maxIoChars = Number(process.env.LANGFUSE_MAX_IO_CHARS ?? DEFAULT_MAX_IO_CHARS);

  configCache = {
    publicKey,
    secretKey,
    baseUrl: rawBase.replace(/\/+$/, ""),
    captureIo,
    maxIoChars: Number.isFinite(maxIoChars) && maxIoChars > 0 ? maxIoChars : DEFAULT_MAX_IO_CHARS,
  };
  return configCache;
}

/** True when Langfuse credentials are present and telemetry will be sent. */
export function isTelemetryEnabled(): boolean {
  return readConfig() !== null;
}

/** Test hook: forget the memoized config so the next call re-reads env. */
export function resetTelemetryConfig(): void {
  configCache = undefined;
}

// Pluggable transport so tests can assert on the outgoing batch without a network.
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
let transport: FetchLike | undefined;

/** Test hook: swap the HTTP transport. Pass undefined to restore global fetch. */
export function setTelemetryTransport(fn: FetchLike | undefined): void {
  transport = fn;
}

function getFetch(): FetchLike {
  return transport ?? (globalThis.fetch as FetchLike);
}

export type TelemetryUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
};

export type GenerationInput = {
  /** Call-site label (becomes the trace + generation name), e.g. "compliance-brief". */
  name: string;
  /** Resolved model id. */
  model?: string;
  /** Prompt text. */
  input?: string;
  /** Completion text. */
  output?: string;
  startTime: Date;
  endTime: Date;
  usage?: TelemetryUsage;
  /** Total USD cost reported by the CLI (total_cost_usd). */
  costUsd?: number;
  /** CLI-reported wall duration. */
  durationMs?: number;
  /** The app being reviewed — grouped as the Langfuse session/userId. */
  appSlug?: string;
  /** Set when the call failed; flips the generation level to ERROR. */
  errorMessage?: string;
  /** Extra metadata to merge in. */
  extra?: Record<string, unknown>;
};

function clip(s: string | undefined, max: number): string | undefined {
  if (s === undefined) return undefined;
  if (s.length <= max) return s;
  return `${s.slice(0, max)}… [truncated ${s.length - max} chars]`;
}

/**
 * Build the two-event Langfuse batch (a trace plus its single generation) for one Claude call.
 * Exported for unit-testing the wire format.
 */
export function buildGenerationBatch(
  input: GenerationInput,
  cfg: { captureIo: boolean; maxIoChars: number },
): unknown[] {
  const traceId = randomUUID();
  const observationId = randomUUID();
  const nowIso = input.endTime.toISOString();

  const u = input.usage ?? {};
  const promptTokens = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheCreationTokens ?? 0);
  const completionTokens = u.outputTokens ?? 0;
  const hasUsage = promptTokens > 0 || completionTokens > 0;

  const usage = hasUsage
    ? { input: promptTokens, output: completionTokens, total: promptTokens + completionTokens, unit: "TOKENS" as const }
    : undefined;
  const costDetails =
    typeof input.costUsd === "number" && input.costUsd > 0 ? { total: input.costUsd } : undefined;

  const isError = Boolean(input.errorMessage);
  const level = isError ? "ERROR" : "DEFAULT";

  const metadata: Record<string, unknown> = {
    product: "deployment-platform",
    durationMs: input.durationMs,
    costUsd: input.costUsd,
    cacheReadTokens: u.cacheReadTokens,
    cacheCreationTokens: u.cacheCreationTokens,
    ...input.extra,
  };

  const io = cfg.captureIo
    ? { input: clip(input.input, cfg.maxIoChars), output: clip(input.output, cfg.maxIoChars) }
    : {};

  const tags = ["deployment-platform", "compliance", input.name];
  const userId = input.appSlug ? `app-${input.appSlug}` : undefined;
  const sessionId = input.appSlug ? `review-${input.appSlug}` : undefined;

  const traceEvent = {
    id: randomUUID(),
    type: "trace-create",
    timestamp: nowIso,
    body: {
      id: traceId,
      timestamp: input.startTime.toISOString(),
      name: input.name,
      ...(userId ? { userId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...io,
      tags,
      metadata,
    },
  };

  const generationEvent = {
    id: randomUUID(),
    type: "generation-create",
    timestamp: nowIso,
    body: {
      id: observationId,
      traceId,
      name: input.name,
      startTime: input.startTime.toISOString(),
      endTime: input.endTime.toISOString(),
      model: input.model ?? DEFAULT_MODEL,
      ...io,
      ...(usage ? { usage } : {}),
      ...(costDetails ? { costDetails } : {}),
      level,
      ...(isError ? { statusMessage: input.errorMessage } : {}),
      metadata,
    },
  };

  return [traceEvent, generationEvent];
}

// In-flight POST promises, awaited by flushTelemetry() before the CLI exits.
const inflight = new Set<Promise<void>>();

async function postBatch(cfg: TelemetryConfig, batch: unknown[]): Promise<void> {
  const auth = Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString("base64");
  const res = await getFetch()(`${cfg.baseUrl}/api/public/ingestion`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
    body: JSON.stringify({ batch }),
    signal: AbortSignal.timeout(10_000),
  });
  // 207 Multi-Status is the success shape (per-event results); 200/201 also ok.
  if (!res.ok && res.status !== 207) {
    const text = await res.text().catch(() => "");
    throw new Error(`langfuse ingestion ${res.status}: ${text.slice(0, 200)}`);
  }
}

/**
 * Record one Claude call as a Langfuse generation. Fire-and-forget: returns immediately with the
 * POST tracked in `inflight`. Never throws — a telemetry failure must not affect the review.
 */
export function recordGeneration(input: GenerationInput): void {
  const cfg = readConfig();
  if (!cfg) return;

  let batch: unknown[];
  try {
    batch = buildGenerationBatch(input, cfg);
  } catch {
    return;
  }

  const p = postBatch(cfg, batch)
    .catch(() => {
      /* swallow — fire-and-forget */
    })
    .finally(() => {
      inflight.delete(p);
    });
  inflight.add(p);
}

/** Await all in-flight telemetry POSTs. Called before the CLI exits so the last event isn't dropped. */
export async function flushTelemetry(): Promise<void> {
  if (inflight.size === 0) return;
  await Promise.allSettled([...inflight]);
}
