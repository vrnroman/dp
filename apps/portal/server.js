// The Drop -- the browser portal that wraps deployctl.
//
// One calm screen. Paste a GitHub repo, name it, give the two keys to your OWN accounts,
// and press the button. The app is built and shipped to YOUR Vercel and Supabase (not ours),
// while the platform's plain-English narration streams down the page. When it answers, you
// get the Deed: a live link, on the spot.
//
// It runs ON the owner's VM but deploys into each user's OWN cloud: the user supplies their
// Vercel and Supabase tokens (in the form, or a .env.deploy file in the repo), and those are
// passed to `deployctl up` for that one deploy only. The tokens are held in memory for the
// run, never logged, never written to disk, and the portal can never fall back to the owner's
// own accounts (DP_TOKENS_ENV_ONLY=1 makes a tokenless deploy fail closed).
//
// It is meant to sit behind an authentication gate (Caddy basic_auth) because it clones and
// runs code. Zero dependencies on purpose: it is itself a clean example of a deployable app.
const http = require("node:http");
const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { randomBytes } = require("node:crypto");
const { createGate } = require("./auth-gate.js");
const { createStore } = require("./store.js");
const { createGroupsAdmin } = require("./groups-admin.js");

// The DP central store on the VM: groups, people, the app registry, and group->role mappings. A
// single zero-dependency JSON file, provisioned by portal-bootstrap.sh; overridable for tests and
// local runs via DP_STORE_FILE.
const store = createStore(process.env.DP_STORE_FILE || "/var/lib/dp-relay/store.json");

// The portal's own front door. Google sign-in when configured (PORTAL_GOOGLE_CLIENT_ID +
// PORTAL_GOOGLE_CLIENT_SECRET); otherwise a no-op, so the existing Caddy basic_auth gate keeps
// working unchanged. Open signup by default; PORTAL_ALLOWED_EMAILS restricts it. The store lets the
// relay resolve and embed each person's roles in the signed assertion at sign-in.
const gate = createGate({ store });

const PORT = Number(process.env.PORT) || 8090;
const HOST = process.env.HOST || "127.0.0.1";
const REPO_ROOT = join(__dirname, "..", "..");
const CLI = join(REPO_ROOT, "packages", "cli", "src", "index.ts");

// A per-process token, embedded in the page and required on every state-changing request.
// The page is behind the auth gate, so a cross-site attacker can't read the token and can't
// forge a deploy with the owner's ambient credentials (CSRF defense).
const CSRF = randomBytes(16).toString("hex");
// The owner's "Groups & access" screen (/groups) and its endpoints. It reuses the portal CSRF
// token and is only ever reached after the gate confirms a signed-in, allowed owner (see below).
const groupsAdmin = createGroupsAdmin({ store, csrf: CSRF });
// One deploy at a time (bounds load and keeps the streamed output legible).
let busy = false;
// In-flight deploys, so the POST that starts a deploy and the SSE GET that watches it are
// decoupled (no secrets in the streaming URL). id -> job.
const jobs = new Map();

// How long an awaiting-approval job survives after its last watcher disconnects, before the slot
// is freed (a transient reconnect cancels it). Tunable for tests; production default is 45s.
const GRACE_MS = Number(process.env.DP_PORTAL_GRACE_MS) || 45000;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const REPO_RE = /^https:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(\.git)?$/;

function slugify(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 38);
}
function tail(s) {
  return String(s).split("\n").slice(-8).join("\n");
}

// ---------- pages ----------
function shell(body) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Put it online</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; background:#faf6ef; color:#2b2620;
    font:17px/1.6 ui-rounded,"SF Pro Rounded",system-ui,-apple-system,sans-serif; padding:48px 20px; }
  .wrap { max-width:560px; margin:0 auto; }
  h1 { font-size:30px; letter-spacing:-.02em; margin:0 0 4px; }
  .tag { color:#8a8178; margin:0 0 26px; }
  .card { background:#fffdf8; border:1px solid #ece3d2; border-radius:20px; padding:26px 24px;
    box-shadow:0 16px 44px -30px rgba(80,60,20,.5); }
  label { display:block; font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:#9a8c6f; margin:16px 0 6px; }
  label:first-of-type { margin-top:0; }
  input { width:100%; font-size:16px; padding:12px 14px; border:1px solid #e3d8c2; border-radius:12px;
    background:#fffefb; color:#2b2620; font-family:inherit; }
  input:focus { outline:none; border-color:#cba96a; box-shadow:0 0 0 3px rgba(214,180,110,.25); }
  .keys { margin-top:22px; padding-top:20px; border-top:1px solid #efe7d6; }
  .keys .note { font-size:14px; color:#6b6052; background:#f7f0e2; border-radius:12px; padding:12px 14px; margin:0 0 6px; }
  details { margin-top:10px; font-size:14px; color:#7a7062; }
  details summary { cursor:pointer; color:#9a7b32; }
  details ol { margin:8px 0 0; padding-left:20px; }
  button { margin-top:22px; width:100%; font-size:17px; font-weight:600; font-family:inherit; cursor:pointer;
    padding:14px; border:none; border-radius:12px; background:#2b2620; color:#faf6ef; transition:transform .05s; }
  button:hover { background:#3a342b; } button:active { transform:translateY(1px); } button:disabled { opacity:.5; cursor:default; }
  #log { margin-top:18px; font:14px/1.7 ui-monospace,Menlo,monospace; color:#5b5346;
    background:#f6efe2; border-radius:12px; padding:16px; max-height:320px; overflow:auto; display:none; white-space:pre-wrap; }
  #log .ok { color:#1f8a4c; } #log .err { color:#c0392b; }
  .review { display:none; margin-top:18px; background:#fffdf8; border:1px solid #ece3d2; border-radius:16px; padding:20px; }
  .review h3 { margin:0 0 4px; font-size:18px; }
  .review .sub { margin:0 0 14px; color:#8a8178; font-size:14px; }
  .review ul { list-style:none; margin:0; padding:0; }
  .review li { display:flex; gap:10px; align-items:flex-start; padding:10px 12px; border:1px solid #efe7d6; border-radius:12px; margin-bottom:8px; background:#faf6ef; }
  .review li .ic { font-size:16px; line-height:1.5; }
  .review li .txt { flex:1; }
  .review li .txt b { display:block; font-size:15px; }
  .review li .txt small { color:#8a8178; }
  .review .row { display:flex; gap:10px; margin-top:14px; }
  .review .row button { margin-top:0; }
  .review .decline { background:#f0e8d8; color:#5b5346; }
  .review .decline:hover { background:#e7ddc9; }
  .reject { display:none; margin-top:18px; background:#fdecec; border:1px solid #f2c9c9; border-radius:16px; padding:20px; color:#8a2b25; }
  .reject h3 { margin:0 0 8px; font-size:18px; }
  .reject pre { white-space:pre-wrap; font:14px/1.6 inherit; margin:0; }
  .deed { display:none; text-align:center; margin-top:20px; }
  .deed .badge { display:inline-block; background:#eafaef; color:#1f8a4c; font-weight:600; font-size:13px; padding:4px 12px; border-radius:999px; }
  .deed .badge.pending { background:#fcf2dc; color:#9a7b1f; }
  .deed h2 { font-size:24px; margin:12px 0 2px; }
  .deed a.url { display:inline-block; margin:8px 0; color:#e0644b; font-weight:600; word-break:break-all; }
  .deed .where { font-size:13px; color:#8a8178; }
  .deed .open { display:inline-block; margin-top:12px; padding:12px 22px; border-radius:12px; background:#2b2620; color:#faf6ef; text-decoration:none; font-weight:600; }
</style></head><body><div class="wrap">${body}</div></body></html>`;
}

function homePage() {
  return shell(`
    <h1>Put it online</h1>
    <p class="tag">Paste a project, give it a name, and it goes live on your own accounts. <a href="/groups" style="color:#9a7b32; white-space:nowrap">Groups &amp; access →</a></p>
    <div class="card">
      <form id="drop">
        <label for="repo">Paste a GitHub repo</label>
        <input id="repo" name="repo" placeholder="https://github.com/you/your-app" autocomplete="off" />
        <label for="name">What should we call it?</label>
        <input id="name" name="name" placeholder="my-app" autocomplete="off" />

        <div class="keys">
          <p class="note">These go to your <strong>own</strong> accounts, so the app stays yours. We use them once to set things up, then forget them.</p>
          <label for="vercel">Your Vercel token (where it lives on the web)</label>
          <input id="vercel" name="vercel" type="password" placeholder="paste your Vercel token" autocomplete="off" />
          <label for="supabase">Your Supabase token (only if your app saves data or has a sign-in)</label>
          <input id="supabase" name="supabase" type="password" placeholder="leave blank for a simple page" autocomplete="off" />
          <details>
            <summary>Where do I find these?</summary>
            <ol>
              <li><strong>Vercel:</strong> vercel.com, click your avatar, Settings, Tokens, Create Token, copy it.</li>
              <li><strong>Supabase:</strong> supabase.com/dashboard/account/tokens, Generate new token, copy it.</li>
              <li>Or commit a <code>.env.deploy</code> in your repo with <code>VERCEL_TOKEN=</code> and <code>SUPABASE_ACCESS_TOKEN=</code> and leave these blank.</li>
            </ol>
          </details>
        </div>

        <button id="go" type="submit">Put it online</button>
      </form>
      <div id="log"></div>
      <div class="review" id="review">
        <h3>Before it goes live, please confirm what it uses</h3>
        <p class="sub" id="reviewSub">This app connects to outside systems. Approve them if they are expected.</p>
        <ul id="reviewList"></ul>
        <div class="row">
          <button id="approve" type="button">Yes, this is expected. Put it online</button>
          <button id="decline" class="decline" type="button">No, stop</button>
        </div>
      </div>
      <div class="reject" id="reject">
        <h3>This can't go online</h3>
        <pre id="rejectWhy"></pre>
      </div>
      <div class="deed" id="deed">
        <span class="badge" id="deedBadge">Live now</span>
        <h2 id="deedName">It is live</h2>
        <div><a class="url" id="deedUrl" href="#" target="_blank" rel="noopener"></a></div>
        <p class="where" id="deedWhere">Lives in your own Vercel account. We have forgotten your keys.</p>
        <a class="open" id="deedOpen" href="#" target="_blank" rel="noopener">Open it</a>
      </div>
    </div>

    <script>
      var CSRF = '${CSRF}';
      var form = document.getElementById('drop');
      var log = document.getElementById('log');
      var deed = document.getElementById('deed');
      var reviewBox = document.getElementById('review');
      var rejectBox = document.getElementById('reject');
      var go = document.getElementById('go');
      var approvedNote = '';
      var ICON = { payments:'💳', ai:'🤖', 'object-storage':'🗄️', queue:'📨', email:'✉️', sms:'💬', database:'🗃️', analytics:'📊', search:'🔎', monitoring:'🚨', auth:'🔑' };
      function line(text, cls) {
        var div = document.createElement('div');
        if (cls) div.className = cls;
        div.textContent = text;
        log.appendChild(div); log.scrollTop = log.scrollHeight;
      }
      function reset(label) {
        go.disabled = false; go.textContent = label || 'Put it online';
        reviewBox.style.display = 'none';
      }
      function decide(id, decision) {
        var approve = document.getElementById('approve'), declineBtn = document.getElementById('decline');
        approve.disabled = true; declineBtn.disabled = true;
        reviewBox.style.display = 'none';
        fetch('/api/deploy/decide', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: id, decision: decision, csrf: CSRF }) })
          .then(function (r) { return r.json(); })
          .then(function (res) { if (res && res.error) throw new Error(res.error); })
          .catch(function () {
            // The job is still waiting on the server, so let the person choose again rather than
            // leaving the deploy stuck. (If the server did receive it, its SSE event cleans up.)
            line('Could not send your decision. Please choose again.', 'err');
            approve.disabled = false; declineBtn.disabled = false;
            reviewBox.style.display = 'block';
          });
      }
      function renderReview(data, id) {
        var list = document.getElementById('reviewList'); list.innerHTML = '';
        function item(icon, title, note) {
          var li = document.createElement('li');
          var ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = icon;
          var tx = document.createElement('div'); tx.className = 'txt';
          var b = document.createElement('b'); b.textContent = title; tx.appendChild(b);
          if (note) { var sm = document.createElement('small'); sm.textContent = note; tx.appendChild(sm); }
          li.appendChild(ic); li.appendChild(tx); list.appendChild(li);
        }
        (data.services || []).forEach(function (s) { item(ICON[s.category] || '🔌', s.label, s.secret ? 'Uses your ' + s.secret + ' key' : ''); });
        (data.otherItems || []).forEach(function (t) { item('⚠️', t, ''); });
        approvedNote = (data.services || []).map(function (s) { return s.label; }).join('; ');
        var approve = document.getElementById('approve'), declineBtn = document.getElementById('decline');
        approve.disabled = false; declineBtn.disabled = false;
        approve.onclick = function () { go.textContent = 'Putting it online...'; decide(id, 'approve'); };
        declineBtn.onclick = function () { approvedNote = ''; decide(id, 'decline'); reset(); };
        reviewBox.style.display = 'block';
      }
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var body = {
          repo: document.getElementById('repo').value.trim(),
          name: document.getElementById('name').value.trim(),
          vercel: document.getElementById('vercel').value.trim(),
          supabase: document.getElementById('supabase').value.trim(),
          csrf: CSRF
        };
        log.style.display = 'block'; log.innerHTML = ''; deed.style.display = 'none';
        reviewBox.style.display = 'none'; rejectBox.style.display = 'none'; approvedNote = '';
        go.disabled = true; go.textContent = 'Working...';
        fetch('/api/deploy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
          .then(function (r) { return r.json(); })
          .then(function (res) {
            if (!res || !res.id) { line((res && res.error) || 'Could not start.', 'err'); reset('Try again'); return; }
            var es = new EventSource('/api/deploy/stream?id=' + encodeURIComponent(res.id) + '&csrf=' + CSRF);
            function showDeed(url, live) {
              var a = document.getElementById('deedUrl'); a.href = url; a.textContent = url;
              document.getElementById('deedOpen').href = url;
              var badge = document.getElementById('deedBadge');
              badge.textContent = live ? 'Live now' : 'Going live...';
              badge.className = 'badge' + (live ? '' : ' pending');
              document.getElementById('deedName').textContent = (body.name || 'Your app') + (live ? ' is live' : ' is going live');
              var whereText = live
                ? 'Lives in your own Vercel account. We have forgotten your keys.'
                : 'You can keep this link now. It goes live the moment the build finishes (about a minute).';
              if (approvedNote) whereText += ' You approved: ' + approvedNote + '.';
              document.getElementById('deedWhere').textContent = whereText;
              deed.style.display = 'block';
            }
            es.addEventListener('log', function (ev) { line(ev.data); });
            es.addEventListener('link', function (ev) { showDeed(ev.data, false); });
            es.addEventListener('approval', function (ev) {
              var data; try { data = JSON.parse(ev.data); } catch (e) { data = { services: [], otherItems: [] }; }
              renderReview(data, res.id);
            });
            es.addEventListener('rejected', function (ev) {
              es.close(); reset('Try a different app');
              document.getElementById('rejectWhy').textContent = ev.data || 'The platform rules do not allow it.';
              rejectBox.style.display = 'block';
            });
            es.addEventListener('declined', function (ev) {
              es.close(); reset();
              line(ev.data || 'Okay, nothing was put online.');
            });
            es.addEventListener('done', function (ev) {
              es.close(); reset();
              // Forget the keys in the browser too.
              document.getElementById('vercel').value = ''; document.getElementById('supabase').value = '';
              showDeed(ev.data, true);
              line('the door answered, it is live', 'ok');
            });
            es.addEventListener('failed', function (ev) { es.close(); reset('Try again'); line(ev.data || 'Something stopped the deploy.', 'err'); });
            es.onerror = function () { es.close(); reset('Try again'); };
          })
          .catch(function (err) { line('Could not reach the portal: ' + err, 'err'); reset('Try again'); });
      });
    </script>
  `);
}

// ---------- SSE ----------
function sse(res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  let closed = false;
  // A comment heartbeat keeps proxies and idle timeouts from dropping the connection during the
  // (possibly minutes-long) human approval hold, when no real events are flowing.
  const hb = setInterval(() => {
    if (closed) return;
    try { res.write(": keep-alive\n\n"); } catch { closed = true; }
  }, 25000);
  const shut = () => { closed = true; clearInterval(hb); };
  res.on("close", shut);
  res.on("error", shut);
  return {
    get closed() { return closed; },
    send(event, data) {
      if (closed) return;
      try {
        res.write(`event: ${event}\n`);
        for (const l of String(data).split("\n")) res.write(`data: ${l}\n`);
        res.write("\n");
      } catch { closed = true; }
    },
    end() { clearInterval(hb); if (!closed) try { res.end(); } catch {} },
  };
}

// ---------- deploy ----------
const TERMINAL = new Set(["done", "failed", "rejected", "declined"]);
function emit(job, event, data) {
  job.events.push({ event, data });
  for (const ch of job.subs) ch.send(event, data);
  if (TERMINAL.has(event)) {
    job.done = true;
    for (const ch of job.subs) ch.end();
    setTimeout(() => jobs.delete(job.id), 60000);
  }
}

/** Force the personal profile and the user's chosen name; respect everything else in the repo's
 *  manifest (its database/auth/storage/env). A repo declaring profile:org must NOT route to the
 *  owner's VM, so the profile line is always stripped (personal is the default). */
function ensurePersonalManifest(appDir, slug) {
  const p = join(appDir, "app.deploy.yaml");
  if (existsSync(p)) {
    let text = readFileSync(p, "utf8");
    text = text.replace(/^profile\s*:.*$/gm, "").replace(/^name\s*:.*$/gm, "");
    text = `name: ${slug}\n` + text.replace(/^\n+/, "");
    writeFileSync(p, text);
  } else {
    writeFileSync(p, `name: ${slug}\nblueprint: web\nweb:\n  framework: nextjs\n`);
  }
}

/** If the user left the form blank, accept tokens committed in a .env.deploy / deploy.env, then
 *  DELETE that file before the deploy's secret scan runs (so it is never shipped or refused). */
function tokensFromRepoFile(appDir, creds) {
  for (const name of [".env.deploy", "deploy.env"]) {
    const p = join(appDir, name);
    if (!existsSync(p)) continue;
    try {
      const text = readFileSync(p, "utf8");
      const get = (k) => (text.match(new RegExp("^\\s*" + k + "\\s*=\\s*(.*)\\s*$", "m")) || [])[1];
      creds.vercel = creds.vercel || (get("VERCEL_TOKEN") || "").replace(/^["']|["']$/g, "");
      creds.supabase = creds.supabase || (get("SUPABASE_ACCESS_TOKEN") || "").replace(/^["']|["']$/g, "");
      creds.region = creds.region || (get("SUPABASE_REGION") || "").replace(/^["']|["']$/g, "");
    } catch {}
    rmSync(p, { force: true });
  }
}

// Build the compact approval summary the browser renders: the plain-English things a person must
// confirm before this app goes live. Deterministic facts only (no AI); every line comes straight
// from the code the evaluator read.
function approvalSummary(review) {
  const f = review.facts || {};
  const v = review.verdict || {};
  const services = (f.externalServices || []).map((s) => ({
    label: s.label,
    secret: s.secret || "",
    category: s.category || "other",
  }));
  // The remaining flags that are not a named service (personal-data-without-sign-in, an unknown
  // host, a powerful capability) still need a person's okay, so include them as plain lines.
  const otherItems = (v.findings || [])
    .filter((x) => x.level === "flag" && x.topic !== "service")
    .map((x) => x.detail);
  return { name: f.name || "", services, otherItems };
}

// The plain no: why a blocked app cannot ship, in the house voice.
function rejectionText(review) {
  const denies = ((review.verdict && review.verdict.findings) || []).filter((x) => x.level === "deny");
  const why = denies.map((x) => "- " + x.detail).join("\n") || "- It uses something the platform's rules do not allow.";
  return "This app can't be put online as it is. The rules do not allow:\n" + why;
}

// The whole deploy is one orchestration: fetch -> review -> (approve) -> put online. The review
// step is the gate. A "blocked" app is refused; a "needs-review" app HOLDS here until the person
// approves in the browser (POST /api/deploy/decide resumes it); an "allowed" app flows straight on.
function runDeploy(job, creds) {
  const work = mkdtempSync(join(tmpdir(), "portal-"));
  const appDir = join(work, job.slug);
  let child = null;
  let watchdog = null;
  let approvalTimer = null;

  // Mask the user's tokens out of anything we stream or store, in case a downstream tool
  // ever echoes them in an error.
  const redact = (s) => {
    let out = String(s);
    if (creds.vercel) out = out.split(creds.vercel).join("***");
    if (creds.supabase) out = out.split(creds.supabase).join("***");
    return out;
  };

  const finish = (event, data) => {
    if (job.done) return;
    clearTimeout(watchdog);
    clearTimeout(approvalTimer);
    clearTimeout(job.reconnectGrace);
    job.decide = null;
    if (event) emit(job, event, redact(data));
    try { if (child) child.kill("SIGKILL"); } catch {}
    rmSync(work, { recursive: true, force: true });
    busy = false;
  };
  const armWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => finish("failed", "This deploy took too long and was stopped. Please try again."), 6 * 60 * 1000);
  };
  armWatchdog();

  emit(job, "log", "Fetching your code from GitHub...");
  child = spawn("git", ["clone", "--depth", "1", job.repo, appDir], { stdio: ["ignore", "pipe", "pipe"] });
  let cloneErr = "";
  child.stderr.on("data", (d) => (cloneErr += d));
  child.on("error", (err) => finish("failed", "Could not fetch the repo: " + String(err)));
  child.on("close", (code) => {
    if (job.done) return;
    if (code !== 0) return finish("failed", "Could not fetch that repo. Is the link right and the repo public?\n" + tail(cloneErr));

    tokensFromRepoFile(appDir, creds);
    if (!creds.vercel) {
      return finish("failed", "This needs your Vercel token to deploy to your own account. Paste it above, or add a .env.deploy to your repo.");
    }
    ensurePersonalManifest(appDir, job.slug);
    reviewPhase();
  });

  // ---- phase 1: the compliance review (the gate) ----
  function reviewPhase() {
    if (job.done) return;
    job.phase = "review";
    emit(job, "log", "Checking what your app connects to before it goes live...");
    // Deterministic facts + verdict only: fast, and never dependent on a model being reachable on
    // this machine. The full AI brief stays a `deployctl review` feature.
    const env = { ...process.env, NO_COLOR: "1" };
    child = spawn("npx", ["tsx", CLI, "review", appDir, "--no-brief", "--json"], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    // Parse the JSON verdict from STDOUT only. stderr (tsx/npx notices, which can contain braces)
    // is kept separate so it can never corrupt the parse, and is used only for a fallback message.
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", () => finish("failed", "The safety review could not run, so nothing was put online. Please try again."));
    child.on("close", () => {
      if (job.done) return;
      let review = null;
      try {
        const s = out.indexOf("{"), e = out.lastIndexOf("}");
        if (s >= 0 && e > s) review = JSON.parse(out.slice(s, e + 1));
      } catch {}
      // Fail closed: if we cannot read a verdict, we do not deploy. But surface the REAL reason
      // (almost always an invalid app.deploy.yaml, whose plain-English errors `review` prints to
      // stdout) instead of a generic "try again" that would loop the user with no way forward.
      if (!review || !review.verdict || !review.verdict.decision) {
        const detail = (out.trim() || err.trim()).split("\n").slice(-12).join("\n");
        return finish("failed", "This app needs fixing before it can go online:\n" + (detail || "The deploy file could not be read."));
      }
      const decision = review.verdict.decision;
      if (decision === "blocked") return finish("rejected", rejectionText(review));
      if (decision === "needs-review") return awaitApproval(review);
      // allowed — the clean bill. No human approval was needed, so do NOT tell `up`'s gate it was
      // approved: its own review re-runs and stays authoritative and fail-closed.
      emit(job, "log", "Checked what it connects to: nothing outside its own platform. All clear.");
      deployPhase(false);
    });
  }

  // ---- the hold: wait for the person to approve the external systems ----
  function awaitApproval(review) {
    job.phase = "awaiting-approval";
    emit(job, "approval", JSON.stringify(approvalSummary(review)));
    // Stop the deploy watchdog while a human decides; give them a generous window.
    clearTimeout(watchdog);
    approvalTimer = setTimeout(
      () => finish("failed", "No decision was made in time, so nothing was put online. You can start again when ready."),
      10 * 60 * 1000,
    );
    job.decide = (choice) => {
      if (job.done || job.phase !== "awaiting-approval") return;
      job.decide = null;
      clearTimeout(approvalTimer);
      if (choice !== "approve") return finish("declined", "Okay, nothing was put online.");
      emit(job, "log", "Approved. Putting it online...");
      armWatchdog();
      deployPhase(true);
    };
  }

  // ---- phase 2: hand it to the platform to put online ----
  // `approved` is true ONLY when a person confirmed the needs-review list. It is passed to `up`'s
  // own gate as DP_COMPLIANCE_APPROVED; on the allowed path it is false, so `up`'s re-review stays
  // authoritative and fail-closed (a divergent needs-review there refuses, never auto-approves).
  function deployPhase(approved) {
    if (job.done) return;
    job.phase = "deploying";
    // Fail-closed env: force the personal profile, supply ONLY the user's tokens, and make sure
    // nothing the portal itself holds can leak into the user's deploy. We NEVER set DP_SKIP_REVIEW,
    // so `up`'s gate always re-runs fail-closed on the server side.
    const env = { ...process.env, DP_TOKENS_ENV_ONLY: "1", DP_FORCE_PROFILE: "personal", VERCEL_TOKEN: creds.vercel, NO_COLOR: "1" };
    if (approved) env.DP_COMPLIANCE_APPROVED = "1";
    else delete env.DP_COMPLIANCE_APPROVED;
    if (creds.supabase) env.SUPABASE_ACCESS_TOKEN = creds.supabase;
    else delete env.SUPABASE_ACCESS_TOKEN;
    if (creds.region) env.SUPABASE_REGION = creds.region;
    else delete env.SUPABASE_REGION;
    delete env.DP_TARGET; // deploy to the user's Vercel/Supabase (personal), never the owner's VM
    delete env.DP_SKIP_REVIEW; // the server-side gate stays on, no matter the portal's environment

    child = spawn("npx", ["tsx", CLI, "up", appDir], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let urlFound = "", linkSent = false, buf = "", tailBuf = "";
    const onData = (d) => {
      const s = d.toString();
      tailBuf = (tailBuf + s).slice(-2000);
      buf += s;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, nl); buf = buf.slice(nl + 1);
        const clean = raw.replace(/^[.…✓✗\s]+/, "").trim();
        const m = raw.match(/https:\/\/[a-z0-9.-]+\.vercel\.app[^\s]*/i);
        if (m) {
          urlFound = m[0];
          // Show the address as soon as Vercel assigns it, before the build is done.
          if (!linkSent) { linkSent = true; emit(job, "link", m[0]); }
        }
        if (clean && !/^[-─]+$/.test(clean) && !clean.includes("Scan to put it")) emit(job, "log", redact(clean));
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => finish("failed", "Could not start the deploy: " + String(err)));
    child.on("close", (code2) => {
      if (code2 === 0 && urlFound) finish("done", urlFound);
      else finish("failed", "The deploy did not finish.\n" + tail(tailBuf));
    });
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (d) => { b += d; if (b.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

async function startDeploy(req, res) {
  const body = await readBody(req);
  const send = (obj) => { try { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); } catch {} };
  if (body.csrf !== CSRF) return send({ error: "Your session expired. Refresh the page and try again." });
  const repo = String(body.repo || "").trim();
  const slug = slugify(body.name || "");
  if (!REPO_RE.test(repo)) return send({ error: "That does not look like a GitHub repo link. It should look like https://github.com/you/your-app" });
  if (!SLUG_RE.test(slug)) return send({ error: "Please give it a name of 3-40 lowercase letters, numbers, or dashes (for example: my-app)." });
  if (busy) return send({ error: "Another app is being put online right now. Give it a moment and try again." });
  busy = true;

  const id = randomBytes(9).toString("hex");
  const job = { id, repo, slug, events: [], subs: new Set(), done: false };
  jobs.set(id, job);
  // creds live only here, passed to the subprocess env; never stored on the job or emitted.
  try {
    runDeploy(job, { vercel: String(body.vercel || "").trim(), supabase: String(body.supabase || "").trim(), region: "" });
  } catch (e) {
    jobs.delete(id);
    busy = false;
    return send({ error: "Could not start the deploy: " + String(e) });
  }
  send({ id });
}

// The person's approve/decline on the held review. Resumes the paused job either way.
async function decideDeploy(req, res) {
  const body = await readBody(req);
  const send = (obj) => { try { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); } catch {} };
  if (body.csrf !== CSRF) return send({ error: "Your session expired. Refresh the page and try again." });
  const job = jobs.get(String(body.id || ""));
  if (!job || typeof job.decide !== "function") {
    return send({ error: "That deploy is no longer waiting for a decision." });
  }
  const choice = body.decision === "approve" ? "approve" : "decline";
  job.decide(choice);
  send({ ok: true });
}

function streamDeploy(req, res, q) {
  const ch = sse(res);
  const job = jobs.get(q.get("id"));
  if (q.get("csrf") !== CSRF || !job) { ch.send("failed", "That deploy is no longer available. Refresh the page and try again."); return ch.end(); }
  // A (re)connecting watcher cancels any pending abandonment timer (below).
  clearTimeout(job.reconnectGrace);
  job.reconnectGrace = null;
  for (const e of job.events) ch.send(e.event, e.data);
  if (job.done) return ch.end();
  job.subs.add(ch);
  res.on("close", () => {
    job.subs.delete(ch);
    // If the person closes the tab on the approval screen, don't pin the single deploy slot for the
    // full 10-minute approval window. When the last watcher leaves an awaiting-approval job, give a
    // short grace for a transient reconnect, then treat it as declined so the slot frees.
    if (!job.done && job.phase === "awaiting-approval" && job.subs.size === 0 && typeof job.decide === "function") {
      clearTimeout(job.reconnectGrace);
      job.reconnectGrace = setTimeout(() => { if (job.decide) job.decide("decline"); }, GRACE_MS);
    }
  });
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  // The health probe is always open (no auth), so systemd/Caddy can check liveness.
  if (u.pathname === "/healthz") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ ok: true })); }
  // The auth RELAY endpoints (/auth/relay/*, and the relay branch of the shared Google callback)
  // are PUBLIC — they serve OTHER deployed apps' users, not portal users — so they run before the
  // portal's own sign-in gate. No-op unless the relay is configured.
  try {
    if (await gate.handleRelay(req, res, u)) return;
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    return res.end("relay error");
  }
  // The front door. When Google sign-in is configured, this handles /auth/google*, /signin, and
  // redirects anyone not signed in; it returns true when it fully handled the request. When it is
  // not configured it is a no-op (Caddy basic_auth is the gate) and returns false.
  try {
    if (await gate.handle(req, res, u)) return;
  } catch (e) {
    res.writeHead(302, { location: "/signin?reason=error" });
    return res.end();
  }
  // The owner's groups screen and its endpoints, now that the gate has confirmed a signed-in owner.
  // Wrapped so a store error (e.g. a mis-provisioned/unwritable store file) returns a plain 500
  // instead of an unhandled rejection that would take the whole portal AND the relay down.
  if (u.pathname === "/groups" || u.pathname.startsWith("/api/groups/")) {
    try {
      if (await groupsAdmin.handle(req, res, u)) return;
    } catch (e) {
      console.error("[portal] groups handler error:", e && e.message);
      if (!res.headersSent) { res.writeHead(500, { "content-type": "text/plain" }); res.end("Something went wrong. Please try again."); }
      return;
    }
  }
  if (u.pathname === "/api/deploy" && req.method === "POST") return startDeploy(req, res);
  if (u.pathname === "/api/deploy/decide" && req.method === "POST") return decideDeploy(req, res);
  if (u.pathname === "/api/deploy/stream") return streamDeploy(req, res, u.searchParams);
  if (u.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(homePage()); }
  // Safety net: never write a second response header if a handler already answered. A handler that
  // responded but returned falsy would otherwise crash the whole process here (ERR_HTTP_HEADERS_SENT).
  if (res.headersSent) return;
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});
server.listen(PORT, HOST, () => console.log(`[portal] listening on http://${HOST}:${PORT}`));
