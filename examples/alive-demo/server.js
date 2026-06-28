// alive-demo — a tiny app whose whole job is to prove, charmingly, that it is really
// running on your own machine. No database, no build, no dependencies: just Node.
// It self-discovers its own public address from the request, and shows its live uptime
// so you can see it is a real, running process and not a cached file.
const http = require("node:http");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const STARTED = Date.now();

function page(host) {
  const slug = (host || "this-app").split(".")[0];
  const url = "https://" + (host || "your-machine");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${slug} is alive</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #faf6ef; color: #2b2620;
    font: 17px/1.6 ui-rounded, "SF Pro Rounded", system-ui, -apple-system, sans-serif;
    padding: 24px;
  }
  .card {
    background: #fffdf8; border: 1px solid #ece3d2; border-radius: 22px;
    box-shadow: 0 18px 50px -28px rgba(80,60,20,.45);
    max-width: 560px; width: 100%; padding: 40px 36px; text-align: center;
  }
  .wave { font-size: 56px; line-height: 1; margin-bottom: 8px; animation: wave 2.4s ease-in-out infinite; display: inline-block; transform-origin: 70% 70%; }
  @keyframes wave { 0%,60%,100%{transform:rotate(0)} 15%{transform:rotate(16deg)} 30%{transform:rotate(-8deg)} 45%{transform:rotate(14deg)} }
  h1 { font-size: 30px; margin: 6px 0 2px; letter-spacing: -.01em; }
  .lead { font-size: 19px; color: #5b5346; margin: 0 0 26px; }
  .addr { display: inline-block; font: 15px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    background: #f3ecdd; border: 1px solid #e7dcc6; border-radius: 999px; padding: 7px 14px; color: #6b5b32; }
  .facts { margin: 26px 0 0; display: grid; gap: 12px; text-align: left; }
  .fact { display: flex; align-items: baseline; gap: 12px; padding: 12px 16px; background: #faf5ec; border-radius: 14px; }
  .fact b { font-size: 14px; text-transform: uppercase; letter-spacing: .06em; color: #9a8c6f; min-width: 96px; }
  .fact span { font-size: 17px; }
  #uptime { font-variant-numeric: tabular-nums; }
  .foot { margin-top: 26px; font-size: 14px; color: #9a8c6f; }
  .dot { display:inline-block; width:9px; height:9px; border-radius:50%; background:#4caf72; margin-right:7px; box-shadow:0 0 0 0 rgba(76,175,114,.6); animation:pulse 1.8s infinite; }
  @keyframes pulse { 0%{box-shadow:0 0 0 0 rgba(76,175,114,.5)} 70%{box-shadow:0 0 0 10px rgba(76,175,114,0)} 100%{box-shadow:0 0 0 0 rgba(76,175,114,0)} }
</style>
</head>
<body>
  <div class="card">
    <div class="wave">👋</div>
    <h1>I'm alive.</h1>
    <p class="lead">Hello, I'm <strong>${slug}</strong>.</p>
    <span class="addr">${url}</span>
    <div class="facts">
      <div class="fact"><b>Home</b><span>your own Google&nbsp;Cloud, a machine you own</span></div>
      <div class="fact"><b>Status</b><span><span class="dot"></span>running, just for you</span></div>
      <div class="fact"><b>Awake&nbsp;for</b><span id="uptime">a moment</span></div>
    </div>
    <p class="foot">This page is rendered live by a real process on your VM, not a saved file.<br/>Watch the timer; that's me, actually running.</p>
  </div>
<script>
  const started = ${STARTED};
  function fmt(ms){
    const s = Math.floor(ms/1000);
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), ss = s%60;
    const p = [];
    if (h) p.push(h+(h===1?' hour':' hours'));
    if (h||m) p.push(m+(m===1?' minute':' minutes'));
    p.push(ss+(ss===1?' second':' seconds'));
    return p.join(', ');
  }
  const el = document.getElementById('uptime');
  setInterval(()=>{ el.textContent = fmt(Date.now()-started); }, 1000);
  el.textContent = fmt(Date.now()-started);
</script>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  // A tiny health endpoint so the platform can confirm the process is truly up.
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, uptimeSeconds: Math.floor((Date.now() - STARTED) / 1000) }));
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page(req.headers.host));
});

server.listen(PORT, HOST, () => {
  console.log(`[alive-demo] listening on http://${HOST}:${PORT}`);
});
