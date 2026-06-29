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

## Next (deferred, rough priority)

1. **Real sign-in for the portal** — today it sits behind one shared password. With users'
   own keys in flight, move to Google sign-in (oauth2-proxy) before opening it beyond the
   owner, and give each person their own space.
2. **Compliance gate for the org cell (the AI-evaluator half).** The deterministic
   deployability gate above answers "*can* this ship?" The org cell also needs "*may* this
   ship?" Org is not only about technical capability, it is about **regulations**: an app
   deployed into an organization must strictly follow the rules, so this becomes a
   **compliance gate**, not just a build check, and an app that does not conform does not ship.
   This is the **AI evaluator** that judges a submission against the template, security
   expectations, and org policy before it is allowed to deploy — built on top of the
   deployability gate, which it now has to stand on. Personal is forgiving; org will not be.
   (A hard requirement for the org cell, not a nice-to-have.)
3. **A database for the org/VM profile** — Cloud SQL or Postgres on the VM, then re-run the
   Recipe Box "one app, two homes" test.
4. **Static-site support** — a Caddy `file_server` path (org) for no-server apps.
5. **The Caretaker (moonshot)** — a standing daemon that keeps deployed apps alive: health
   checks, auto-restart, redeploy-on-crash, and a plain-English incident log.
