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

## Next (deferred, rough priority)

1. **Real sign-in for the portal** — today it sits behind one shared password. With users'
   own keys in flight, move to Google sign-in (oauth2-proxy) before opening it beyond the
   owner, and give each person their own space.
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
