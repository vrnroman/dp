import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGenerationSpan,
  postSpan,
  recordGeneration,
  resetTelemetryConfig,
  setTelemetryTransport,
  flushTelemetry,
  isTelemetryEnabled,
} from "../src/telemetry.ts";

const start = new Date("2026-06-29T00:00:00.000Z");
const end = new Date("2026-06-29T00:00:05.000Z");

type Span = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: Record<string, any> }>;
  status: { code: number; message?: string };
};

/** The request must carry exactly one resource, one scope, one span. */
function onlySpan(payload: unknown): Span {
  const p = payload as { resourceSpans: Array<{ resource: any; scopeSpans: Array<{ scope: any; spans: Span[] }> }> };
  assert.equal(p.resourceSpans.length, 1);
  assert.equal(p.resourceSpans[0].scopeSpans.length, 1);
  assert.equal(p.resourceSpans[0].scopeSpans[0].spans.length, 1);
  return p.resourceSpans[0].scopeSpans[0].spans[0];
}

function attrsOf(span: Span): Record<string, Record<string, any>> {
  return Object.fromEntries(span.attributes.map((a) => [a.key, a.value]));
}

const FULL = {
  name: "compliance-brief",
  input: "prompt",
  output: "answer",
  startTime: start,
  endTime: end,
  usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheCreationTokens: 50 },
  costUsd: 0.012,
  durationMs: 5000,
  appSlug: "guestbook",
};

test("a Claude call becomes ONE complete OTLP root span of type generation", () => {
  const payload = buildGenerationSpan(FULL, { captureIo: true, maxIoChars: 1000 }) as any;
  const span = onlySpan(payload);

  // OTLP/JSON to the letter: hex ids of the right width, int64 nanos as decimal strings.
  assert.match(span.traceId, /^[0-9a-f]{32}$/);
  assert.match(span.spanId, /^[0-9a-f]{16}$/);
  assert.equal(span.parentSpanId, undefined);
  assert.equal(span.name, "compliance-brief");
  assert.equal(span.startTimeUnixNano, `${start.getTime()}000000`);
  assert.equal(span.endTimeUnixNano, `${end.getTime()}000000`);
  assert.equal(typeof span.startTimeUnixNano, "string");
  assert.deepEqual(span.status, { code: 1 });

  assert.deepEqual(payload.resourceSpans[0].resource.attributes, [
    { key: "service.name", value: { stringValue: "deployment-platform" } },
  ]);
  assert.equal(payload.resourceSpans[0].scopeSpans[0].scope.name, "dp-compliance-telemetry");
  // The legacy event-batch shape is gone.
  assert.equal(payload.batch, undefined);

  const a = attrsOf(span);
  assert.deepEqual(a["langfuse.observation.type"], { stringValue: "generation" });
  assert.deepEqual(a["langfuse.trace.name"], { stringValue: "compliance-brief" });
  assert.deepEqual(a["langfuse.trace.tags"], {
    arrayValue: {
      values: [
        { stringValue: "deployment-platform" },
        { stringValue: "compliance" },
        { stringValue: "compliance-brief" },
      ],
    },
  });
  assert.deepEqual(a["langfuse.observation.model.name"], { stringValue: "claude-opus-4-8" });
  assert.deepEqual(a["langfuse.observation.level"], { stringValue: "DEFAULT" });
  assert.equal(a["langfuse.observation.status_message"], undefined);
});

test("two calls never share an id (a re-sent id would duplicate the observation)", () => {
  const cfg = { captureIo: true, maxIoChars: 1000 };
  const one = onlySpan(buildGenerationSpan(FULL, cfg));
  const two = onlySpan(buildGenerationSpan(FULL, cfg));
  assert.notEqual(one.traceId, two.traceId);
  assert.notEqual(one.spanId, two.spanId);
});

test("usage and cost ride as JSON strings with aggregated prompt tokens — and are absent without them", () => {
  const cfg = { captureIo: true, maxIoChars: 1000 };
  const a = attrsOf(onlySpan(buildGenerationSpan(FULL, cfg)));
  // prompt tokens = input + cacheRead + cacheCreation = 450; completion = 20.
  assert.equal(typeof a["langfuse.observation.usage_details"].stringValue, "string");
  assert.deepEqual(JSON.parse(a["langfuse.observation.usage_details"].stringValue), {
    input: 450,
    output: 20,
    total: 470,
  });
  assert.deepEqual(JSON.parse(a["langfuse.observation.cost_details"].stringValue), { total: 0.012 });

  const bare = attrsOf(
    onlySpan(buildGenerationSpan({ ...FULL, usage: undefined, costUsd: 0 }, cfg)),
  );
  assert.equal(bare["langfuse.observation.usage_details"], undefined);
  assert.equal(bare["langfuse.observation.cost_details"], undefined);
});

test("user and session ids ride the observation with an appSlug, and are absent without one", () => {
  const cfg = { captureIo: true, maxIoChars: 1000 };
  const a = attrsOf(onlySpan(buildGenerationSpan(FULL, cfg)));
  assert.deepEqual(a["langfuse.user.id"], { stringValue: "app-guestbook" });
  assert.deepEqual(a["langfuse.session.id"], { stringValue: "review-guestbook" });

  const anon = attrsOf(onlySpan(buildGenerationSpan({ ...FULL, appSlug: undefined }, cfg)));
  assert.equal(anon["langfuse.user.id"], undefined);
  assert.equal(anon["langfuse.session.id"], undefined);
});

test("input/output sit on the root observation when captureIo, are absent when not, and never use trace io", () => {
  const on = attrsOf(onlySpan(buildGenerationSpan(FULL, { captureIo: true, maxIoChars: 1000 })));
  assert.deepEqual(on["langfuse.observation.input"], { stringValue: "prompt" });
  assert.deepEqual(on["langfuse.observation.output"], { stringValue: "answer" });

  const offPayload = buildGenerationSpan(FULL, { captureIo: false, maxIoChars: 1000 });
  const off = attrsOf(onlySpan(offPayload));
  assert.equal(off["langfuse.observation.input"], undefined);
  assert.equal(off["langfuse.observation.output"], undefined);
  // captureIo:false → the prompt/completion text is nowhere on the wire.
  assert.ok(!JSON.stringify(offPayload).includes('"prompt"'));
  assert.ok(!JSON.stringify(offPayload).includes('"answer"'));

  // Deprecated trace-level io is never emitted, in either mode.
  for (const a of [on, off]) {
    assert.equal(a["langfuse.trace.input"], undefined);
    assert.equal(a["langfuse.trace.output"], undefined);
  }
});

test("input/output beyond maxIoChars are clipped; shorter ones are sent as-is", () => {
  const big = "x".repeat(5000);
  const a = attrsOf(
    onlySpan(buildGenerationSpan({ ...FULL, output: big }, { captureIo: true, maxIoChars: 100 })),
  );
  const out = a["langfuse.observation.output"].stringValue as string;
  assert.ok(out.length < big.length);
  assert.ok(out.startsWith("x".repeat(100)));
  assert.match(out, /truncated 4900 chars/);
  assert.deepEqual(a["langfuse.observation.input"], { stringValue: "prompt" });
});

test("metadata rides as typed langfuse.observation.metadata.* attributes; undefined/null are skipped", () => {
  const a = attrsOf(
    onlySpan(
      buildGenerationSpan(
        { ...FULL, extra: { facts: 7, ratio: 0.5, dryRun: true, controls: ["a", "b"], skipped: undefined, nothing: null } },
        { captureIo: false, maxIoChars: 10 },
      ),
    ),
  );
  assert.deepEqual(a["langfuse.observation.metadata.product"], { stringValue: "deployment-platform" });
  assert.deepEqual(a["langfuse.observation.metadata.durationMs"], { intValue: "5000" });
  assert.deepEqual(a["langfuse.observation.metadata.costUsd"], { doubleValue: 0.012 });
  assert.deepEqual(a["langfuse.observation.metadata.cacheReadTokens"], { intValue: "300" });
  assert.deepEqual(a["langfuse.observation.metadata.cacheCreationTokens"], { intValue: "50" });
  assert.deepEqual(a["langfuse.observation.metadata.facts"], { intValue: "7" });
  assert.deepEqual(a["langfuse.observation.metadata.ratio"], { doubleValue: 0.5 });
  assert.deepEqual(a["langfuse.observation.metadata.dryRun"], { boolValue: true });
  assert.deepEqual(a["langfuse.observation.metadata.controls"], { stringValue: '["a","b"]' });
  assert.equal(a["langfuse.observation.metadata.skipped"], undefined);
  assert.equal(a["langfuse.observation.metadata.nothing"], undefined);
});

test("a failed call is ERROR with the message and span status 2; a good call is DEFAULT with status 1", () => {
  const bad = onlySpan(
    buildGenerationSpan(
      { name: "compliance-brief", startTime: start, endTime: end, errorMessage: "claude exited 1" },
      { captureIo: false, maxIoChars: 10 },
    ),
  );
  const a = attrsOf(bad);
  assert.deepEqual(a["langfuse.observation.level"], { stringValue: "ERROR" });
  assert.deepEqual(a["langfuse.observation.status_message"], { stringValue: "claude exited 1" });
  assert.deepEqual(bad.status, { code: 2, message: "claude exited 1" });

  const good = onlySpan(
    buildGenerationSpan({ name: "compliance-brief", startTime: start, endTime: end }, { captureIo: false, maxIoChars: 10 }),
  );
  assert.deepEqual(attrsOf(good)["langfuse.observation.level"], { stringValue: "DEFAULT" });
  assert.equal(attrsOf(good)["langfuse.observation.status_message"], undefined);
  assert.deepEqual(good.status, { code: 1 });
});

test("with no Langfuse keys the module is a silent no-op that sends nothing", async () => {
  const pub = process.env.LANGFUSE_PUBLIC_KEY;
  const sec = process.env.LANGFUSE_SECRET_KEY;
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_SECRET_KEY;
  resetTelemetryConfig();
  let called = 0;
  setTelemetryTransport(async () => {
    called += 1;
    return new Response("{}", { status: 200 });
  });

  assert.equal(isTelemetryEnabled(), false);
  recordGeneration({ name: "x", startTime: start, endTime: end }); // must not throw or POST
  await flushTelemetry();
  assert.equal(called, 0);

  setTelemetryTransport(undefined);
  if (pub !== undefined) process.env.LANGFUSE_PUBLIC_KEY = pub;
  if (sec !== undefined) process.env.LANGFUSE_SECRET_KEY = sec;
  resetTelemetryConfig();
});

function enable(): void {
  process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
  process.env.LANGFUSE_SECRET_KEY = "sk-test";
  process.env.LANGFUSE_BASE_URL = "https://example.invalid/";
  resetTelemetryConfig();
}

function disable(): void {
  setTelemetryTransport(undefined);
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_SECRET_KEY;
  delete process.env.LANGFUSE_BASE_URL;
  resetTelemetryConfig();
}

test("with keys set, recordGeneration POSTs ONE OTLP request with the v4 header, never the legacy endpoint", async () => {
  enable();

  const posted: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  setTelemetryTransport(async (url, init) => {
    posted.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response("{}", { status: 200 });
  });

  recordGeneration({ name: "compliance-brief", input: "p", output: "a", startTime: start, endTime: end });
  await flushTelemetry();

  assert.equal(posted.length, 1, "exactly one request should have been POSTed");
  assert.equal(posted[0].url, "https://example.invalid/api/public/otel/v1/traces");
  assert.ok(!posted[0].url.includes("/api/public/ingestion"));
  assert.equal(posted[0].headers["x-langfuse-ingestion-version"], "4");
  assert.equal(posted[0].headers["content-type"], "application/json");
  assert.equal(posted[0].headers.authorization, `Basic ${Buffer.from("pk-test:sk-test").toString("base64")}`);
  assert.equal(posted[0].body.batch, undefined);
  const span = onlySpan(posted[0].body);
  assert.equal(span.name, "compliance-brief");
  assert.deepEqual(attrsOf(span)["langfuse.observation.input"], { stringValue: "p" });

  disable();
});

test("postSpan rejects on a non-2xx and on a 2xx that rejects spans; accepts a clean or bodiless 2xx", async () => {
  const cfg = { publicKey: "pk-test", secretKey: "sk-test", baseUrl: "https://example.invalid" };
  const payload = buildGenerationSpan(FULL, { captureIo: false, maxIoChars: 10 });

  setTelemetryTransport(async () => new Response("unauthorized", { status: 401 }));
  await assert.rejects(postSpan(cfg, payload), /langfuse otel 401: unauthorized/);

  setTelemetryTransport(
    async () => new Response(JSON.stringify({ partialSuccess: { rejectedSpans: "1", errorMessage: "bad span" } }), { status: 200 }),
  );
  await assert.rejects(postSpan(cfg, payload), /rejected 1 span\(s\): bad span/);

  setTelemetryTransport(async () => new Response(JSON.stringify({ partialSuccess: { rejectedSpans: 2 } }), { status: 200 }));
  await assert.rejects(postSpan(cfg, payload), /rejected 2 span/);

  // The other direction: clean accepts, in every body shape OTLP servers use.
  setTelemetryTransport(async () => new Response("{}", { status: 200 }));
  await assert.doesNotReject(postSpan(cfg, payload));
  setTelemetryTransport(async () => new Response(JSON.stringify({ partialSuccess: {} }), { status: 200 }));
  await assert.doesNotReject(postSpan(cfg, payload));
  setTelemetryTransport(async () => new Response(JSON.stringify({ partialSuccess: { rejectedSpans: 0 } }), { status: 200 }));
  await assert.doesNotReject(postSpan(cfg, payload));
  setTelemetryTransport(async () => new Response("", { status: 200 }));
  await assert.doesNotReject(postSpan(cfg, payload));
  setTelemetryTransport(async () => new Response("not json", { status: 202 }));
  await assert.doesNotReject(postSpan(cfg, payload));

  setTelemetryTransport(undefined);
});

test("a refusal never reaches the caller: non-2xx, rejected spans, and a transport explosion all resolve", async () => {
  enable();
  const input = { name: "compliance-brief", startTime: start, endTime: end };

  let calls = 0;
  setTelemetryTransport(async () => {
    calls += 1;
    return new Response("nope", { status: 500 });
  });
  assert.doesNotThrow(() => recordGeneration(input));
  await assert.doesNotReject(flushTelemetry());

  setTelemetryTransport(async () => {
    calls += 1;
    return new Response(JSON.stringify({ partialSuccess: { rejectedSpans: 1 } }), { status: 200 });
  });
  assert.doesNotThrow(() => recordGeneration(input));
  await assert.doesNotReject(flushTelemetry());

  setTelemetryTransport(async () => {
    calls += 1;
    throw new Error("ECONNREFUSED");
  });
  assert.doesNotThrow(() => recordGeneration(input));
  await assert.doesNotReject(flushTelemetry());

  // Each refusal was a real attempt, not a skipped send.
  assert.equal(calls, 3);

  disable();
});
