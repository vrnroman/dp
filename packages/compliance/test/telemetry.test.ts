import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGenerationBatch,
  recordGeneration,
  resetTelemetryConfig,
  setTelemetryTransport,
  flushTelemetry,
  isTelemetryEnabled,
} from "../src/telemetry.ts";

const start = new Date("2026-06-29T00:00:00.000Z");
const end = new Date("2026-06-29T00:00:05.000Z");

test("a Claude call becomes a Langfuse trace + generation with aggregated usage", () => {
  const batch = buildGenerationBatch(
    {
      name: "compliance-brief",
      input: "prompt",
      output: "answer",
      startTime: start,
      endTime: end,
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheCreationTokens: 50 },
      costUsd: 0.012,
      appSlug: "guestbook",
    },
    { captureIo: true, maxIoChars: 1000 },
  ) as Array<{ type: string; body: Record<string, any> }>;

  assert.equal(batch.length, 2);
  const [trace, gen] = batch;
  assert.equal(trace.type, "trace-create");
  assert.equal(gen.type, "generation-create");
  assert.equal(gen.body.model, "claude-opus-4-8");
  // prompt tokens = input + cacheRead + cacheCreation = 450; completion = 20.
  assert.equal(gen.body.usage.input, 450);
  assert.equal(gen.body.usage.output, 20);
  assert.equal(gen.body.usage.total, 470);
  assert.equal(gen.body.costDetails.total, 0.012);
  assert.equal(trace.body.userId, "app-guestbook");
  assert.equal(trace.body.metadata.product, "deployment-platform");
});

test("a failed call is recorded at ERROR level with the message", () => {
  const [, gen] = buildGenerationBatch(
    { name: "compliance-brief", startTime: start, endTime: end, errorMessage: "claude exited 1" },
    { captureIo: false, maxIoChars: 10 },
  ) as Array<{ body: Record<string, any> }>;
  assert.equal(gen.body.level, "ERROR");
  assert.equal(gen.body.statusMessage, "claude exited 1");
  // captureIo:false → no prompt/output leaked.
  assert.equal(gen.body.input, undefined);
});

test("with no Langfuse keys the module is a silent no-op", () => {
  const pub = process.env.LANGFUSE_PUBLIC_KEY;
  const sec = process.env.LANGFUSE_SECRET_KEY;
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_SECRET_KEY;
  resetTelemetryConfig();
  assert.equal(isTelemetryEnabled(), false);
  recordGeneration({ name: "x", startTime: start, endTime: end }); // must not throw or POST
  if (pub !== undefined) process.env.LANGFUSE_PUBLIC_KEY = pub;
  if (sec !== undefined) process.env.LANGFUSE_SECRET_KEY = sec;
  resetTelemetryConfig();
});

test("with keys set, recordGeneration POSTs one ingestion batch", async () => {
  process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
  process.env.LANGFUSE_SECRET_KEY = "sk-test";
  process.env.LANGFUSE_BASE_URL = "https://example.invalid";
  resetTelemetryConfig();

  let posted: { url: string; body: any } | null = null;
  setTelemetryTransport(async (url, init) => {
    posted = { url, body: JSON.parse(String(init.body)) };
    return new Response("{}", { status: 207 });
  });

  recordGeneration({ name: "compliance-brief", input: "p", output: "a", startTime: start, endTime: end });
  await flushTelemetry();

  assert.ok(posted, "a batch should have been POSTed");
  assert.match(posted!.url, /\/api\/public\/ingestion$/);
  assert.equal(posted!.body.batch.length, 2);

  setTelemetryTransport(undefined);
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_SECRET_KEY;
  delete process.env.LANGFUSE_BASE_URL;
  resetTelemetryConfig();
});
