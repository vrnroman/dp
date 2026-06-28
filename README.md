# Deployment Platform

A deployment platform for people who are not engineers.

Plenty of people can now build software with Claude. What stops them is everything around
the building: which technologies to pick, how to wire up a database, how to handle sign-in,
and how to actually put the thing on the internet. This platform makes those decisions for
them and ships whatever they built in one command.

## The idea

Two halves that meet at a contract:

1. **A build constitution** (`constitution/CLAUDE.md`) tells Claude how to build, so the
   output always fits one of a few known shapes and never invents a stack the platform
   cannot ship.
2. **A deploy engine** (`deployctl`) recognizes those shapes and puts the app live, with a
   database, a front door, storage, and a real URL, asking the person zero technical
   questions.

The bridge is `app.deploy.yaml`, a short file Claude writes and the platform reads.

## Blueprints and profiles

- **Blueprints** are the shape of an app: `static`, `web`, or `worker`.
- **Profiles** are where it runs: `personal` (Vercel + Supabase) or `org` (a locked-down
  company stack).

A deploy is one blueprint on one profile. Two cells are built:
**`web` on `personal`** (Vercel + Supabase, simple email-allowlist sign-in), and
**`web` on `org`** (the owner's own Google Cloud VM, behind Caddy auto-HTTPS). The same
app, unchanged, deploys to either.

## Quick start

```bash
# Is this app ready to deploy? Plain-English answer.
deployctl check ./my-app

# See what a deploy would do, without doing it.
deployctl up ./my-app --dry-run

# Put it live: database, front door, storage, and a URL, all set up for you.
deployctl up ./my-app

# Take it all down and remove everything it created.
deployctl down ./my-app --yes
```

In this repo, run it with `npx tsx packages/cli/src/index.ts <command>`.

When a deploy finishes, you get a plain-English receipt, a QR code to put the app on your
phone, and a saved `<name>-card.html` you can open or text to a friend.

## What is inside

- `packages/manifest` — the `app.deploy.yaml` contract and its validator.
- `packages/conformance` — the gate that decides if an app is shippable. It checks the
  manifest, refuses to deploy if a secret is hardcoded, makes sure database migrations
  exist, and more. Every problem comes with a plain-English fix. It never edits your code.
- `packages/auth` (`@platform/auth`) — the identity surface every app codes against. The
  app asks "who is signed in?" and "are they allowed?" and never learns whether the answer
  came from a cookie, Supabase, or, later, a company login.
- `packages/cli` (`deployctl`) — the one command. On `personal` it provisions Supabase and
  Vercel; on `org` it ships the app onto the owner's own VM as a systemd service behind Caddy
  (`providers/gcp-vm.ts`). Either way it narrates each step in human terms.
- `apps/portal` — the browser "webapp wrap": paste a GitHub repo, name it, press one button,
  and watch it go live on your own cloud with the same plain-English narration. Runs on the
  VM behind a login; shows a grid of your deployed apps.
- `apps/reference-web` — the golden example app (a guestbook) that exercises every part:
  saved data, the sign-in gate, an owner-managed allowlist, photo storage, and a secret.
- `constitution/` — the build rules, plus a Claude Code hook that runs the same
  conformance check while you build so problems surface immediately.
- `fixtures/` — deliberately broken apps that prove the checker catches real problems.

## How the safety net works

The same conformance check runs in two places. As a Claude Code hook it gives fast feedback
while the app is being built. Inside `deployctl up` it runs again as the real gate, because
a hook can be skipped. Either way, an app that leaks a secret or is missing a piece does not
get deployed, and the person is told exactly why in words they understand.

## Status

Both the personal and org cells work end to end. The personal data layer is verified against
a real Postgres, and the reference app has been exercised live (sign-in gate, owner-only
allowlist, saved data). The org cell deploys DB-less web apps onto the owner's own GCP VM —
proven live over HTTPS via both the CLI and the browser portal, idempotent and reversible,
without disturbing the app already running on that machine. Next for the org profile: secrets
delivery, a database (Cloud SQL), and company sign-in.
