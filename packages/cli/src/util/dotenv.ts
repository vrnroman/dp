/**
 * Minimal, zero-dependency .env loader. Reads a `.env` file (repo root, then cwd) and sets any
 * keys not already present in process.env. Used so the compliance evaluator picks up its
 * LANGFUSE_* keys without the user exporting them by hand. Never throws.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

export function loadDotenv(extraPaths: string[] = []): void {
  const candidates = [join(repoRoot(), ".env"), join(process.cwd(), ".env"), ...extraPaths];
  const seen = new Set<string>();
  for (const path of candidates) {
    if (seen.has(path) || !existsSync(path)) continue;
    seen.add(path);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  }
}
