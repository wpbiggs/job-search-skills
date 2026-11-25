import assert from "node:assert/strict";
import { chromium } from "playwright";
import { build } from "esbuild";

const bundled = await build({ stdin: { contents: `import {mountTakeover} from './src/web/takeover.ts'; const api=async(path,method,body)=>{const r=await fetch('/api/'+path,{method,body:JSON.stringify(body)});if(!r.ok)throw Error('Rejected');return r.json();};const busy=async(action)=>{try{await action();}catch{document.querySelector('#error').textContent='Stopped';}};mountTakeover(document.querySelector('main'),api,busy);`, resolveDir: process.cwd(), loader: "js" }, bundle: true, write: false, format: "iife", target: "es2022" });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext(); const page = await context.newPage();
let requests = 0, external = 0, current = null, delayView = false, release;
let gate = Promise.resolve();
const report = () => ({ id: "fictional-generation", phase: "paused", expires_at: new Date(Date.now() + 120000).toISOString(), reason: null, scope: "fictional-takeover-only", execution_enabled: false });
try {
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://owned-workspace.example.test") { external++; await route.abort(); return; }
    if (url.pathname === "/") { await route.fulfill({ contentType: "text/html", body: '<main><p id="error"></p></main>' }); return; }
    requests++;
    const body = JSON.parse(route.request().postData());
    if (body.action === "start_fixture") { assert.equal(body.confirmation, "FICTIONAL TAKEOVER ONLY — NO PERSONAL DATA"); current = report(); }
    if (body.action === "view") {
      assert.equal(body.confirmation, "OPEN PRIVATE FICTIONAL CONTROL");
      const saved = current; if (delayView) await gate;
      await route.fulfill({ json: { takeover: saved, live_view_url: "https://live.browser.run/ui/inspector?wss=FICTIONAL_TOKEN" } }); return;
    }
    if (body.action === "cancel" || body.action === "complete") { current = null; await route.fulfill({ json: { takeover: { ...report(), phase: "closed" } } }); return; }
    await route.fulfill({ json: { takeover: current } });
  });
  await page.goto("https://owned-workspace.example.test"); await page.addScriptTag({ content: bundled.outputFiles[0].text });
  assert.equal(requests, 0, "Job review must not eagerly invoke practice controllers");
  await page.locator("summary").click(); await page.getByText("No active practice session.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Start fictional takeover", exact: true }).isDisabled(), true);
  await page.locator("[data-practice-consent]").check(); await page.getByRole("button", { name: "Start fictional takeover", exact: true }).click();
  await page.getByRole("button", { name: "Get private fictional control link", exact: true }).waitFor();
  await page.getByRole("button", { name: "Get private fictional control link", exact: true }).click();
  const link = page.getByRole("link", { name: "Open fictional practice browser", exact: true }); await link.waitFor();
  assert.equal(await link.getAttribute("rel"), "noopener noreferrer"); assert.equal(await link.getAttribute("referrerpolicy"), "no-referrer");
  await page.getByRole("button", { name: "Check practice status", exact: true }).click(); await link.waitFor({ state: "detached" });
  delayView = true; gate = new Promise(resolve => { release = resolve; });
  const pending = page.waitForRequest(request => request.postData()?.includes('"action":"view"'));
  await page.getByRole("button", { name: "Get private fictional control link", exact: true }).click(); await pending;
  await page.getByRole("button", { name: "Cancel practice and close browser", exact: true }).click();
  await page.getByText(/Fictional practice: closed/).waitFor();
  release(); await page.waitForLoadState("networkidle"); assert.equal(await link.count(), 0, "Late capabilities must not reappear after cancellation");
  assert.equal(external, 0);
  console.log("Passed: lazy fictional controller UI, explicit scope consent, no-referrer control link, link removal before status/cancel, stale asynchronous capability denial and zero external requests.");
} finally { await browser.close(); }
