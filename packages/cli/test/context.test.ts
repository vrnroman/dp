import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDeployContext } from "../src/util/context.ts";

function app(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ctx-app-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}
function pkgOf(ctxDir: string) {
  return JSON.parse(readFileSync(join(ctxDir, "package.json"), "utf8"));
}

test("a TypeScript Next.js app that omits the toolchain gets it provided on the deploy copy", () => {
  const dir = app({
    "package.json": JSON.stringify({ name: "t", dependencies: { next: "15.1.0", react: "18.3.1", "react-dom": "18.3.1" } }),
    "tsconfig.json": "{}",
    "app/page.tsx": "export default function P(){return null}",
  });
  const { dir: ctx } = prepareDeployContext(dir);
  const dev = pkgOf(ctx).devDependencies ?? {};
  assert.ok(dev.typescript, "typescript should be provided");
  assert.equal(dev["@types/react"], "^18", "@types/react major should match the app's React");
  assert.equal(dev["@types/react-dom"], "^18");
  assert.ok(dev["@types/node"], "@types/node should be provided");
});

test("@types/react tracks the app's React 19", () => {
  const dir = app({
    "package.json": JSON.stringify({ name: "t", dependencies: { next: "15.1.0", react: "^19.0.0", "react-dom": "^19.0.0" } }),
    "tsconfig.json": "{}",
    "app/page.tsx": "export default function P(){return null}",
  });
  const dev = pkgOf(prepareDeployContext(dir).dir).devDependencies ?? {};
  assert.equal(dev["@types/react"], "^19");
});

test("detects TypeScript from .tsx source even without a tsconfig.json", () => {
  const dir = app({
    "package.json": JSON.stringify({ name: "t", dependencies: { next: "15.1.0", react: "18.3.1", "react-dom": "18.3.1" } }),
    "app/page.tsx": "export default function P(){return null}",
  });
  assert.ok((pkgOf(prepareDeployContext(dir).dir).devDependencies ?? {}).typescript);
});

test("a plain JavaScript app gets NO toolchain added", () => {
  const dir = app({
    "package.json": JSON.stringify({ name: "t", dependencies: { next: "15.1.0", react: "18.3.1", "react-dom": "18.3.1" } }),
    "app/page.js": "export default function P(){return null}",
  });
  const dev = pkgOf(prepareDeployContext(dir).dir).devDependencies ?? {};
  assert.ok(!dev.typescript, "a JS app should not get typescript");
});

test("a TS app that vendors @platform/* gets @types/pg and .ts-extension imports enabled", () => {
  const dir = app({
    "package.json": JSON.stringify({
      name: "t",
      dependencies: { next: "15.5.0", react: "18.3.1", "react-dom": "18.3.1", pg: "^8", "@platform/auth": "*" },
    }),
    "tsconfig.json": JSON.stringify({ compilerOptions: { moduleResolution: "bundler", jsx: "preserve" } }),
    "app/page.tsx": "export default function P(){return null}",
  });
  const ctx = prepareDeployContext(dir).dir;
  const pkg = pkgOf(ctx);
  assert.equal(pkg.devDependencies["@types/pg"], "^8", "the pg types must be provided for the vendored auth binding");
  const tsconfig = JSON.parse(readFileSync(join(ctx, "tsconfig.json"), "utf8"));
  assert.equal(tsconfig.compilerOptions.allowImportingTsExtensions, true, "the vendored @platform/* .ts imports must be allowed");
  assert.equal(tsconfig.compilerOptions.noEmit, true);
});

test("an app that already declares the toolchain is not overridden", () => {
  const dir = app({
    "package.json": JSON.stringify({
      name: "t",
      dependencies: { next: "15.1.0", react: "18.3.1", "react-dom": "18.3.1" },
      devDependencies: { typescript: "5.4.0", "@types/react": "18.2.0" },
    }),
    "tsconfig.json": "{}",
    "app/page.tsx": "export default function P(){return null}",
  });
  const dev = pkgOf(prepareDeployContext(dir).dir).devDependencies ?? {};
  assert.equal(dev.typescript, "5.4.0", "the app's own typescript pin must be preserved");
  assert.equal(dev["@types/react"], "18.2.0");
});
