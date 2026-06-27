/**
 * @platform/auth — public entry point.
 *
 * The pure, framework-free core lives here (safe to import anywhere, including tests).
 * The Next.js binding lives at "@platform/auth/next" so that importing this module
 * never drags in next/headers or the pg driver.
 */
export * from "./core.ts";
export { ALLOWLIST_TABLE, ALLOWLIST_SCHEMA, PgAllowlist } from "./pg-store.ts";
