import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign, createHmac } from "node:crypto";
import {
  buildGoogleAuthUrl,
  signValue,
  verifyValue,
  verifyGoogleIdToken,
  safeReturnTo,
  type Jwk,
} from "../src/oauth.ts";

const CLIENT_ID = "1234567890-abc.apps.googleusercontent.com";
const SECRET = "test-secret-please-rotate";

// --- a local stand-in for Google's signing key, so we can exercise real verification ---
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-key-1";
function jwkForPublic(): Jwk {
  const jwk = publicKey.export({ format: "jwk" }) as Jwk;
  return { ...jwk, kid: KID, alg: "RS256", use: "sig" };
}
const JWKS = [jwkForPublic()];

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
function makeToken(claims: Record<string, unknown>, opts: { kid?: string; alg?: string; sign?: boolean } = {}): string {
  const header = { alg: opts.alg ?? "RS256", kid: opts.kid ?? KID, typ: "JWT" };
  const signingInput = `${b64url(header)}.${b64url(claims)}`;
  let sig = "";
  if (opts.sign !== false) {
    sig = cryptoSign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
  }
  return `${signingInput}.${sig}`;
}
function goodClaims(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "108100",
    email: "person@example.com",
    email_verified: true,
    name: "A Person",
    iat: now,
    exp: now + 3600,
    nonce: "the-nonce",
    ...over,
  };
}

test("buildGoogleAuthUrl carries the required params", () => {
  const url = new URL(
    buildGoogleAuthUrl({ clientId: CLIENT_ID, redirectUri: "https://app.example/auth/google/callback", state: "s", nonce: "n", codeChallenge: "cc" }),
  );
  assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(url.searchParams.get("redirect_uri"), "https://app.example/auth/google/callback");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), "s");
  assert.equal(url.searchParams.get("nonce"), "n");
  assert.equal(url.searchParams.get("code_challenge"), "cc");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("scope")?.includes("email"));
});

test("signValue round-trips and rejects tampering", () => {
  const tok = signValue({ state: "abc", n: 1 }, SECRET);
  assert.deepEqual(verifyValue(tok, SECRET), { state: "abc", n: 1 });
  assert.equal(verifyValue(tok.slice(0, -2) + "zz", SECRET), null);
  assert.equal(verifyValue(tok, "other-secret"), null);
  assert.equal(verifyValue(undefined, SECRET), null);
  assert.equal(verifyValue("no-dot", SECRET), null);
});

test("a genuine Google id_token verifies to the identity", () => {
  const r = verifyGoogleIdToken(makeToken(goodClaims()), { clientId: CLIENT_ID, jwks: JWKS, nonce: "the-nonce" });
  assert.ok(r.ok, r.ok ? "" : r.reason);
  if (r.ok) {
    assert.equal(r.identity.email, "person@example.com");
    assert.equal(r.identity.sub, "108100");
    assert.equal(r.identity.emailVerified, true);
    assert.equal(r.identity.name, "A Person");
  }
});

test("a tampered payload is rejected (signature no longer matches)", () => {
  const tok = makeToken(goodClaims());
  const [h, , s] = tok.split(".");
  const forged = `${h}.${b64url(goodClaims({ email: "attacker@evil.example" }))}.${s}`;
  const r = verifyGoogleIdToken(forged, { clientId: CLIENT_ID, jwks: JWKS, nonce: "the-nonce" });
  assert.equal(r.ok, false);
});

test("the alg:none downgrade is refused", () => {
  const tok = makeToken(goodClaims(), { alg: "none", sign: false });
  const r = verifyGoogleIdToken(tok, { clientId: CLIENT_ID, jwks: JWKS, nonce: "the-nonce" });
  assert.equal(r.ok, false);
});

test("an HS256 token signed with a guessed secret is refused (no algorithm confusion)", () => {
  // Attacker tries to sign with HMAC using the public key material as the 'secret'.
  const header = { alg: "HS256", kid: KID, typ: "JWT" };
  const signingInput = `${b64url(header)}.${b64url(goodClaims())}`;
  const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const sig = createHmac("sha256", pubPem).update(signingInput).digest("base64url");
  const r = verifyGoogleIdToken(`${signingInput}.${sig}`, { clientId: CLIENT_ID, jwks: JWKS, nonce: "the-nonce" });
  assert.equal(r.ok, false);
});

test("a token for a different app (aud) is refused", () => {
  const r = verifyGoogleIdToken(makeToken(goodClaims({ aud: "someone-else.apps.googleusercontent.com" })), {
    clientId: CLIENT_ID,
    jwks: JWKS,
    nonce: "the-nonce",
  });
  assert.equal(r.ok, false);
});

test("a token from the wrong issuer is refused", () => {
  const r = verifyGoogleIdToken(makeToken(goodClaims({ iss: "https://evil.example" })), {
    clientId: CLIENT_ID,
    jwks: JWKS,
    nonce: "the-nonce",
  });
  assert.equal(r.ok, false);
});

test("an expired token is refused", () => {
  const now = Math.floor(Date.now() / 1000);
  const r = verifyGoogleIdToken(makeToken(goodClaims({ exp: now - 10000, iat: now - 20000 })), {
    clientId: CLIENT_ID,
    jwks: JWKS,
    nonce: "the-nonce",
  });
  assert.equal(r.ok, false);
});

test("a mismatched nonce is refused (replay defense)", () => {
  const r = verifyGoogleIdToken(makeToken(goodClaims({ nonce: "some-other-nonce" })), {
    clientId: CLIENT_ID,
    jwks: JWKS,
    nonce: "the-nonce",
  });
  assert.equal(r.ok, false);
});

test("an unverified email is refused", () => {
  const r = verifyGoogleIdToken(makeToken(goodClaims({ email_verified: false })), {
    clientId: CLIENT_ID,
    jwks: JWKS,
    nonce: "the-nonce",
  });
  assert.equal(r.ok, false);
});

test("a token signed by an unknown key (kid not in JWKS) is refused", () => {
  const r = verifyGoogleIdToken(makeToken(goodClaims(), { kid: "unknown-kid" }), {
    clientId: CLIENT_ID,
    jwks: JWKS,
    nonce: "the-nonce",
  });
  assert.equal(r.ok, false);
});

test("safeReturnTo keeps same-origin paths and refuses open redirects", () => {
  // Same-origin paths pass through (with query/hash).
  assert.equal(safeReturnTo("/"), "/");
  assert.equal(safeReturnTo("/settings"), "/settings");
  assert.equal(safeReturnTo("/a/b?x=1&y=2"), "/a/b?x=1&y=2");
  assert.equal(safeReturnTo("/path#frag"), "/path#frag");

  // Open-redirect vectors all collapse to "/".
  assert.equal(safeReturnTo("//evil.com"), "/");
  assert.equal(safeReturnTo("https://evil.com"), "/");
  assert.equal(safeReturnTo("/\\evil.com"), "/"); // backslash → treated as slash by URL()
  assert.equal(safeReturnTo("/\\/evil.com"), "/");
  assert.equal(safeReturnTo("/\\\\evil.com"), "/");
  assert.equal(safeReturnTo("/\t//evil.com"), "/"); // tab control char
  assert.equal(safeReturnTo("/\n//evil.com"), "/"); // newline control char
  assert.equal(safeReturnTo("https:evil.com"), "/");
  assert.equal(safeReturnTo(""), "/");
  assert.equal(safeReturnTo(null), "/");
  assert.equal(safeReturnTo("relative/path"), "/");

  // Belt-and-suspenders: whatever passes must actually resolve back to the same origin.
  for (const v of ["/settings", "/a/b?x=1", "/"]) {
    assert.equal(new URL(safeReturnTo(v), "https://app.example").origin, "https://app.example");
  }
  // And the attack vectors, resolved through the exact production sink, never leave the origin.
  for (const v of ["/\\evil.com", "//evil.com", "/\t//evil.com"]) {
    assert.equal(new URL(safeReturnTo(v), "https://app.example").origin, "https://app.example");
  }
});

test("email is normalized to lowercase", () => {
  const r = verifyGoogleIdToken(makeToken(goodClaims({ email: "Person@Example.COM" })), {
    clientId: CLIENT_ID,
    jwks: JWKS,
    nonce: "the-nonce",
  });
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.identity.email, "person@example.com");
});
