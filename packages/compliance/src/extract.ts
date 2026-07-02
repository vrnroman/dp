/**
 * extract.ts — the deterministic, trustworthy half of a compliance review.
 *
 * An approver must be able to TRUST "which systems does this connect to?" and "what data does it
 * hold?" — so those facts are pulled straight from the code and manifest here, with no model in
 * the loop. The AI (brief.ts) only narrates and judges these facts; it never sources them. This
 * separation is the whole point: a hallucinated outbound host would be a security hole.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Manifest } from "@platform/manifest";

export interface Dependency {
  name: string;
  version: string;
  dev: boolean;
}

/** A coarse bucket an approver understands at a glance. */
export type ServiceCategory =
  | "payments"
  | "ai"
  | "object-storage"
  | "queue"
  | "email"
  | "sms"
  | "database"
  | "analytics"
  | "search"
  | "monitoring"
  | "auth"
  | "other";

/**
 * A named external system the app talks to, fused from up to three deterministic signals: an npm
 * dependency, an env-var (secret) name, and an outbound host. The point is to catch the systems a
 * bare URL scan misses — an S3 bucket, a work queue, a SaaS SDK whose URL lives inside the package,
 * not the app's own source. Everything here is read from the code; nothing is guessed.
 */
export interface ExternalService {
  /** Stable key so the three channels collapse to ONE service (e.g. "stripe", "aws-s3"). */
  key: string;
  /** Outcome-first, plain-English label a non-engineer can approve: "Takes card payments through Stripe". */
  label: string;
  category: ServiceCategory;
  /** The concrete signals that fired, so the fact stays auditable ("uses the \"stripe\" package"). */
  evidence: string[];
  /** Outbound hosts this service explains, so the host list does not double-count them. */
  hosts: string[];
  /** The secret this service appears to ride on, if one is declared (e.g. "STRIPE_SECRET_KEY"). */
  secret?: string;
}

export interface AppFacts {
  name: string;
  blueprint: string;
  framework: string | null;
  runtime: string | null;
  dependencies: Dependency[];
  /** Distinct external hosts the code references (real third-party/own-infra connections). */
  outboundHosts: string[];
  /** Named external systems the app talks to (fused from dependency, secret, and host signals). */
  externalServices: ExternalService[];
  /** True if the app makes outbound network calls at all (even to non-literal hosts). */
  makesNetworkCalls: boolean;
  data: {
    hasDatabase: boolean;
    storageBuckets: string[];
    authTier: string;
    /** Friendly categories of personal data the schema appears to store. */
    personalData: string[];
  };
  secrets: { required: string[]; optional: string[] };
  /** Friendly labels for notable capabilities (shell exec, dynamic code, etc.). */
  capabilities: string[];
}

const SKIP_DIRS = new Set([
  "node_modules", ".next", ".git", ".vercel", "dist", "build", ".turbo", "coverage", "vendor",
]);
const MAX_SCAN_BYTES = 512 * 1024;

const FRAMEWORK_PACKAGE: Record<string, string> = {
  nextjs: "next",
  vite: "vite",
  remix: "@remix-run/dev",
  astro: "astro",
};

// Hosts that appear in source but are NOT real outbound connections: loopback, placeholders,
// XML/SVG/schema namespaces, and framework/doc/registry/marketing sites that only ever show up in
// comments, config, and doc links (e.g. `// see https://nextjs.org/docs/...`). Excluding these
// keeps the "connects to" list honest — real third-party APIs (api.stripe.com, api.openai.com,
// fonts.googleapis.com, …) are NOT in here and still surface for review.
const IGNORE_HOSTS = new Set([
  "localhost", "127.0.0.1", "0.0.0.0", "::1",
  "example.com", "example.org", "example.net", "test.com", "www.example.com",
  // XML / schema namespaces
  "www.w3.org", "w3.org", "schema.org", "json-schema.org", "yaml.org", "ns.adobe.com",
  // framework + language doc/marketing sites
  "nextjs.org", "react.dev", "reactjs.org", "vitejs.dev", "remix.run", "astro.build",
  "nodejs.org", "www.typescriptlang.org", "typescriptlang.org", "tailwindcss.com", "svelte.dev",
  // registries, repos, specs, docs
  "npmjs.com", "www.npmjs.com", "github.com", "www.github.com", "raw.githubusercontent.com",
  "developer.mozilla.org", "mozilla.org", "opensource.org", "creativecommons.org", "spdx.org",
]);

// Personal-data column-name signals → the friendly category an approver understands.
const PERSONAL_DATA: Array<{ re: RegExp; label: string }> = [
  { re: /\b\w*email\w*\b/i, label: "email addresses" },
  { re: /\bphone|mobile|msisdn\b/i, label: "phone numbers" },
  { re: /\b(first_?name|last_?name|full_?name|given_?name|surname)\b/i, label: "names" },
  { re: /\b(address|street|postcode|zip_?code|city)\b/i, label: "postal addresses" },
  { re: /\b(dob|date_of_birth|birth_?date|birthday)\b/i, label: "dates of birth" },
  { re: /\b(ssn|national_id|passport|tax_id)\b/i, label: "government IDs" },
  { re: /\b(card_?number|credit_?card|cvv|iban)\b/i, label: "payment details" },
  { re: /\b(lat|latitude|lng|longitude|geo_?location)\b/i, label: "location data" },
];

// Notable code capabilities worth surfacing to an approver. Advisory, not necessarily bad.
const CAPABILITIES: Array<{ re: RegExp; label: string }> = [
  { re: /\bchild_process\b|\bexecSync\b|\bspawnSync\b/, label: "runs operating-system commands" },
  { re: /\beval\s*\(|new Function\s*\(/, label: "executes code built at runtime" },
  { re: /\bfetch\s*\(|\baxios\b|XMLHttpRequest|node-fetch|\bgot\s*\(|https?\.request\s*\(/, label: "makes outbound network requests" },
  { re: /\bfs\.(writeFile|writeFileSync|rm|rmSync|unlink|unlinkSync)\b/, label: "writes or deletes files on the server" },
];

const URL_RE = /\bhttps?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?/gi;

/**
 * The external-service fingerprint table — the curated, conservative core of "what does this app
 * connect to?" Each entry maps three deterministic signals to one plain-English service:
 *   - `deps`    : exact npm package names (direct dependencies only — no lockfile walking)
 *   - `secrets` : an env-var-name pattern (catches a SaaS used via a secret even with no SDK or URL)
 *   - `hosts`   : an outbound-host pattern (names a raw host, so api.stripe.com reads as "Stripe")
 * A service surfaces if ANY channel fires; the channels fuse into one line. Deliberately excluded:
 * the platform's own stack (Supabase, Vercel) and generic SQL drivers (pg, mysql) that just reach
 * the database the platform itself provisions — those are not third-party systems to approve.
 */
interface Fingerprint {
  key: string;
  label: string;
  category: ServiceCategory;
  deps?: string[];
  secrets?: RegExp;
  hosts?: RegExp;
}

const FINGERPRINTS: Fingerprint[] = [
  // Payments
  { key: "stripe", label: "Takes card payments through Stripe", category: "payments", deps: ["stripe", "@stripe/stripe-js"], secrets: /^STRIPE_/i, hosts: /(^|\.)stripe\.com$/ },
  { key: "braintree", label: "Takes payments through Braintree", category: "payments", deps: ["braintree"] },
  { key: "paypal", label: "Takes payments through PayPal", category: "payments", deps: ["@paypal/checkout-server-sdk", "paypal-rest-sdk"] },
  { key: "razorpay", label: "Takes payments through Razorpay", category: "payments", deps: ["razorpay"], secrets: /^RAZORPAY_/i },
  // AI / LLM
  { key: "openai", label: "Sends text to OpenAI", category: "ai", deps: ["openai"], secrets: /^OPENAI_/i, hosts: /(^|\.)openai\.com$/ },
  { key: "anthropic", label: "Sends text to Anthropic (Claude)", category: "ai", deps: ["@anthropic-ai/sdk"], secrets: /^ANTHROPIC_/i, hosts: /(^|\.)anthropic\.com$/ },
  { key: "gemini", label: "Sends text to Google Gemini", category: "ai", deps: ["@google/generative-ai"], hosts: /generativelanguage\.googleapis\.com$/ },
  { key: "cohere", label: "Sends text to Cohere", category: "ai", deps: ["cohere-ai"], secrets: /^COHERE_/i },
  { key: "replicate", label: "Runs AI models on Replicate", category: "ai", deps: ["replicate"], secrets: /^REPLICATE_/i, hosts: /(^|\.)replicate\.com$/ },
  // Object storage
  { key: "aws-s3", label: "Keeps files on Amazon S3", category: "object-storage", deps: ["@aws-sdk/client-s3"], secrets: /^(AWS_S3|S3_BUCKET|S3_ACCESS)/i, hosts: /(^s3[.-]|\.s3[.-]|\.s3\.).*amazonaws\.com$/ },
  { key: "gcs", label: "Keeps files on Google Cloud Storage", category: "object-storage", deps: ["@google-cloud/storage"], hosts: /storage\.googleapis\.com$/ },
  { key: "azure-blob", label: "Keeps files on Azure Blob Storage", category: "object-storage", deps: ["@azure/storage-blob"], hosts: /\.blob\.core\.windows\.net$/ },
  { key: "minio", label: "Keeps files on S3-compatible storage (MinIO)", category: "object-storage", deps: ["minio"] },
  { key: "cloudinary", label: "Stores and serves images on Cloudinary", category: "object-storage", deps: ["cloudinary"], secrets: /^CLOUDINARY_/i, hosts: /(^|\.)cloudinary\.com$/ },
  // Queues / messaging
  { key: "aws-sqs", label: "Uses an Amazon SQS work queue", category: "queue", deps: ["@aws-sdk/client-sqs"], hosts: /sqs\..*amazonaws\.com$/ },
  { key: "bullmq", label: "Runs a background work queue (BullMQ on Redis)", category: "queue", deps: ["bullmq", "bull"] },
  { key: "rabbitmq", label: "Uses a RabbitMQ message queue", category: "queue", deps: ["amqplib", "amqp-connection-manager"], secrets: /^(RABBITMQ|AMQP)_/i },
  { key: "kafka", label: "Streams messages through Apache Kafka", category: "queue", deps: ["kafkajs"] },
  { key: "pubsub", label: "Uses Google Pub/Sub messaging", category: "queue", deps: ["@google-cloud/pubsub"] },
  // Email
  { key: "sendgrid", label: "Sends email through SendGrid", category: "email", deps: ["@sendgrid/mail", "@sendgrid/client"], secrets: /^SENDGRID_/i, hosts: /(^|\.)sendgrid\.com$/ },
  { key: "resend", label: "Sends email through Resend", category: "email", deps: ["resend"], secrets: /^RESEND_/i, hosts: /(^|\.)resend\.com$/ },
  { key: "postmark", label: "Sends email through Postmark", category: "email", deps: ["postmark"], hosts: /(^|\.)postmarkapp\.com$/ },
  { key: "mailgun", label: "Sends email through Mailgun", category: "email", deps: ["mailgun.js", "mailgun-js"], secrets: /^MAILGUN_/i },
  { key: "smtp", label: "Sends email over SMTP", category: "email", deps: ["nodemailer"] },
  // SMS / voice
  { key: "twilio", label: "Sends texts or calls through Twilio", category: "sms", deps: ["twilio"], secrets: /^TWILIO_/i, hosts: /(^|\.)twilio\.com$/ },
  { key: "vonage", label: "Sends texts through Vonage", category: "sms", deps: ["@vonage/server-sdk"] },
  // External databases (not the platform's own Postgres)
  { key: "mongodb", label: "Stores data in MongoDB", category: "database", deps: ["mongodb", "mongoose"], secrets: /^(MONGO|MONGODB)_/i },
  { key: "dynamodb", label: "Stores data in Amazon DynamoDB", category: "database", deps: ["@aws-sdk/client-dynamodb"] },
  { key: "planetscale", label: "Stores data in PlanetScale", category: "database", deps: ["@planetscale/database"], hosts: /(^|\.)psdb\.cloud$/ },
  { key: "firebase", label: "Stores data in Firebase", category: "database", deps: ["firebase", "firebase-admin"], hosts: /firebaseio\.com$|firestore\.googleapis\.com$/ },
  { key: "upstash", label: "Uses an Upstash Redis database", category: "database", deps: ["@upstash/redis"], secrets: /^UPSTASH_/i, hosts: /(^|\.)upstash\.io$/ },
  { key: "redis", label: "Connects to a Redis server", category: "database", deps: ["ioredis", "redis"] },
  // Search
  { key: "algolia", label: "Searches through Algolia", category: "search", deps: ["algoliasearch"], secrets: /^ALGOLIA_/i },
  { key: "elasticsearch", label: "Searches through Elasticsearch", category: "search", deps: ["@elastic/elasticsearch"] },
  // Analytics / monitoring
  { key: "sentry", label: "Reports errors to Sentry", category: "monitoring", deps: ["@sentry/node", "@sentry/nextjs", "@sentry/react"], secrets: /^SENTRY_/i, hosts: /(^|\.)sentry\.io$/ },
  { key: "posthog", label: "Sends product analytics to PostHog", category: "analytics", deps: ["posthog-node", "posthog-js"], secrets: /^POSTHOG_/i, hosts: /(^|\.)posthog\.com$/ },
  { key: "mixpanel", label: "Sends product analytics to Mixpanel", category: "analytics", deps: ["mixpanel"] },
  { key: "segment", label: "Sends product analytics to Segment", category: "analytics", deps: ["analytics-node", "@segment/analytics-node"] },
  // Third-party sign-in
  { key: "clerk", label: "Signs users in through Clerk", category: "auth", deps: ["@clerk/nextjs", "@clerk/clerk-sdk-node", "@clerk/backend"], secrets: /^CLERK_/i },
  { key: "auth0", label: "Signs users in through Auth0", category: "auth", deps: ["auth0", "@auth0/nextjs-auth0"], secrets: /^AUTH0_/i },
];

/**
 * Fuse the fingerprint channels into a deduped list of external services. Each service carries the
 * hosts it explains (`hosts`), so callers dedup against the raw host list without re-parsing text.
 */
function detectExternalServices(deps: Dependency[], secretNames: string[], hosts: string[]): ExternalService[] {
  const depSet = new Set(deps.map((d) => d.name));
  const services: ExternalService[] = [];

  for (const fp of FINGERPRINTS) {
    const evidence: string[] = [];
    const svcHosts: string[] = [];

    const hitDep = fp.deps?.find((d) => depSet.has(d));
    if (hitDep) evidence.push(`uses the "${hitDep}" package`);

    let secret: string | undefined;
    if (fp.secrets) {
      secret = secretNames.find((s) => fp.secrets!.test(s));
      if (secret) evidence.push(`needs the ${secret} secret`);
    }

    if (fp.hosts) {
      for (const h of hosts) {
        if (fp.hosts.test(h)) {
          evidence.push(`connects to ${h}`);
          svcHosts.push(h);
        }
      }
    }

    if (evidence.length) {
      services.push({ key: fp.key, label: fp.label, category: fp.category, evidence, hosts: svcHosts, secret });
    }
  }

  return services;
}

/** The set of outbound hosts already explained by a named service, so hosts are never double-counted. */
export function hostsClaimedByServices(services: ExternalService[]): Set<string> {
  const claimed = new Set<string>();
  for (const s of services) for (const h of s.hosts) claimed.add(h);
  return claimed;
}

export function extractFacts(appDir: string, manifest: Manifest): AppFacts {
  const files = collectSource(appDir);
  const texts = new Map<string, string>();
  for (const f of files) {
    try {
      const buf = readFileSync(f);
      if (isProbablyBinary(buf)) continue;
      texts.set(f, buf.toString("utf8"));
    } catch {
      /* skip unreadable */
    }
  }
  const allText = [...texts.values()].join("\n");

  // Dependencies + framework + runtime
  const dependencies = readDependencies(appDir);
  const depNames = new Set(dependencies.map((d) => d.name));
  let framework: string | null = manifest.web?.framework ?? null;
  if (!framework) {
    framework = Object.entries(FRAMEWORK_PACKAGE).find(([, p]) => depNames.has(p))?.[0] ?? null;
  }
  const runtime = manifest.runtime ?? readNodeEngine(appDir);

  // Outbound hosts
  const hosts = new Set<string>();
  for (const m of allText.matchAll(URL_RE)) {
    const host = m[1].toLowerCase();
    if (IGNORE_HOSTS.has(host)) continue;
    if (host.endsWith(".local")) continue;
    hosts.add(host);
  }

  // Capabilities (and the network flag)
  const capabilities: string[] = [];
  for (const { re, label } of CAPABILITIES) if (re.test(allText)) capabilities.push(label);
  const makesNetworkCalls = capabilities.includes("makes outbound network requests") || hosts.size > 0;

  // Personal data — scan the schema (.sql migrations) and, as a backstop, any text file.
  const schemaText = [...texts.entries()]
    .filter(([f]) => f.endsWith(".sql"))
    .map(([, t]) => t)
    .join("\n") || allText;
  const personalData: string[] = [];
  for (const { re, label } of PERSONAL_DATA) {
    if (re.test(schemaText) && !personalData.includes(label)) personalData.push(label);
  }

  // Named external systems, fused from the dependency, secret-name, and host signals. The secret
  // names come from BOTH the manifest AND `process.env.X` references in the source, so a SaaS wired
  // up through an env var the app reads directly (but never declared in app.deploy.yaml, e.g. set
  // in the Vercel dashboard) still surfaces for review instead of slipping through.
  const codeEnvNames = new Set<string>();
  for (const m of allText.matchAll(/process\.env\.([A-Z0-9_]+)|process\.env\[\s*['"]([A-Z0-9_]+)['"]\s*\]/g)) {
    const name = m[1] ?? m[2];
    if (name) codeEnvNames.add(name);
  }
  const secretNames = [
    ...new Set([...(manifest.env?.required ?? []), ...(manifest.env?.optional ?? []), ...codeEnvNames]),
  ];
  const externalServices = detectExternalServices(dependencies, secretNames, [...hosts]);

  return {
    name: manifest.name,
    blueprint: manifest.blueprint,
    framework,
    runtime,
    dependencies,
    outboundHosts: [...hosts].sort(),
    externalServices: externalServices.sort((a, b) => a.label.localeCompare(b.label)),
    makesNetworkCalls,
    data: {
      hasDatabase: !!manifest.database,
      storageBuckets: manifest.storage?.buckets ?? [],
      authTier: manifest.auth?.tier ?? "none",
      personalData,
    },
    secrets: {
      required: manifest.env?.required ?? [],
      optional: manifest.env?.optional ?? [],
    },
    capabilities,
  };
}

function readDependencies(appDir: string): Dependency[] {
  const pkgPath = join(appDir, "package.json");
  if (!existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const out: Dependency[] = [];
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
      out.push({ name, version: String(version), dev: false });
    }
    for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
      out.push({ name, version: String(version), dev: true });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function readNodeEngine(appDir: string): string | null {
  const pkgPath = join(appDir, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return pkg.engines?.node ? `node ${pkg.engines.node}` : null;
  } catch {
    return null;
  }
}

function collectSource(appDir: string): string[] {
  const out: string[] = [];
  walk(appDir, out);
  return out;
}
function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (st.size > MAX_SCAN_BYTES) continue;
    out.push(full);
  }
}

function isProbablyBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  if (n === 0) return false;
  let control = 0;
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 0) return true;
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) control++;
  }
  return control / n > 0.3;
}
