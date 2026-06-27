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
   anything. (It is the same check the engine runs again before deploying, so it cannot be
   skipped.)

4. **Ship it.** `deployctl up .` makes every technology decision for you and:
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

Next.js, Postgres, an email-allowlist sign-in, and file storage, on Vercel + Supabase. You
never pick these. The plan is a second profile later (a company stack: Cloud Run, Cloud SQL,
company sign-in) that the same apps deploy to without code changes.

## What is real vs. what a hosted product would add

The demo runs the SDK as vendored source inside the starter and `deployctl` as a locally
installed command, because that is enough to prove the flow on one machine. A hosted product
would publish the SDK as a package and run `deployctl` as a hosted, globally installed command,
so a non-engineer never sets anything up.
