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
- **Compliance evaluator (`deployctl review`) — POC on the personal stack.** Answers "*may* this
  ship?" The deterministic half extracts the facts an org approver must trust — technologies and
  dependencies, the external systems it connects to (real hosts read from the code, never guessed),
  the data it holds (incl. personal-data detection), the secrets it needs — and an org-policy seed
  turns those into a verdict (allowed / needs-review / blocked). The AI half writes a short
  plain-English **approval brief** ("what it does", what to check) for a human to sign off on. The
  brief runs on Claude via the Claude Code CLI (`claude -p`, on the owner's subscription, NOT an
  API key) and every call is traced to deployment-platform's own Langfuse project. Built against
  personal so it can be exercised today; the same shape drops onto the org cell once its stack
  exists. `packages/compliance`.
  **⚠️ NOT ACTIVATED.** It exists only as the standalone `deployctl review` command — it is NOT
  wired into `deployctl up` or the portal, so right now NOTHING is actually gated by it. A deploy
  proceeds whether or not the evaluator would have blocked it. Activating it (fail-closed in the
  deploy path + the brief in the portal) is the top of Next — do not ship the org cell without it.

## Next (deferred, rough priority)

1. **Real sign-in for the portal** — today it sits behind one shared password. With users'
   own keys in flight, move to Google sign-in (oauth2-proxy) before opening it beyond the
   owner, and give each person their own space.
2. **ACTIVATE the compliance evaluator, then harden it into the real org gate.** The POC
   (`deployctl review`, in Done) proves the shape but **gates nothing** — see the ⚠️ note above.
   First make it actually do something: (a) **wire it into `deployctl up` as a fail-closed gate**
   that refuses a "blocked" verdict and routes "needs-review" to a human approver (start on
   personal so it is exercised immediately, not only on the not-yet-built org cell), and (b)
   **surface the approval brief in the browser portal** so a non-engineer approver signs off there.
   Then harden for org: (c) a real, org-authored policy instead of the seed default (stricter
   outbound allowlist, a banned-dependency list, framework limits, data-handling rules). Personal
   is forgiving; org will not be.
3. **A database for the org/VM profile** — Cloud SQL or Postgres on the VM, then re-run the
   Recipe Box "one app, two homes" test.
4. **Static-site support** — a Caddy `file_server` path (org) for no-server apps.
5. **The Caretaker (moonshot)** — a standing daemon that keeps deployed apps alive: health
   checks, auto-restart, redeploy-on-crash, and a plain-English incident log.
