# Deployment platform — roadmap

The idea: a deployment portal people open in a browser, where they drop an app or paste a
GitHub repo, give a few plain answers and their own keys, and get a live link — no technical
questions.

## Done

- **Personal cell** — `web × personal` on Vercel + Supabase. Proven live.
- **The deployment portal (the "webapp wrap")** — a browser page that RUNS on the owner's own
  GCP VM (`https://portal.34-11-212-4.sslip.io`, behind a login) but ships each person's app
  into **their own** Vercel + Supabase. Paste a GitHub repo, name it, paste your own keys (or
  commit a `.env.deploy` in the repo), press one button, and watch the plain-English narration
  stream until it is live. It is fail-closed: a deploy with no key is refused and can never
  fall back to the owner's accounts, and an untrusted repo can never route itself onto the VM
  (the profile is forced to personal in every YAML spelling). Proven end to end by deploying
  `github.com/vrnroman/dp-portal-web` to Vercel through the portal.
- **Org cell (v1, CLI)** — `deployctl up --profile org` deploys a DB-less web app onto the
  owner's own VM as a systemd service behind Caddy auto-HTTPS. Idempotent, reversible, and it
  protects the app already on the box. This is a CLI capability; the portal uses personal.
- Personal deploys now **skip Supabase** entirely for a no-database, no-sign-in app (Vercel
  only), so they never burn a Supabase project an app would not use.
- **Deployability gate (the deterministic half).** A real pre-deploy gate, in two layers.
  Statically (instant, runs in the build-time hook too) it confirms the app matches a shape the
  platform can ship — e.g. an app that declares `framework: nextjs` but never installed `next`
  is refused with a plain-English fix instead of dying as a cryptic host build later. Then, on
  deploy, it **actually builds the app** in a throwaway copy the same way the host would, before
  a single cloud resource is created: a build break is a plain-English refusal up front, with
  the failing part of the build output handed back, instead of being discovered as a Vercel
  build failure after we have already provisioned (and, on personal, made the user's Supabase
  project). Exposed as `deployctl preflight` / `deployctl check --build`, and run inside
  `deployctl up` before provisioning (skippable with `--skip-build-check`).
- **Compliance evaluator — ACTIVATED as a real fail-closed gate.** Answers "*may* this ship?" The
  deterministic half extracts the facts an org approver must trust — technologies and dependencies,
  the external systems it connects to, the data it holds (incl. personal-data detection), the
  secrets it needs — and an org-policy seed turns those into a verdict (allowed / needs-review /
  blocked). The AI half writes a short plain-English **approval brief** for a human to sign off on,
  on Claude via `claude -p` (subscription, NOT an API key), traced to deployment-platform's own
  Langfuse project. `packages/compliance`, `deployctl review`.
  **External-dependency detection (the owner's ask).** "What does this app connect to?" is now more
  than a URL scan: a curated fingerprint table fuses THREE deterministic signals — an npm dependency
  name, an env-var/secret name, and an outbound host — into named services, so an S3 bucket, a work
  queue, or a SaaS SDK whose URL lives inside the package (not the app's source) still surfaces. The
  platform's own stack (Supabase/Vercel) and generic Postgres drivers are excluded, so the list stays
  honest. Each detected service flips the verdict to needs-review with the secret it rides on named.
  **Now it actually gates.** (a) Wired into `deployctl up` as a fail-closed gate that runs before the
  build: a `blocked` verdict never deploys; a `needs-review` verdict needs a human OK (an interactive
  y/N on the CLI, or `DP_COMPLIANCE_APPROVED=1` from the portal); anything non-interactive and
  unapproved is refused, never hung; a review that cannot run fails closed. (b) The **browser portal**
  now runs the review after cloning and, when something needs review, PAUSES and shows the concrete
  dependencies (Stripe, S3, a queue, ...) so a non-engineer can **approve or decline** on the spot;
  only on approve does it resume into the deploy. A blocked repo is refused with a plain reason; a
  clean repo flows straight through. Proven end to end: `banned-tech` (puppeteer → blocked),
  `clean-static` (no deps → straight deploy), `calls-external` (Stripe/S3/queue/OpenAI → informed,
  approve-or-decline), driven live over HTTP.
  **Still a seed policy.** The banned list (heavyweight headless browsers) and outbound allowlist are
  example rules; a real org tightens them (see Next).

- **Google sign-in, app-declared roles, and platform-managed groups (built, verified).** Identity
  moved from trust-on-entry email to real **Google OAuth**: a proper authorization-code flow (state
  CSRF, PKCE, nonce) with **real id_token verification** (RS256 signature against Google's JWKS, plus
  issuer / audience / expiry / nonce), fail-closed on every doubt. The division of responsibility the
  owner asked for: an app builder **only declares roles** in `app.deploy.yaml` (`auth.roles: [{name,
  can}]` + `default`, `signup: open|invite`); the **platform** owns the rest, shipped into each app as
  `@platform/auth` with its tables in that app's own Postgres: real people (verified by Google), named
  **groups** the owner sorts them into, and the **group→role mapping**. A person's roles resolve LIVE
  from group membership (moving someone takes effect at once) and fail-closed against the declared set
  (an unmapped or stale role never grants). Open signup by default: anyone with Google gets in with the
  default role. The **checking process** was updated to match: the manifest parser + JSON schema
  validate roles; conformance greps every `requireRole("x")` and refuses to deploy an undeclared role
  (a typo that would open a door for no one), and the secret scanner now catches a hardcoded Google
  client secret while injected-env usage passes. The **builder constitution** (`constitution/CLAUDE.md`)
  documents the whole "you declare, the platform assigns" contract. The **portal itself** gained a
  zero-dependency Google front door (`apps/portal/auth-gate.js`) behind a flag, with basic_auth as the
  fail-safe fallback when unconfigured. Verified: 96 unit tests (incl. downgrade/alg-confusion/tamper/
  wrong-aud/expired/replay attacks all refused), a full mock-OAuth sign-in through the portal gate, the
  groups SQL (schema, joins, cascade, fail-closed resolution) against a real Postgres (PGlite), and a
  clean host-style build of the reference app. **ACTIVATED LIVE (verified 2026-07-05).** A Google
  OAuth client ("Deployment Platform") already exists in the owner's `roman-vm` GCP project with both
  callbacks registered (`https://portal.34-11-212-4.sslip.io/auth/google/callback` + a `localhost:3000`
  dev URL), and the live portal now serves a "Continue with Google" front door instead of basic_auth.
  Proven end to end by signing in as the owner (`vrnroman@gmail.com`) through the real Google OAuth flow
  (PKCE + state + nonce, code→token exchange, id_token verification, allowed-email gate) into the
  authenticated deploy UI. **Operational note:** the client secret lives only on the VM — Google no
  longer lets you re-view an existing secret — so a `deploy-portal.sh` run WITHOUT the Google env set
  would silently drop the portal back to basic_auth. Always pass the Google env when redeploying (and
  if the secret is ever lost, mint a fresh one in the console and redeploy with it).

- **DP-owner central Groups & access screen (built + verified 2026-07-05).** The portal owner now has
  a real UI (`/groups`, behind the portal's own owner Google login) to **create groups, add people by
  email, and map each group to a deployed app's declared roles** — the owner declares nothing in code.
  Groups live centrally in DP on the VM (a zero-dependency JSON store with atomic writes + backup
  rotation, `apps/portal/store.js`), NOT in each app's database. Apps register their declared roles at
  deploy (`up.ts` → `/auth/relay/register`), and at sign-in the **relay resolves the person's roles for
  that specific app and embeds them in the signed assertion** (`apps/portal/auth-gate.js`), so the app
  reads roles from the token it already verifies (`packages/auth/src/{oauth,core,next}.ts`) with no
  groups database of its own. Fail-closed throughout: a role an app never declared grants nothing; a
  tampered `roles` claim breaks the RS256 signature; a tampered session breaks the HMAC. The screen
  speaks plain English (the app's own "can" sentence, never the word "role"), and a live **"Try it as"**
  tester shows exactly what any email can do in any app right now. Proven end to end: 142 tests
  (incl. assertion-carries-roles + fail-closed + tamper), an adversarial verifier pass, and a live
  browser walk-through (create group → add member → map role → see the effect). `apps/portal/groups-admin.js`.
  **Still per-app-scoped for v1** (groups are defined centrally but mapped per app); cross-app group
  reuse and the app-side simplification (dropping the old per-app `/settings` + `pg-groups`, gating
  Supabase on a declared `database`) are the deferred follow-ons below. The old per-app model is
  untouched and still works.

## Next (deferred, rough priority)

1. **Finish the central-groups rollout (the owner screen itself is now BUILT — see Done).** With DP
   resolving roles centrally, complete the app-side simplification the central store makes possible:
   (a) drop each app's per-app `/settings` groups screen + `pg-groups` usage in relay mode, so a
   `proper`-tier app with no data of its own declares **no `database`** and provisions **no Supabase**
   (gate Supabase on the app actually declaring `database`/`storage` in `up.ts`); (b) **cross-app group
   reuse** (define "Family" once, map it in several apps) and, later, multi-tenant scoping of the store;
   (c) update `constitution/CLAUDE.md` + the conformance route check to the slimmer app contract. Also:
   exclude the relay host in `packages/compliance/src/extract.ts` so relay-mode deploys don't trip the
   external-system flag. (Per-app Google sign-in for deployed apps is built but not yet verified live.)
2. **Harden the compliance gate into the real org policy.** Activation is done (see Done): the gate
   is fail-closed in `deployctl up` and the portal shows concrete dependencies for approve/decline.
   What remains is org-strength policy: (c) a real, org-authored policy instead of the seed default
   (stricter outbound allowlist, a fuller banned-dependency list, framework limits, data-handling
   rules), and per-org **approved-services** allowlists (the `approvedServices` hook exists but is
   empty today). (d) A persistent **approve-once** memory so a re-deploy of an already-approved app
   does not re-prompt. Personal is forgiving; org will not be.
3. **A database for the org/VM profile** — Cloud SQL or Postgres on the VM, then re-run the
   Recipe Box "one app, two homes" test.
4. **Static-site support** — a Caddy `file_server` path (org) for no-server apps.
5. **The Caretaker (moonshot)** — a standing daemon that keeps deployed apps alive: health
   checks, auto-restart, redeploy-on-crash, and a plain-English incident log.
