# How it works, end to end

This explains the whole thing in the order you actually use it.

## The mental model

There are two halves that meet at a contract:

1. **A starter you build in** (`dp-starter`). It already knows the rules. Anything you build
   in it stays deployable.
2. **A deploy engine** (`deployctl`). It reads what you built and puts it live on a fixed,
   sensible stack, asking you no technical questions.

The contract between them is a small file, `app.deploy.yaml`, plus a standard way the app
talks to the world (it reads `DATABASE_URL` from the environment, and uses one auth import).
Because the app only ever touches that standard surface, the engine can wire it to the real
providers on deploy, and could wire it to a different stack later without changing your code.

## The flow (this is exactly what was done to prove it)

1. **Start from the template.** Create a new app from `dp-starter` (a GitHub template), or
   copy the folder. You now have a working app: it saves data, has a sign-in screen, and lets
   you choose who gets in.

   ```
   # what the demo did
   new folder  ->  copy dp-starter into it  ->  npm install
   ```

2. **Build with Claude.** Open the folder with Claude and describe the app. Claude edits the
   pages, adds tables as `.sql` files, and updates `app.deploy.yaml`. Two things keep it on the
   rails: the constitution (`CLAUDE.md`) tells Claude how to build, and a conformance hook runs
   the deploy check as it works, so mistakes (like a hardcoded secret) surface immediately.

   For the demo, the starter was turned into **Recipe Box**, a little family cookbook: a
   `recipes` table, a family allowlist, and a dish photo per recipe.

3. **Check it.** `deployctl check .` says, in plain English, whether it is ready and how to fix
   anything: a valid deploy file, no leaked secrets, the migrations it claims, and a shape the
   platform can actually build (an app that says it is Next.js but never installed `next` is
   caught here, not at host-build time). It is the same static check the engine runs again
   before deploying, so it cannot be skipped. `deployctl preflight .` goes one step further and
   actually **builds** the app in a throwaway copy, so you know it deploys before you try.

4. **Ship it.** `deployctl up .` makes every technology decision for you. First it builds the
   app in a throwaway copy to be sure it deploys — if the build breaks, it stops here with a
   plain-English reason and nothing is created. Then it:
   - creates a Postgres database and runs your migrations,
   - puts up the sign-in front door and adds you as the owner,
   - creates the photo storage,
   - builds and deploys the app,
   - hands back a live URL, a QR code, and a saved card you can share.

   The demo deployed live to a real database and host, and was tested: the seeded recipe
   showed on first open, signing in worked, adding a recipe through the real UI saved it to the
   live database, the photo storage accepted and served a file, and the owner-only "who's in"
   screen worked. A forged sign-in cookie was rejected.

5. **Undo anytime.** `deployctl down .` removes everything it created.

## The three repositories

- **`deployment-platform`** — the engine. The manifest contract, the conformance gate, the
  auth SDK, and the `deployctl` CLI. This is the operator side.
- **`dp-starter`** — the template you start a new app from. Self-contained, deployable.
- **`recipe-box`** — the demo app, built from the starter and deployed live, as proof.

## The stack it deploys to (chosen for you)

On the `personal` profile: Next.js, Postgres, an email-allowlist sign-in, and file storage,
on Vercel + Supabase. You never pick these.

There is now a second profile, `org`, that deploys the same apps onto a machine the owner
owns instead of Vercel/Supabase. v1 binds to a Google Cloud VM that already runs Caddy
(automatic HTTPS) in front of per-app systemd services: `deployctl up --profile org` ships
the app onto the VM, runs it as its own background service on a private port, and gives it an
address with HTTPS at `<name>.<vm-ip>.sslip.io`. It is idempotent (re-running updates in
place) and reversible (`down` removes everything it made), and it guards whatever else is on
the box — it backs up the shared web-server config, validates before reloading, and rolls
back if the existing site stops answering. v1 deploys apps that need no database or secret
keys; a richer binding later (Cloud SQL, a managed sign-in, or Cloud Run images) can deploy
the same apps without code changes.

## The portal: deploying from a browser

`up` is also wrapped in a one-screen browser portal that runs on the owner's VM but deploys
into each person's **own** Vercel and Supabase. You paste a GitHub repo, give it a name, and
paste your own two keys (or commit a `.env.deploy` in the repo and skip the form); it clones
the repo, runs the same deploy with your keys, streams the same plain-English narration down
the page, and hands back the live link. The app is now on your own accounts, not anyone
else's. Because it clones and runs code, the portal sits behind a login, and it is fail-closed:
a deploy with no key is refused, it can never fall back to the owner's accounts, and an
untrusted repo can never route itself onto the VM. It is the "open it in a browser, get a
link" experience with no terminal at all.

## What is real vs. what a hosted product would add

The demo runs the SDK as vendored source inside the starter and `deployctl` as a locally
installed command, because that is enough to prove the flow on one machine. A hosted product
would publish the SDK as a package and run `deployctl` as a hosted, globally installed command,
so a non-engineer never sets anything up.
