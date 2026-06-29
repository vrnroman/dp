/**
 * `deployctl review [app]` — the compliance evaluator's command.
 *
 * Produces a deployment APPROVAL BRIEF: what the app does, what it's built with, which external
 * systems it connects to, what data it holds — plus a rule-based verdict (allowed / needs-review /
 * blocked) a person can act on. Today it runs against the personal stack as a proof of concept for
 * the org cell. The AI brief runs on `claude -p` (subscription) and is traced to Langfuse.
 */
import { resolve, basename, join } from "node:path";
import { writeFileSync } from "node:fs";
import { checkApp, renderReport } from "@platform/conformance";
import { review, renderApprovalCard, renderApprovalMarkdown, flushTelemetry, isTelemetryEnabled } from "@platform/compliance";
import { loadDotenv } from "../util/dotenv.ts";

export interface ReviewOptions {
  brief?: boolean; // commander sets false when --no-brief is passed
  json?: boolean;
}

export async function runReview(appDirArg: string, opts: ReviewOptions): Promise<number> {
  // Pick up LANGFUSE_* (and any other) keys from a repo-root or app-local .env, so the trace lands
  // in deployment-platform's own Langfuse project without the user exporting vars by hand.
  loadDotenv();

  const appDir = resolve(appDirArg || ".");
  const report = checkApp(appDir);
  if (!report.manifest) {
    process.stdout.write(renderReport(report, basename(appDir)) + "\n");
    process.stdout.write("\nThe app needs a valid deploy file before it can be reviewed.\n");
    return 1;
  }

  const skipBrief = opts.brief === false;
  if (!skipBrief && !isTelemetryEnabled()) {
    process.stdout.write(
      "Note: Langfuse keys are not set, so this review's AI call will not be traced. " +
        "Set LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY (and LANGFUSE_BASE_URL) to record it.\n\n",
    );
  }

  const result = await review(appDir, report.manifest, { skipBrief });
  await flushTelemetry();

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(renderApprovalCard(result) + "\n");
    const cardPath = join(appDir, `${report.manifest.name}-approval.md`);
    try {
      writeFileSync(cardPath, renderApprovalMarkdown(result));
      process.stdout.write(`\nSaved an approval record you can share: ${cardPath}\n`);
    } catch {
      /* non-fatal */
    }
  }

  // Auto-approvable only when nothing needs a human. Non-zero otherwise, so this can gate later.
  return result.verdict.decision === "allowed" ? 0 : 1;
}
