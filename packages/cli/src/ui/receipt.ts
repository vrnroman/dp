/**
 * The Deed. When a deploy finishes, the owner gets two things at once: a plain-English
 * receipt in the terminal, and a saved <slug>-card.html they can open, screenshot, or
 * text to a friend. The card carries a QR code, so a phone is one scan away from the live
 * app on its home screen. A URL is the floor; this is the ceiling.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import QRCode from "qrcode";
import qrcodeTerminal from "qrcode-terminal";

export interface ReceiptInfo {
  appName: string;
  slug: string;
  url: string;
  ownerEmail: string;
  peopleCount: number;
  hasDatabase: boolean;
  hasStorage: boolean;
}

export function printReceipt(info: ReceiptInfo): void {
  const lines: string[] = [];
  lines.push("");
  lines.push(`  Your app is live.`);
  lines.push("");
  lines.push(`  What you have    A working "${info.appName}" that anyone with the link can open.`);
  lines.push(`  Who can get in   ${info.peopleCount} ${info.peopleCount === 1 ? "person" : "people"} you let in. You can add more whenever you like.`);
  if (info.hasDatabase) {
    lines.push(`  Saved safely     Everything people add is kept in your own database.`);
  }
  if (info.hasStorage) {
    lines.push(`  Photos too       Images people upload are stored for you.`);
  }
  lines.push("");
  lines.push(`  Open it          ${info.url}`);
  lines.push("");
  process.stdout.write(lines.join("\n") + "\n");
}

export function printTerminalQR(url: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write("  Scan to put it on your phone:\n\n");
    qrcodeTerminal.generate(url, { small: true }, (qr: string) => {
      process.stdout.write(
        qr
          .split("\n")
          .map((l) => "  " + l)
          .join("\n") + "\n",
      );
      resolve();
    });
  });
}

export async function writeCard(appDir: string, info: ReceiptInfo): Promise<string> {
  const qrDataUrl = await QRCode.toDataURL(info.url, { margin: 1, width: 320 });
  const html = card(info, qrDataUrl);
  const path = join(appDir, `${info.slug}-card.html`);
  writeFileSync(path, html);
  return path;
}

function card(info: ReceiptInfo, qrDataUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(info.appName)} is live</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #fbf7f0; color: #2b2622;
    font-family: ui-rounded, "SF Pro Rounded", system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    padding: 24px;
  }
  .card {
    background: #fff; border: 1px solid #ece4d8; border-radius: 24px;
    padding: 32px; max-width: 380px; width: 100%; text-align: center;
    box-shadow: 0 12px 40px rgba(0,0,0,0.06);
  }
  .badge { display: inline-block; background: #eafaef; color: #1f8a4c; font-weight: 600;
    font-size: 13px; padding: 4px 12px; border-radius: 999px; }
  h1 { font-size: 28px; margin: 14px 0 4px; letter-spacing: -0.02em; }
  .sub { color: #8a8178; font-size: 14px; margin: 0 0 18px; }
  img.qr { width: 220px; height: 220px; image-rendering: pixelated; }
  .url { display: inline-block; margin: 14px 0 4px; word-break: break-all;
    color: #e0644b; font-weight: 600; text-decoration: none; }
  .steps { text-align: left; font-size: 13px; color: #6b635a; margin: 18px 0 0;
    border-top: 1px solid #ece4d8; padding-top: 16px; }
  .steps b { color: #2b2622; }
  .who { font-size: 13px; color: #8a8178; margin-top: 8px; }
</style>
</head>
<body>
  <div class="card">
    <span class="badge">Live now</span>
    <h1>${escapeHtml(info.appName)}</h1>
    <p class="sub">It is on the internet. Scan to add it to your phone.</p>
    <img class="qr" src="${qrDataUrl}" alt="QR code to open the app" />
    <div><a class="url" href="${escapeAttr(info.url)}">${escapeHtml(info.url)}</a></div>
    <p class="who">${info.peopleCount} ${info.peopleCount === 1 ? "person can" : "people can"} get in. You decide who.</p>
    <div class="steps">
      <b>Put it on your home screen</b><br/>
      On iPhone: open the link in Safari, tap Share, then "Add to Home Screen".<br/>
      On Android: open the link in Chrome, tap the menu, then "Install app".
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}
