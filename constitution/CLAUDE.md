# How to build an app the platform can ship

You are building an app for someone who is not an engineer. They had an idea. Your job is
to turn it into something real that they can open on their phone, share with a friend, and
own. They should never have to make a technology decision, and they should never see a
blank screen, a stack trace, or a word of jargon.

This file is the contract. Follow it and the platform can take whatever you build and put
it on the internet in one command: `deployctl up`.

---

## The five principles (these are not optional)

**1. Warm first open.** A brand-new app is never a blank screen. Seed it with a friendly
example so the very first visit already has something in it. The first thing the owner
sees should make them smile, not ask "now what?".

**2. Human nouns.** In anything the person reads, never say database, auth, bucket, env
var, deploy, or token. Say "your saved notes", "who can get in", "your photos". The
technical words belong in the code and in `app.deploy.yaml`, never on the screen.

**3. Installable by default.** Every web app is a PWA: it has a manifest, an icon, and a
theme color, so it can live on a phone home screen like a real app. Build it so the Phone
Drop works.

**4. Plain English everywhere.** Every button, every empty state, and especially every
error speaks in short, plain sentences. "That email is not on the list yet. Ask the owner
to let you in." Not "403 Forbidden".

**5. The owner is in control.** Their data is theirs. Access is theirs to grant ("let my
mom in"). Anything destructive is clearly labelled and reversible where possible. Never do
something silent, scary, or final on their behalf.

---

## The contract: every app ships an `app.deploy.yaml`

This is how the platform knows what your app is and how to ship it. Write it at the top of
the project. Keep the keys exactly as below; these are technical and stable.

```yaml
name: my-app            # 3-40 chars, lowercase letters, numbers, dashes
blueprint: web          # one of: static, web, worker
web:
  framework: nextjs
database:               # include only if the app saves data
  engine: postgres
  migrations: ./migrations
auth:                   # include only if the app has sign-in
  tier: proper          # none | simple | proper. 'proper' is Google sign-in (use this).
  signup: open          # open (anyone can sign in) | invite (only people the owner lets in)
  roles:                # the roles YOUR app understands. Name each one and say what it can do.
    - name: editor
      can: post and edit
    - name: viewer
      can: only read
  default: viewer        # the role everyone who signs in gets. Must be one of roles above.
storage:                # include only if the app stores files
  buckets:
    - photos
env:                    # secrets the user must supply, if any
  required: []
  optional: []
```

### Pick a blueprint, do not invent one

- **static** — a page or tool with no saved data and no sign-in. Ships to a fast CDN.
- **web** — the normal case: a frontend, a server, saved data, optional sign-in. This is
  what most ideas are.
- **worker** — something that runs on a schedule in the background.

If the idea does not fit a blueprint, pick the closest one and keep it simple. Do not reach
for a technology the platform does not support.

---

## The rules that make one-command deploy possible

**Read configuration from the environment. Never hardcode a secret.** The platform supplies
these at deploy time. In code, always:

```ts
const url = process.env.DATABASE_URL;   // the platform sets this
```

Never paste a connection string, an API key, or a service key into a file. The conformance
check will catch it and refuse to deploy, because secrets in code get published with the
app.

**Use the platform SDK for identity. Never roll your own login.**

```ts
import { getUser, requireUser, requireRole } from "@platform/auth/next";

const user = await getUser();           // who is signed in, or null (has .email, .name)
await requireUser();                    // throws if nobody is signed in
await requireRole("editor");            // throws unless the person can do the "editor" things
```

Sign-in is Google (`tier: proper`). The platform ships the whole front door: the "Continue with
Google" screen, the sign-in, the session, and the owner's "who's in" screen. You do not build a
login, an allowlist, or a settings page. Two route files, copied verbatim, are all the wiring:

```ts
// app/auth/google/route.ts
export { googleStart as GET } from "@platform/auth/next";
// app/auth/google/callback/route.ts
export { googleCallback as GET } from "@platform/auth/next";
```

**Roles: you declare them, the platform assigns them.** This is the whole division of labor.
Your job is one thing: name the roles your app understands in `app.deploy.yaml`, each with a
plain-English line of what it can do (`editor: post and edit`). Then gate your code with
`requireRole("editor")` and read `getUser()` for who's signed in. That is all the app does.

Everything else is the platform's job, not yours: real people (verified by Google), the named
**groups** the owner sorts them into, and the mapping from a group to the roles it grants. The
owner does that on a screen the platform provides. You never write group or permission code, and
you never store a list of who is an admin. A person's roles are resolved live, so the moment the
owner moves someone between groups, it takes effect. Everyone who signs in gets the `default`
role; `signup: open` lets anyone sign in, `signup: invite` limits it to people the owner adds.

The check (`deployctl check`) reads every `requireRole("x")` in your code and refuses to deploy
if `x` is not one of the roles you declared, so a typo can never leave a door that opens for
no one.

**Saved data lives in Postgres, reached through `DATABASE_URL`.** Put your schema in
`./migrations` as plain, numbered `.sql` files (`0001_init.sql`, `0002_add_photos.sql`).
The platform runs them in order on every deploy and only runs what is new. Make them safe
to re-run (`create table if not exists`).

**Files and images go in a storage bucket** named in `app.deploy.yaml`. The platform
creates it. Read and write it through the platform's storage helper, not a hardcoded URL.

---

## The default stack (personal profile)

You do not choose these. The platform does. Build for them:

- **Next.js** (App Router) for the web app.
- **Postgres** for saved data, reached with the `pg` client and `DATABASE_URL`.
- **`@platform/auth`** for Google sign-in, roles, and the owner's "who's in" screen.
- **PWA** manifest, icon, and theme color so it installs on a phone.

Keep dependencies few. Prefer the boring, proven choice. The less the app invents, the more
reliably the platform can ship it.

---

## Before you say it is done

Run the check. It is the same check the platform runs before it deploys:

```bash
deployctl check .
```

If it finds something, it tells you exactly what and how to fix it, in plain English. Fix
it and run again. When it says the app is ready, `deployctl up` will put it live.
