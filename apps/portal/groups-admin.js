// The DP owner's "Groups & access" screen — the portal-owner-facing surface for the central
// groups store (SPEC-central-groups.md). It lets the one portal owner:
//   - make / rename / delete groups,
//   - add / remove people (by email) to a group,
//   - per registered app, map a group -> that app's declared roles,
//   - see the app registry and the "just arrived" people,
//   - and "try it as" someone: see exactly what an email would be able to do in an app, right now.
//
// It lives BEHIND the portal's own owner sign-in: server.js only routes here after gate.handle()
// has confirmed a signed-in, allowed owner, so every request is the owner. State-changing POSTs
// still carry the portal CSRF token (the page is same-origin behind the gate, but the token keeps
// a stray cross-origin form from acting with the owner's cookie). Zero dependencies; house style
// mirrors server.js (warm cream cards, plain English, the app's own "can" sentence, never "role").
const { randomBytes } = require("node:crypto");

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    // Cap the body, and RESOLVE on overflow: req.destroy() emits neither "end" nor "error", so
    // without this the promise (and the awaiting handler) would hang forever. An empty body then
    // fails the CSRF check and bounces cleanly.
    req.on("data", (d) => { b += d; if (b.length > 1e6) { req.destroy(); resolve({}); } });
    req.on("close", () => resolve({})); // belt-and-suspenders: settle if the socket closes early
    req.on("end", () => {
      const type = String(req.headers["content-type"] || "");
      if (type.includes("application/json")) {
        try { return resolve(JSON.parse(b || "{}")); } catch { return resolve({}); }
      }
      // urlencoded form post: collect repeated keys (e.g. role) into arrays.
      const params = new URLSearchParams(b);
      const out = {};
      for (const key of new Set([...params.keys()])) {
        const all = params.getAll(key);
        out[key] = all.length > 1 ? all : all[0];
      }
      resolve(out);
    });
    req.on("error", () => resolve({}));
  });
}

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; background:#faf6ef; color:#2b2620;
    font:17px/1.6 ui-rounded,"SF Pro Rounded",system-ui,-apple-system,sans-serif; padding:48px 20px; }
  .wrap { max-width:620px; margin:0 auto; }
  a { color:#9a7b32; }
  .top { display:flex; align-items:baseline; justify-content:space-between; gap:12px; }
  h1 { font-size:30px; letter-spacing:-.02em; margin:0 0 4px; }
  .tag { color:#8a8178; margin:0 0 22px; }
  .card { background:#fffdf8; border:1px solid #ece3d2; border-radius:20px; padding:22px 22px;
    box-shadow:0 16px 44px -30px rgba(80,60,20,.5); margin-bottom:16px; }
  .card h2 { font-size:19px; margin:0 0 4px; }
  .card h3 { font-size:17px; margin:0; }
  label.field { display:block; font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:#9a8c6f; margin:14px 0 6px; }
  input:not([type=checkbox]), select { width:100%; font-size:16px; padding:11px 13px; border:1px solid #e3d8c2; border-radius:12px;
    background:#fffefb; color:#2b2620; font-family:inherit; }
  input:not([type=checkbox]):focus, select:focus { outline:none; border-color:#cba96a; box-shadow:0 0 0 3px rgba(214,180,110,.25); }
  input[type=checkbox] { width:17px; height:17px; margin:0 9px 0 0; vertical-align:-3px; accent-color:#9a7b32; cursor:pointer; }
  .row { display:flex; gap:10px; }
  .row input, .row select { flex:1; }
  button { font-size:15px; font-weight:600; font-family:inherit; cursor:pointer; padding:11px 16px; border:none;
    border-radius:12px; background:#2b2620; color:#faf6ef; transition:transform .05s; white-space:nowrap; }
  button:hover { background:#3a342b; } button:active { transform:translateY(1px); }
  button.ghost { background:#f0e8d8; color:#5b5346; }
  button.ghost:hover { background:#e7ddc9; }
  .muted { color:#8a8178; font-size:14px; }
  .empty { color:#8a8178; font-size:15px; background:#f7f0e2; border-radius:12px; padding:14px 16px; }
  .item { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:9px 12px;
    border:1px solid #efe7d6; border-radius:12px; margin-bottom:8px; background:#faf6ef; }
  .item form { margin:0; }
  .group-head { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:6px; }
  .app-map { border-top:1px solid #efe7d6; margin-top:14px; padding-top:12px; }
  .app-map .can { display:block; margin-bottom:5px; }
  .app-map .can.dead { color:#b3a894; text-decoration:line-through; }
  .stale { color:#8a8178; font-size:13px; margin:2px 0 10px; }
  .pill { display:inline-block; font-size:12px; color:#6b6052; background:#f0e8d8; border-radius:999px; padding:2px 10px; margin:0 6px 6px 0; }
  .tryout .result { margin-top:12px; background:#f6efe2; border-radius:12px; padding:12px 14px; font-size:15px; min-height:22px; }
  .tryout .result .can { display:block; }
  hr.sep { border:none; border-top:1px solid #efe7d6; margin:16px 0; }
`;

function createGroupsAdmin({ store, csrf }) {
  const CSRF = csrf || randomBytes(16).toString("hex");

  // Both return true: the caller (server.js) does `if (await handle(...)) return;`, so EVERY branch
  // that writes a response must report it handled the request. Returning undefined here once let a
  // bad-CSRF POST fall through to a second writeHead (404) and crash the whole portal process.
  function redirect(res, to) {
    res.writeHead(302, { location: to || "/groups" });
    res.end();
    return true;
  }
  function json(res, code, obj) {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
    return true;
  }

  function page() {
    const groups = store.listGroups();
    const apps = store.listApps();
    const people = store.listPeople();

    const appOptions = apps.map((a) => `<option value="${esc(a.origin)}">${esc(a.origin)}</option>`).join("");

    // "Try it as" — the live resolver (idea: make the effect of a mapping instantly visible).
    const tryout = `
      <div class="card tryout">
        <h2>Try it as someone</h2>
        <p class="muted" style="margin-top:0">See exactly what a person can do in an app right now, before they ever sign in.</p>
        ${apps.length === 0
          ? `<p class="empty">No apps yet, so there is nothing to try. Deploy an app and it will show up here.</p>`
          : `<div class="row">
               <input id="tryEmail" type="email" placeholder="someone@email.com" autocomplete="off" />
               <select id="tryApp">${appOptions}</select>
               <button type="button" id="tryBtn">Check</button>
             </div>
             <div class="result" id="tryResult"></div>`}
      </div>`;

    const makeGroup = `
      <div class="card">
        <form class="row" method="POST" action="/api/groups/create">
          <input type="hidden" name="csrf" value="${CSRF}" />
          <input type="text" name="name" placeholder="name a group, e.g. Family" required />
          <button type="submit">Make a group</button>
        </form>
      </div>`;

    const groupCards = groups.length === 0
      ? `<div class="card"><p class="empty">No groups yet. Make one above, then drop people in and choose what they can do in each app.</p></div>`
      : groups.map((g) => {
          const members = store.membersOf(g.id);
          const membersHtml = members.length === 0
            ? `<p class="muted">Nobody in this group yet.</p>`
            : members.map((email) => `
                <div class="item">
                  <span>${esc(email)}</span>
                  <form method="POST" action="/api/groups/remove-member">
                    <input type="hidden" name="csrf" value="${CSRF}" />
                    <input type="hidden" name="groupId" value="${esc(g.id)}" />
                    <input type="hidden" name="email" value="${esc(email)}" />
                    <button class="ghost" type="submit">Take out</button>
                  </form>
                </div>`).join("");

          // Per registered app: which of that app's declared roles this group grants.
          const mappings = apps.length === 0
            ? `<p class="stale">No apps have been deployed yet, so there is nothing to grant. Deploy an app and it will appear here.</p>`
            : apps.map((app) => {
                const declared = app.declaredRoles || [];
                const granted = new Set(store.rolesForGroupInApp(app.origin, g.id));
                const declaredNames = new Set(declared.map((r) => r.name));
                // Visible fail-closed: if a past mapping named a role this app no longer declares,
                // show it struck through so the owner sees it grants nothing, and can clear it.
                const stale = [...granted].filter((r) => !declaredNames.has(r));
                const checkboxes = declared.map((r) => `
                    <label class="can">
                      <input type="checkbox" name="role" value="${esc(r.name)}" ${granted.has(r.name) ? "checked" : ""} />
                      ${esc(r.can || r.name)}
                    </label>`).join("");
                const staleHtml = stale.map((r) => `
                    <label class="can dead" title="This app no longer offers this. It grants nothing.">
                      <input type="checkbox" disabled /> ${esc(r)} (no longer offered)
                    </label>`).join("");
                return `
                  <form class="app-map" method="POST" action="/api/groups/set-roles">
                    <input type="hidden" name="csrf" value="${CSRF}" />
                    <input type="hidden" name="groupId" value="${esc(g.id)}" />
                    <input type="hidden" name="appOrigin" value="${esc(app.origin)}" />
                    <p class="muted" style="margin:0 0 6px">In <strong>${esc(app.origin)}</strong>, people in this group can:</p>
                    ${declared.length === 0 ? `<p class="stale">This app declared no roles.</p>` : checkboxes}
                    ${staleHtml}
                    <button class="ghost" type="submit" style="margin-top:8px">Save what they can do here</button>
                  </form>`;
              }).join("");

          return `
            <div class="card">
              <div class="group-head">
                <h3>${esc(g.name)}</h3>
                <form method="POST" action="/api/groups/delete">
                  <input type="hidden" name="csrf" value="${CSRF}" />
                  <input type="hidden" name="groupId" value="${esc(g.id)}" />
                  <button class="ghost" type="submit">Delete group</button>
                </form>
              </div>

              <div>${membersHtml}</div>
              <form class="row" method="POST" action="/api/groups/add-member" style="margin-top:8px">
                <input type="hidden" name="csrf" value="${CSRF}" />
                <input type="hidden" name="groupId" value="${esc(g.id)}" />
                <input type="email" name="email" placeholder="add someone by email…" required />
                <button type="submit">Add</button>
              </form>

              ${mappings}
              <p class="stale">Changes apply the next time each person signs in.</p>
            </div>`;
        }).join("");

    const appsCard = `
      <div class="card">
        <h2>Apps</h2>
        ${apps.length === 0
          ? `<p class="empty">No apps yet. As soon as you deploy one, it shows up here with what it lets people do.</p>`
          : apps.map((a) => `
              <div class="item" style="align-items:flex-start; flex-direction:column">
                <strong>${esc(a.origin)}</strong>
                <div style="margin-top:6px">
                  ${(a.declaredRoles || []).length === 0
                    ? `<span class="muted">Declared no roles.</span>`
                    : (a.declaredRoles || []).map((r) => `<span class="pill">${esc(r.can || r.name)}${a.defaultRole === r.name ? " · everyone" : ""}</span>`).join("")}
                </div>
              </div>`).join("")}
      </div>`;

    const peopleCard = people.length === 0
      ? ""
      : `<div class="card">
           <h2>Just arrived</h2>
           <p class="muted" style="margin-top:0">Everyone who has signed in to one of your apps, newest first.</p>
           ${people.map((p) => `<div class="item"><span>${p.name ? esc(p.name) + " · " : ""}${esc(p.email)}</span></div>`).join("")}
         </div>`;

    return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Groups &amp; access</title><style>${STYLE}</style></head><body><div class="wrap">
  <div class="top">
    <h1>Groups &amp; access</h1>
    <a href="/">Put an app online →</a>
  </div>
  <p class="tag">Make groups, drop people in, and choose what each group can do in each of your apps. People sign in with Google; you decide the rest.</p>
  ${tryout}
  ${makeGroup}
  ${groupCards}
  ${appsCard}
  ${peopleCard}
  <script>
    (function () {
      var btn = document.getElementById('tryBtn');
      if (!btn) return;
      var out = document.getElementById('tryResult');
      function run() {
        var email = document.getElementById('tryEmail').value.trim();
        var app = document.getElementById('tryApp').value;
        if (!email) { out.textContent = 'Type an email to check.'; return; }
        out.textContent = 'Checking…';
        fetch('/api/groups/preview', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: email, appOrigin: app, csrf: '${CSRF}' }) })
          .then(function (r) { return r.json(); })
          .then(function (res) {
            // Build the result with textContent, never innerHTML: a role's "can" sentence comes
            // from a deployed app's manifest (attacker-influenceable when the owner deploys someone
            // else's repo), so it must never be interpreted as HTML in the owner's session.
            out.textContent = '';
            if (res.error) { out.textContent = res.error; return; }
            var who = res.email || 'This person';
            if (!res.can || res.can.length === 0) {
              var m = document.createElement('span'); m.className = 'muted';
              m.textContent = who + ' can sign in, but can\\'t do anything special in this app yet.';
              out.appendChild(m); return;
            }
            var head = document.createElement('div');
            var b = document.createElement('strong'); b.textContent = who; head.appendChild(b);
            head.appendChild(document.createTextNode(' can:')); out.appendChild(head);
            res.can.forEach(function (c) {
              var s = document.createElement('span'); s.className = 'can'; s.textContent = '• ' + c;
              out.appendChild(s);
            });
          })
          .catch(function () { out.textContent = 'Could not check just now.'; });
      }
      btn.addEventListener('click', run);
      document.getElementById('tryEmail').addEventListener('keydown', function (e) { if (e.key === 'Enter') run(); });
    })();
  </script>
</div></body></html>`;
  }

  // The "can" sentences an email would hold in an app right now (the live tester).
  function preview(email, appOrigin) {
    const app = store.getApp(appOrigin);
    if (!app) return { error: "That app is not registered." };
    const roles = store.resolve(email, appOrigin);
    const canFor = (role) => {
      const spec = (app.declaredRoles || []).find((r) => r.name === role);
      return spec ? spec.can || role : role;
    };
    // Raw values: the client renders them with textContent (never innerHTML), so no escaping here.
    return { email, can: roles.map(canFor) };
  }

  async function handle(req, res, url) {
    const p = url.pathname;
    if (p === "/groups" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page());
      return true;
    }
    if (!p.startsWith("/api/groups/")) return false;

    const body = await readBody(req);
    if (body.csrf !== CSRF) {
      if (p === "/api/groups/preview") return json(res, 200, { error: "Your session expired. Refresh the page." });
      return redirect(res, "/groups");
    }

    switch (p) {
      case "/api/groups/create":
        store.createGroup(body.name);
        return redirect(res, "/groups");
      case "/api/groups/rename":
        store.renameGroup(body.groupId, body.name);
        return redirect(res, "/groups");
      case "/api/groups/delete":
        store.deleteGroup(body.groupId);
        return redirect(res, "/groups");
      case "/api/groups/add-member":
        store.addMember(body.groupId, body.email);
        return redirect(res, "/groups");
      case "/api/groups/remove-member":
        store.removeMember(body.groupId, body.email);
        return redirect(res, "/groups");
      case "/api/groups/set-roles": {
        const roles = Array.isArray(body.role) ? body.role : body.role ? [body.role] : [];
        store.setGroupRolesForApp(body.appOrigin, body.groupId, roles);
        return redirect(res, "/groups");
      }
      case "/api/groups/preview":
        return json(res, 200, preview(String(body.email || ""), String(body.appOrigin || "")));
      default:
        return false;
    }
  }

  return { handle, _page: page, _preview: preview, CSRF };
}

module.exports = { createGroupsAdmin };
