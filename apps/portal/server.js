// The Drop — the browser portal that wraps deployctl.
//
// One calm screen. Paste a GitHub repo, give it a name, press the button, and watch the
// platform's own plain-English narration stream down the page while the app is put live on
// your own Google Cloud. When it answers, you get the Deed: a live link, on the spot.
//
// It runs ON the VM (DP_TARGET=local) and shells out to the very same `deployctl up` the CLI
// uses, so there is one deploy path, not two. It is meant to sit behind an authentication
// gate (Caddy basic_auth) because it clones and runs code — never expose it open.
//
// Zero dependencies on purpose: it is itself a clean example of an app this platform deploys.
const http = require("node:http");
const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, dirname } = require("node:path");
const { randomBytes } = require("node:crypto");

const PORT = Number(process.env.PORT) || 8090;
const HOST = process.env.HOST || "127.0.0.1";
// A per-process token, embedded in the page and required on the deploy endpoint. Because
// the page sits behind the auth gate, a cross-site attacker can't read the token, so it
// can't forge a deploy with the owner's ambient credentials (CSRF defense for the SSE GET).
const CSRF = randomBytes(16).toString("hex");
// Only one deploy at a time: it serializes port selection (no race) and bounds the load.
let busy = false;
// The repo root is two levels up from apps/portal. The CLI lives under it.
const REPO_ROOT = join(__dirname, "..", "..");
const CLI = join(REPO_ROOT, "packages", "cli", "src", "index.ts");
const CONFD = "/etc/caddy/conf.d";

// ---------- helpers ----------
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const REPO_RE = /^https:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(\.git)?$/;

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 38);
}

/** Read the apps this portal has deployed, straight from their Caddy site files on disk. */
function listApps() {
  const apps = [];
  let files = [];
  try {
    files = readdirSync(CONFD).filter((f) => /^dp-.*\.caddy$/.test(f));
  } catch {
    return apps;
  }
  for (const f of files) {
    const slug = f.replace(/^dp-/, "").replace(/\.caddy$/, "");
    if (slug === "portal") continue; // don't list the portal itself
    let host = `${slug}`;
    try {
      const txt = readFileSync(join(CONFD, f), "utf8");
      const m = txt.match(/^([^\s{]+)\s*\{/m);
      if (m) host = m[1];
    } catch {}
    apps.push({ slug, host });
  }
  return apps;
}

function statusOf(slug) {
  return new Promise((resolve) => {
    const c = spawn("systemctl", ["is-active", `dp-${slug}`]);
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("close", () => resolve(out.trim() || "unknown"));
    c.on("error", () => resolve("unknown"));
  });
}

// ---------- pages ----------
function shell(body) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Your own cloud</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; background:#faf6ef; color:#2b2620;
    font:17px/1.6 ui-rounded,"SF Pro Rounded",system-ui,-apple-system,sans-serif; padding:40px 20px; }
  .wrap { max-width:640px; margin:0 auto; }
  h1 { font-size:30px; letter-spacing:-.02em; margin:0 0 4px; }
  .tag { color:#8a8178; margin:0 0 28px; }
  .card { background:#fffdf8; border:1px solid #ece3d2; border-radius:20px; padding:26px 24px;
    box-shadow:0 16px 44px -30px rgba(80,60,20,.5); margin-bottom:22px; }
  label { display:block; font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:#9a8c6f; margin:14px 0 6px; }
  input { width:100%; font-size:16px; padding:12px 14px; border:1px solid #e3d8c2; border-radius:12px;
    background:#fffefb; color:#2b2620; font-family:inherit; }
  input:focus { outline:none; border-color:#cBa96a; box-shadow:0 0 0 3px rgba(214,180,110,.25); }
  button { margin-top:18px; width:100%; font-size:17px; font-weight:600; font-family:inherit; cursor:pointer;
    padding:14px; border:none; border-radius:12px; background:#2b2620; color:#faf6ef; transition:transform .05s; }
  button:hover { background:#3a342b; } button:active { transform:translateY(1px); }
  button:disabled { opacity:.5; cursor:default; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:14px; }
  .tile { display:block; text-decoration:none; color:inherit; background:#fffdf8; border:1px solid #ece3d2;
    border-radius:16px; padding:16px; transition:transform .08s, box-shadow .08s; }
  .tile:hover { transform:translateY(-2px); box-shadow:0 12px 30px -22px rgba(80,60,20,.6); }
  .tile .name { font-weight:600; font-size:17px; }
  .tile .host { font:12px/1.4 ui-monospace,Menlo,monospace; color:#9a8c6f; word-break:break-all; margin-top:4px; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; background:#bbb; }
  .dot.active { background:#4caf72; } .dot.down { background:#e0644b; }
  .empty { color:#9a8c6f; }
  #log { margin-top:18px; font:14px/1.7 ui-monospace,Menlo,monospace; color:#5b5346;
    background:#f6efe2; border-radius:12px; padding:16px; max-height:340px; overflow:auto; display:none; white-space:pre-wrap; }
  #log .ok { color:#1f8a4c; } #log .err { color:#c0392b; }
  .deed { display:none; text-align:center; }
  .deed .badge { display:inline-block; background:#eafaef; color:#1f8a4c; font-weight:600; font-size:13px; padding:4px 12px; border-radius:999px; }
  .deed h2 { font-size:26px; margin:12px 0 4px; }
  .deed a.url { display:inline-block; margin:10px 0; color:#e0644b; font-weight:600; word-break:break-all; }
  .deed .open { display:inline-block; margin-top:10px; padding:12px 22px; border-radius:12px; background:#2b2620; color:#faf6ef; text-decoration:none; font-weight:600; }
  h3 { font-size:14px; text-transform:uppercase; letter-spacing:.06em; color:#9a8c6f; margin:28px 0 12px; }
</style></head><body><div class="wrap">${body}</div></body></html>`;
}

async function homePage() {
  const apps = listApps();
  const withStatus = await Promise.all(apps.map(async (a) => ({ ...a, status: await statusOf(a.slug) })));
  const grid = withStatus.length
    ? `<div class="grid">${withStatus
        .map(
          (a) =>
            `<a class="tile" href="https://${a.host}" target="_blank" rel="noopener">
               <div class="name"><span class="dot ${a.status === "active" ? "active" : "down"}"></span>${a.slug}</div>
               <div class="host">${a.host}</div>
             </a>`,
        )
        .join("")}</div>`
    : `<p class="empty">Nothing here yet. Put your first thing online below.</p>`;

  return shell(`
    <h1>Your own cloud</h1>
    <p class="tag">A little street of the things you've made, all on your own machine.</p>

    <h3>Living here</h3>
    ${grid}

    <h3>Put something online</h3>
    <div class="card">
      <form id="drop">
        <label for="repo">Paste a GitHub repo</label>
        <input id="repo" name="repo" placeholder="https://github.com/you/your-app" autocomplete="off" />
        <label for="name">What should we call it?</label>
        <input id="name" name="name" placeholder="my-app" autocomplete="off" />
        <button id="go" type="submit">Put it online</button>
      </form>
      <div id="log"></div>
      <div class="deed" id="deed">
        <span class="badge">Live now</span>
        <h2 id="deedName">It's alive</h2>
        <div><a class="url" id="deedUrl" href="#" target="_blank"></a></div>
        <a class="open" id="deedOpen" href="#" target="_blank">Open it →</a>
      </div>
    </div>

    <script>
      const form = document.getElementById('drop');
      const log = document.getElementById('log');
      const deed = document.getElementById('deed');
      const go = document.getElementById('go');
      function line(text, cls) {
        const div = document.createElement('div');
        if (cls) div.className = cls;
        div.textContent = text;
        log.appendChild(div);
        log.scrollTop = log.scrollHeight;
      }
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const repo = document.getElementById('repo').value.trim();
        const name = document.getElementById('name').value.trim();
        log.style.display = 'block'; log.innerHTML = ''; deed.style.display = 'none';
        go.disabled = true; go.textContent = 'Working…';
        const es = new EventSource('/api/deploy?repo=' + encodeURIComponent(repo) + '&name=' + encodeURIComponent(name) + '&csrf=${CSRF}');
        es.addEventListener('log', (ev) => line(ev.data));
        es.addEventListener('done', (ev) => {
          es.close(); go.disabled = false; go.textContent = 'Put it online';
          const url = ev.data;
          document.getElementById('deedName').textContent = (name || 'Your app') + " is live";
          const a = document.getElementById('deedUrl'); a.href = url; a.textContent = url;
          document.getElementById('deedOpen').href = url;
          deed.style.display = 'block';
          line('the door answered, it is live', 'ok');
        });
        es.addEventListener('failed', (ev) => {
          es.close(); go.disabled = false; go.textContent = 'Try again';
          line(ev.data || 'Something stopped the deploy.', 'err');
        });
        es.onerror = () => { es.close(); go.disabled = false; go.textContent = 'Try again'; };
      });
    </script>
  `);
}

// ---------- deploy (SSE) ----------
function sse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  let closed = false;
  res.on("close", () => (closed = true));
  res.on("error", () => (closed = true));
  return {
    get closed() {
      return closed;
    },
    send(event, data) {
      if (closed) return;
      try {
        res.write(`event: ${event}\n`);
        for (const l of String(data).split("\n")) res.write(`data: ${l}\n`);
        res.write("\n");
      } catch {
        closed = true;
      }
    },
    end() {
      if (closed) return;
      try {
        res.end();
      } catch {}
    },
  };
}

function deploy(req, res, query) {
  const ch = sse(res);
  const repo = (query.repo || "").trim();
  const slug = slugify(query.name || "");

  if (query.csrf !== CSRF) {
    ch.send("failed", "Your session expired. Refresh the page and try again.");
    return ch.end();
  }
  if (!REPO_RE.test(repo)) {
    ch.send("failed", "That does not look like a GitHub repo link. It should look like https://github.com/you/your-app");
    return ch.end();
  }
  if (!SLUG_RE.test(slug)) {
    ch.send("failed", "Please give it a name of 3-40 lowercase letters, numbers, or dashes (for example: my-app).");
    return ch.end();
  }
  if (busy) {
    ch.send("failed", "Another app is being put online right now. Give it a moment and try again.");
    return ch.end();
  }
  busy = true;

  const work = mkdtempSync(join(tmpdir(), "portal-"));
  const appDir = join(work, slug);
  let urlFound = "";
  let child = null;
  let finished = false;
  const finish = (event, data) => {
    if (finished) return;
    finished = true;
    if (event) ch.send(event, data);
    cleanup(work);
    busy = false;
    ch.end();
  };

  // If the browser goes away mid-deploy, stop the work and free the lock — never write to a
  // dead socket or leave an orphaned clone/build running.
  req.on("close", () => {
    if (finished) return;
    if (child) try { child.kill("SIGKILL"); } catch {}
    finish();
  });

  ch.send("log", "Fetching your code from GitHub...");
  child = spawn("git", ["clone", "--depth", "1", repo, appDir], { stdio: ["ignore", "pipe", "pipe"] });
  let cloneErr = "";
  child.stderr.on("data", (d) => (cloneErr += d));
  child.on("error", (err) => finish("failed", "Could not fetch the repo: " + String(err)));
  child.on("close", (code) => {
    if (finished) return;
    if (code !== 0) {
      return finish("failed", "Could not fetch that repo. Is the link right and the repo public?\n" + tail(cloneErr));
    }
    // Make any repo deployable to your cloud: write the deploy contract for them.
    writeFileSync(
      join(appDir, "app.deploy.yaml"),
      `name: ${slug}\nblueprint: web\nprofile: org\nauth:\n  tier: none\n`,
    );
    ch.send("log", "Handing it to the platform to put online...");

    child = spawn("npx", ["tsx", CLI, "up", appDir], {
      cwd: REPO_ROOT,
      env: { ...process.env, DP_TARGET: "local", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    let tailBuf = "";
    const onData = (d) => {
      const s = d.toString();
      tailBuf = (tailBuf + s).slice(-2000);
      buf += s;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const clean = raw.replace(/^[…✓✗\s]+/, "").trim();
        const urlMatch = raw.match(/https:\/\/[a-z0-9.-]+sslip\.io[^\s]*/i);
        if (urlMatch) urlFound = urlMatch[0];
        if (clean && !/^[-─]+$/.test(clean) && !clean.includes("Scan to put it")) ch.send("log", clean);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => finish("failed", "Could not start the deploy: " + String(err)));
    child.on("close", (code2) => {
      if (code2 === 0 && urlFound) finish("done", urlFound);
      else finish("failed", "The deploy did not finish.\n" + tail(tailBuf));
    });
  });
}

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}
function tail(s) {
  return String(s).split("\n").slice(-8).join("\n");
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (u.pathname === "/api/deploy") {
    return deploy(req, res, Object.fromEntries(u.searchParams));
  }
  if (u.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(await homePage());
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, HOST, () => {
  console.log(`[portal] listening on http://${HOST}:${PORT} (target=${process.env.DP_TARGET || "ssh"})`);
});
