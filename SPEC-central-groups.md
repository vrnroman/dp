# Spec: central identity & groups in DP (relay carries roles)

**Status:** proposed, not built. Owner-requested 2026-07-05. Reverses the current per-app groups
design, so run the concrete plan past the `manager` (1shot) before building.

## One-line goal

Move group/people/role management out of every deployed app and into **DP itself** (on the VM). A
deployed app then **builds nothing** for identity, **needs no database of its own**, and DP **needs
no Supabase** (it persists to local VM storage). An app only: declares its roles in the manifest,
ships three one-line auth route files, and calls `getUser()` / `requireRole("x")`.

## The core idea (and the one hard problem, solved)

The auth **relay** already exists and is live on the VM: it does the Google sign-in and mints a
short-lived RS256 identity **assertion** that each app verifies with the relay's public key. The
pivot is one sentence:

> At sign-in, the relay resolves the person's roles for **that specific app** (from groups managed
> centrally in DP) and **embeds `roles: [...]` in the signed assertion**. The app reads roles from
> the assertion it already verifies.

That answers "how does each app know about groups created in DP?": **it doesn't need to.** The app
stores no groups, queries nothing at runtime, and depends on DP only at sign-in (not per request).
Roles ride inside the tamper-proof, app-bound token the app already trusts.

## Why it's worth it

- **Build once.** The groups UI + storage live only in DP. Apps shrink to "declare roles + call `requireRole`".
- **One place** to manage people across all apps; **groups become reusable across apps** (define "Family" once).
- **Auth-only apps need no database.** Today a `proper`-tier app must provision Supabase just for the
  groups/allowlist tables. With roles coming from the relay, a protected app with no data of its own
  provisions **no Supabase at all** — faster, cheaper, and it dodges the Supabase 2-project cap.

## Known trade-offs (decide these during the build)

1. **Staleness vs. live revocation.** Today roles resolve live from the DB every request, so a group
   change is instant. Roles baked into a sign-in assertion are fixed until next login. Options:
   (a) accept "applies on next login" for v1; (b) short session TTL + silent re-resolve every N
   minutes; (c) per-request re-check (rejected: makes DP a hard runtime dependency for every page
   load, not just sign-in). **Recommendation: v1 = roles at sign-in + a modest session TTL; document
   the staleness; add silent re-resolve later.**
2. **Blast radius.** Centralizing the membership graph onto the VM concentrates it. Mitigant: the
   relay is already the trust crown-jewel (it can mint any identity), so the marginal risk is a
   stateful store to protect, not a new trust root.
3. **Reverses the "your app on your own accounts" spine.** Group data lives on the DP VM, not each
   app's Supabase. Fine for a **single owner** (all their own data). Only awkward if DP becomes
   multi-tenant (other people deploying through one portal) — defer multi-tenant scoping.

## What exists today (starting point for a cold session)

- **Relay (live on the VM):** `apps/portal/auth-gate.js` — `handleRelay` serves `/auth/relay/start`,
  `/auth/relay/register`, `/auth/relay/deregister`, `/auth/relay/pubkey`, and the relay branch of the
  shared `/auth/google/callback` (exchanges the Google code, verifies the id_token, **mints the
  assertion** — this is where roles get added). Relay keypair generated once by
  `apps/portal/relay-keygen.js`; config + admin token provisioned by `scripts/portal-bootstrap.sh`
  into `/etc/dp-portal.env`; the app-origin allowlist is a flat file at `/var/lib/dp-relay/allow.txt`.
- **Assertion verify (pure):** `packages/auth/src/oauth.ts` — `verifyRs256Jwt` (the one hardened
  verifier), `verifyRelayAssertion` (returns the identity today; **extend to also return `roles`**).
- **App binding:** `packages/auth/src/next.ts` — `relayStart` (redirect to relay), `googleComplete`
  (verify assertion, set session), `getUser` / `requireRole` / `rolesForUser`, `establishSession`.
- **Per-app groups (to be retired in relay mode):** `packages/auth/src/roles.ts` (pure
  `resolveRoles` / `decideAccess` — **reuse this server-side in DP**), `packages/auth/src/pg-groups.ts`
  (Postgres store — drop for relay mode), the app `/settings` "Buckets" screen (drop).
- **Deploy engine:** `packages/cli/src/commands/up.ts` — `relaySetup` registers the app origin +
  fetches the relay pubkey; `usesSupabase`/`needsDb` currently force Supabase for `proper` tier
  (**change: only when the app itself declares `database`/`storage`**); post-deploy real-origin
  registration already added.
- Live demo of the current per-app model: `github.com/vrnroman/dp-demo` → `https://dp-demo-five.vercel.app`.
- Background: `mem` handoff + memory `auth-google-oauth`, `dp-git-commit-authorized`.

## DP-side design

### Storage (on the VM, NO Supabase)

Keep the portal zero-dependency. Node 20 on the VM rules out `node:sqlite` (needs 22.5+) and native
`better-sqlite3` is a heavy break from the zero-dep ethos. **Recommendation: a single JSON store**
loaded into memory and written atomically (write-temp + rename), e.g.
`/var/lib/dp-relay/store.json`, behind a small store interface so it can be swapped for SQLite
later. Volumes (one owner, tens–hundreds of groups/people/apps) make JSON entirely adequate. Provision
the file + perms in `portal-bootstrap.sh` next to the existing allowlist, owned by the app user.

### Data model

- **apps**: `origin` → `{ declaredRoles: [{name, can}], defaultRole, registeredAt }`
  (registered at deploy — see below).
- **people**: `email` → `{ name, picture, sub, firstSeen, lastSeen }` (recorded on sign-in).
- **groups**: `{ id, name }` (global, reusable across apps).
- **memberships**: set of `(groupId, email)`.
- **appRoleMappings**: set of `(appOrigin, groupId, role)` — which roles a group grants **in a given app**.

### Role resolution (reuse `resolveRoles` from roles.ts, server-side)

For `(email, appOrigin)` at sign-in:
`roles = defaultRole(app) ∪ { role : (app, g, role) for each group g the email is in }`, then
**intersect with the app's declared roles** (fail-closed: never grant a role the app didn't declare;
unknown group/mapping grants nothing). The app owner (the deploying Google account) still implicitly
gets all declared roles — carry that rule over.

### Register roles at deploy

Extend `/auth/relay/register` (and `up.ts`'s `relaySetup`) so the deploy also sends the app's
`declaredRoles` + `defaultRole` (from the manifest). DP stores them in the apps registry, so the
management UI knows what roles each app offers.

### The assertion change

In the relay callback (`auth-gate.js`), after verifying the Google id_token, resolve roles for
`(email, app)` from the store and add `roles: string[]` to the assertion claims (alongside
`iss/aud/sub/email/email_verified/name/nonce/iat/exp/jti`). In `verifyRelayAssertion` (oauth.ts),
extract and return `roles`. In `googleComplete` (next.ts), put `roles` into the signed session
cookie. `requireRole` / `rolesForUser` read from the session (relay mode) instead of the per-app DB.

### DP owner management UI (the portal-owner groups screen)

A page in the portal (e.g. `/groups`), **behind the portal's own owner sign-in** (the portal is
already Google-gated). It lets the portal owner:
- create / rename / delete groups;
- add / remove people (by email) to groups;
- per registered app: see its declared roles and map groups → roles for that app;
- see the app registry and the "just arrived" people list.

## App-side simplification (what apps drop)

- No groups tables, no `/settings` page, no `pg-groups`. A `proper`-tier app with no data of its own
  declares **no `database` block** → **no Supabase provisioned**.
- The whole app-side auth contract becomes: manifest `auth.roles` + `default` + `signup`; three
  one-line route files (`/auth/google`, `/auth/google/callback`, `/auth/complete`); `getUser()` /
  `requireRole()`. Update `constitution/CLAUDE.md` and the conformance route check accordingly (the
  three routes stay required; drop any "who's in" guidance).
- `up.ts`: for `proper` tier in relay mode, do **not** set `usesSupabase`/`needsDb` unless the app
  declares `database`/`storage`; stop provisioning groups tables.

## Security guards (carry into the build)

- Fail-closed resolution (undeclared/stale role → nothing; unknown group → nothing).
- Assertion still verified fully app-side (RS256 sig, iss/aud/exp/nonce, `email_verified`) — `roles`
  is only as trusted as the relay, which is already the trust root.
- Management endpoints stay behind the relay **admin token** (server-to-server) and the **portal
  owner login** (the human UI). Never expose group mutation unauthenticated.
- Store writes atomic; back up the JSON on write (keep last-N) so a bad write can't wipe the org graph.

## Acceptance criteria (how to verify — all machine-exercisable with mock Google + local store)

1. Deploy a `proper`-tier app with **no `database` block** → **no Supabase project created**, app is
   protected, sign-in works through the relay, roles arrive in the assertion.
2. Owner creates a group in DP, adds an email, maps that group → `editor` for the app → that user
   signs in and `requireRole("editor")` passes; a user not in the group gets only the default role.
3. Fail-closed: mapping a group to a role the app never declared grants nothing.
4. The app ships **zero** groups code and **no** `/settings`; the reference app and `dp-demo` still
   work after the switch.
5. Unit + integration tests: relay role-resolution, assertion-carries-roles, app reads roles from the
   session, fail-closed, and the DP store (create/map/resolve) — mirroring the existing relay tests
   in `apps/portal/test/relay.test.ts` and `packages/auth/test/*`.

## Open decisions for the builder

- Storage backend: JSON file (recommended, zero-dep) vs. SQLite later.
- Staleness policy: login-only (v1) vs. short-TTL silent re-resolve vs. live.
- Keep per-app groups (`roles.ts` + `pg-groups.ts`) as a fallback for direct-Google mode, or remove.
- Multi-tenant scoping of the store (defer; single-owner for now).

## File-by-file change list (concrete)

- `apps/portal/auth-gate.js`: role-resolving in the relay callback + embed in assertion; extend
  `/auth/relay/register` to accept `declaredRoles`/`defaultRole`; new admin endpoints + owner UI
  routes for group management; replace the flat allowlist file with the JSON store (apps + people +
  groups + memberships + mappings). Consider splitting the store + admin UI into their own zero-dep
  modules under `apps/portal/`.
- `packages/auth/src/oauth.ts`: `verifyRelayAssertion` returns `roles`.
- `packages/auth/src/next.ts`: `googleComplete` stores `roles` in the session; `requireRole`/
  `rolesForUser` read session roles in relay mode; stop touching `pg-groups` in relay mode.
- `packages/cli/src/commands/up.ts`: send `declaredRoles`/`defaultRole` at register; gate Supabase on
  the app actually declaring `database`/`storage`; stop provisioning groups tables in relay mode.
- `apps/reference-web`, `github.com/vrnroman/dp-demo`: drop `/settings` + groups usage; keep manifest
  roles + the 3 routes.
- `constitution/CLAUDE.md` + `packages/conformance/src/index.ts`: update the builder contract.
- `scripts/portal-bootstrap.sh`: provision the JSON store file + perms.

## Also worth fixing while in here (found during the dp-demo deploy)

The compliance gate flags the injected relay host (`PLATFORM_AUTH_RELAY_URL`) as an "unapproved
external system" — a false positive; the relay is platform infra like Supabase/Vercel. Exclude the
relay host in `packages/compliance/src/extract.ts` so relay-mode deploys don't need
`DP_COMPLIANCE_APPROVED=1`.
