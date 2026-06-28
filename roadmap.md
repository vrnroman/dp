# Deployment platform — roadmap

The original idea: a deployment portal people open in a browser, where they drop an app or
paste a GitHub repo, give a few plain answers, and get a live link — no technical questions.

## Done

- **Personal cell** — `web × personal × simple-auth` on Vercel + Supabase. Proven live.
- **Org cell (v1)** — `web × org` on the owner's own **GCP VM** (`claude-agent` in `roman-vm`).
  `deployctl up --profile org` (set `profile: org` in `app.deploy.yaml`) ships a DB-less web
  app as a hardened systemd service behind Caddy auto-HTTPS at
  `<slug>.34-11-212-4.sslip.io`. Idempotent `up`, clean `down`, and it protects the
  pre-existing Membro app (backup, validate-before-reload, rollback on an unhealthy front door).
- **The deployment portal (the "webapp wrap")** — a browser page running on the VM at
  `https://portal.34-11-212-4.sslip.io` (behind a login). Paste a GitHub repo, name it, press
  one button, and watch the platform's plain-English narration stream while it goes live on
  your own cloud. Shows a home grid of your deployed apps. Proven end to end by deploying
  `github.com/vrnroman/dp-portal-demo` through it.

## Next (deferred, rough priority)

1. **Secrets into the org profile** — deliver env keys to the VM (systemd `EnvironmentFile`),
   then add the env-vars field to the portal (the original "specify keys" idea). Today the
   profile *refuses* apps that need secrets rather than deploy them without.
2. **A database for the org profile** — Cloud SQL or Postgres on the VM, then re-run the
   Recipe Box "one app, two homes" portability test.
3. **Static-site support** — a Caddy `file_server` path for no-server apps.
4. **Upgrade the portal gate** — from `basic_auth` to Google sign-in (oauth2-proxy) before
   opening the portal beyond the owner.
5. **The Caretaker (moonshot)** — a standing daemon that keeps deployed apps alive: health
   checks, auto-restart, redeploy-on-crash, and a plain-English incident log.
