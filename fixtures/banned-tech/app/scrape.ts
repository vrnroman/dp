// Drives a full headless Chromium through Puppeteer. The personal Vercel serverless model cannot
// host a bundled browser or a long-running process, so the policy's example banned list refuses it.
import puppeteer from "puppeteer";

export async function snapshot(url: string) {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto(url);
  const png = await page.screenshot();
  await browser.close();
  return png;
}
