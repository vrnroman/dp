// Generate (once) and load the auth relay's RSA signing key, and write out the public JWK + kid.
// Rotating this key would invalidate every deployed app's held public key, so it is generated on
// the first run and PRESERVED forever after. Run on the VM by portal-bootstrap.sh.
//
//   node relay-keygen.js <privKeyPath> <pubJwkPath> <kidPath>   -> prints the kid on stdout
const { generateKeyPairSync, createPublicKey, randomBytes } = require("node:crypto");
const { existsSync, readFileSync, writeFileSync, chmodSync } = require("node:fs");

const [, , privPath, pubPath, kidPath] = process.argv;
if (!privPath || !pubPath || !kidPath) {
  process.stderr.write("usage: relay-keygen.js <privKeyPath> <pubJwkPath> <kidPath>\n");
  process.exit(2);
}

let privPem;
let kid;
if (existsSync(privPath) && existsSync(kidPath)) {
  // Reuse the existing key: never rotate silently.
  privPem = readFileSync(privPath, "utf8");
  kid = readFileSync(kidPath, "utf8").trim();
} else {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  writeFileSync(privPath, privPem, { mode: 0o600 });
  chmodSync(privPath, 0o600);
  kid = "relay-" + randomBytes(6).toString("hex");
  writeFileSync(kidPath, kid);
}

const pubJwk = { ...createPublicKey(privPem).export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
writeFileSync(pubPath, JSON.stringify(pubJwk));
process.stdout.write(kid);
