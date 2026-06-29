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

export interface AppFacts {
  name: string;
  blueprint: string;
  framework: string | null;
  runtime: string | null;
  dependencies: Dependency[];
  /** Distinct external hosts the code references (real third-party/own-infra connections). */
  outboundHosts: string[];
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

  return {
    name: manifest.name,
    blueprint: manifest.blueprint,
    framework,
    runtime,
    dependencies,
    outboundHosts: [...hosts].sort(),
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
