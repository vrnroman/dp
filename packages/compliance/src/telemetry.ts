/**
 * telemetry.ts — Langfuse observability for the compliance evaluator's LLM calls.
 *
 * The evaluator runs on the Claude Code CLI (`claude -p`, subscription auth), NOT the
 * Anthropic SDK, so there is no SDK auto-instrumentation. We treat each `claude -p` round-trip
 * as one Langfuse *generation* and POST it to Langfuse's OpenTelemetry endpoint ourselves. This
 * mirrors the proven approach in the echo-v0 bot, kept deliberately minimal here.
 *
 * Wire format (Langfuse v4, observations-first): there is no trace entity to create. One finished
 * call is ONE complete root span of type `generation`, exported exactly once as OTLP/HTTP JSON to
 * `/api/public/otel/v1/traces` with the `x-langfuse-ingestion-version: 4` header. The legacy
 * event-batch endpoint is removed on Langfuse Cloud on 2026-11-16.
 *
 * Design constraints (same as echo):
 *  - ZERO npm dependencies. The export is one authenticated POST; we build the OTLP span by
 *    hand. Keeps the package install-free beyond its workspace deps.
 *  - Fully OPT-IN. With LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY unset the module is a no-op,
 *    so tests and offline runs never emit.
 *  - NEVER throws into the caller. Telemetry is fire-and-forget; a Langfuse outage must not
 *    break a deploy review.
 *
 * IMPORTANT: this uses its OWN Langfuse project keys (separate from echo and any other project),
 * so deployment-platform traces never mix with another product's.
 */
import { randomBytes } from "node:crypto";

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

// Pluggable transport so tests can assert on the outgoing span without a network.
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

type OtlpValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean }
  | { arrayValue: { values: OtlpValue[] } };
type OtlpAttribute = { key: string; value: OtlpValue };

/** Typed OTLP value: numbers and booleans stay typed, anything structured rides as a JSON string. */
function otlpValue(v: unknown): OtlpValue {
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "number" && Number.isFinite(v)) {
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === "boolean") return { boolValue: v };
  return { stringValue: JSON.stringify(v) ?? String(v) };
}

/** OTLP JSON carries int64 nanoseconds as a decimal string. */
function unixNano(d: Date): string {
  return `${d.getTime()}000000`;
}

/**
 * Build the OTLP request (one complete root `generation` span) for one Claude call.
 * Exported for unit-testing the wire format.
 */
export function buildGenerationSpan(
  input: GenerationInput,
  cfg: { captureIo: boolean; maxIoChars: number },
): unknown {
  const u = input.usage ?? {};
  const promptTokens = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheCreationTokens ?? 0);
  const completionTokens = u.outputTokens ?? 0;
  const hasUsage = promptTokens > 0 || completionTokens > 0;

  const isError = Boolean(input.errorMessage);

  const metadata: Record<string, unknown> = {
    product: "deployment-platform",
    durationMs: input.durationMs,
    costUsd: input.costUsd,
    cacheReadTokens: u.cacheReadTokens,
    cacheCreationTokens: u.cacheCreationTokens,
    ...input.extra,
  };

  const attributes: OtlpAttribute[] = [];
  const put = (key: string, v: unknown): void => {
    if (v !== undefined && v !== null) attributes.push({ key, value: otlpValue(v) });
  };

  put("langfuse.observation.type", "generation");
  put("langfuse.trace.name", input.name);
  attributes.push({
    key: "langfuse.trace.tags",
    value: {
      arrayValue: {
        values: ["deployment-platform", "compliance", input.name].map((t) => ({ stringValue: t })),
      },
    },
  });
  // v4 queries observations directly, so the grouping ids ride the observation itself.
  if (input.appSlug) {
    put("langfuse.user.id", `app-${input.appSlug}`);
    put("langfuse.session.id", `review-${input.appSlug}`);
  }
  // The overall request/response lives on the root observation (there is no trace input/output).
  if (cfg.captureIo) {
    put("langfuse.observation.input", clip(input.input, cfg.maxIoChars));
    put("langfuse.observation.output", clip(input.output, cfg.maxIoChars));
  }
  put("langfuse.observation.model.name", input.model ?? DEFAULT_MODEL);
  if (hasUsage) {
    // OTLP attributes cannot nest: usage and cost ride as JSON strings.
    put(
      "langfuse.observation.usage_details",
      JSON.stringify({ input: promptTokens, output: completionTokens, total: promptTokens + completionTokens }),
    );
  }
  if (typeof input.costUsd === "number" && input.costUsd > 0) {
    put("langfuse.observation.cost_details", JSON.stringify({ total: input.costUsd }));
  }
  put("langfuse.observation.level", isError ? "ERROR" : "DEFAULT");
  if (isError) put("langfuse.observation.status_message", input.errorMessage);
  for (const [key, v] of Object.entries(metadata)) put(`langfuse.observation.metadata.${key}`, v);

  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "deployment-platform" } }] },
        scopeSpans: [
          {
            scope: { name: "dp-compliance-telemetry" },
            spans: [
              {
                traceId: randomBytes(16).toString("hex"),
                spanId: randomBytes(8).toString("hex"),
                name: input.name,
                kind: 1, // SPAN_KIND_INTERNAL
                startTimeUnixNano: unixNano(input.startTime),
                endTimeUnixNano: unixNano(input.endTime),
                attributes,
                status: isError ? { code: 2, message: input.errorMessage } : { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
}

// In-flight POST promises, awaited by flushTelemetry() before the CLI exits.
const inflight = new Set<Promise<void>>();

/**
 * POST one OTLP request. Rejects when Langfuse refuses it — by status, or by a 2xx whose body
 * reports rejected spans (OTLP answers 200 even then). Exported for unit-testing the send path;
 * callers use recordGeneration, which swallows the rejection.
 */
export async function postSpan(
  cfg: { publicKey: string; secretKey: string; baseUrl: string },
  payload: unknown,
): Promise<void> {
  const auth = Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString("base64");
  const res = await getFetch()(`${cfg.baseUrl}/api/public/otel/v1/traces`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${auth}`,
      "x-langfuse-ingestion-version": "4",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`langfuse otel ${res.status}: ${text.slice(0, 200)}`);
  }
  // An empty or non-JSON 2xx body is a clean accept.
  const reply = (await res.json().catch(() => null)) as {
    partialSuccess?: { rejectedSpans?: number | string; errorMessage?: string };
  } | null;
  const rejected = Number(reply?.partialSuccess?.rejectedSpans ?? 0);
  if (rejected > 0) {
    throw new Error(
      `langfuse otel rejected ${rejected} span(s): ${String(reply?.partialSuccess?.errorMessage ?? "").slice(0, 200)}`,
    );
  }
}

/**
 * Record one Claude call as a Langfuse generation. Fire-and-forget: returns immediately with the
 * POST tracked in `inflight`. Never throws — a telemetry failure must not affect the review.
 */
export function recordGeneration(input: GenerationInput): void {
  const cfg = readConfig();
  if (!cfg) return;

  let payload: unknown;
  try {
    payload = buildGenerationSpan(input, cfg);
  } catch {
    return;
  }

  const p = postSpan(cfg, payload)
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
