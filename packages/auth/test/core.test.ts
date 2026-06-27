import { test } from "node:test";
import assert from "node:assert/strict";
import {
  signSession,
  verifySession,
  authorize,
  MemoryAllowlist,
  normalizeEmail,
  isValidEmail,
  type User,
} from "../src/index.ts";

const SECRET = "test-secret-please-rotate";
const owner: User = { email: "mom@example.com", role: "owner" };

test("a signed session round-trips back to the same user", () => {
  const token = signSession(owner, SECRET, 3600, 1000);
  const got = verifySession(token, SECRET, 1500);
  assert.deepEqual(got, owner);
});

test("a tampered token is rejected", () => {
  const token = signSession(owner, SECRET, 3600, 1000);
  const tampered = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
  assert.equal(verifySession(tampered, SECRET, 1500), null);
});

test("a token signed with a different secret is rejected", () => {
  const token = signSession(owner, SECRET, 3600, 1000);
  assert.equal(verifySession(token, "other-secret", 1500), null);
});

test("an expired token is rejected", () => {
  const token = signSession(owner, SECRET, 3600, 1000);
  assert.equal(verifySession(token, SECRET, 1000 + 3601), null);
});

test("missing or malformed tokens are rejected, never throw", () => {
  assert.equal(verifySession(undefined, SECRET), null);
  assert.equal(verifySession("", SECRET), null);
  assert.equal(verifySession("not-a-token", SECRET), null);
  assert.equal(verifySession("a.b.c", SECRET), null);
});

test("authorize lets in an allowlisted email with its role", async () => {
  const door = new MemoryAllowlist([
    { email: "mom@example.com", role: "owner" },
    { email: "Friend@Example.com", role: "member" },
  ]);
  assert.deepEqual(await authorize("mom@example.com", door), owner);
  // case-insensitive
  assert.deepEqual(await authorize("FRIEND@example.com", door), {
    email: "friend@example.com",
    role: "member",
  });
});

test("authorize turns away an email that is not on the list", async () => {
  const door = new MemoryAllowlist([{ email: "mom@example.com", role: "owner" }]);
  assert.equal(await authorize("stranger@example.com", door), null);
});

test("authorize rejects a malformed email", async () => {
  const door = new MemoryAllowlist([{ email: "mom@example.com", role: "owner" }]);
  assert.equal(await authorize("not-an-email", door), null);
});

test("allowlist add/remove behaves", async () => {
  const door = new MemoryAllowlist();
  await door.add("new@example.com");
  assert.deepEqual(await door.find("new@example.com"), {
    email: "new@example.com",
    role: "member",
  });
  await door.remove("new@example.com");
  assert.equal(await door.find("new@example.com"), null);
});

test("email helpers", () => {
  assert.equal(normalizeEmail("  Mom@Example.COM "), "mom@example.com");
  assert.ok(isValidEmail("a@b.co"));
  assert.ok(!isValidEmail("nope"));
});
