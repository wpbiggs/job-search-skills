import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

const origin = process.env.WORKSPACE_ORIGIN;
if (origin !== "https://william.biggers.family" || process.env.CHECK_FICTIONAL_TAKEOVER !== "1") throw Error("Explicit owned deployment and fictional takeover check required. One browser unit; no employer or candidate data.");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage(); page.setDefaultTimeout(30000);
const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
const api = (body) => context.request.post(`${origin}/job-search/api/executor/takeover`, { headers: { Origin: origin }, data: body, timeout: 60000 });
let deleted = false, id, socket;
try {
  await page.goto(`${origin}/job-search/workspace`, { waitUntil: "networkidle" });
  await page.getByLabel("Workspace name (a nickname is fine)").fill(`Takeover cloud fixture ${Date.now()}`);
  await page.locator("#consent").check();
  await page.getByRole("button", { name: "Create with a passkey", exact: true }).click();
  await page.getByRole("heading", { name: "Save your recovery code now", exact: true }).waitFor();
  await page.getByRole("button", { name: "I saved it safely", exact: true }).click();
  const start = await api({ action: "start_fixture", confirmation: "FICTIONAL TAKEOVER ONLY — NO PERSONAL DATA" });
  assert.equal(start.status(), 200, "Fictional start failed; no automatic retry allowed");
  const started = await start.json(); id = started.takeover.id;
  assert.equal(started.takeover.phase, "paused"); assert.equal(started.takeover.execution_enabled, false);
  assert.equal(JSON.stringify(started).includes("session_id"), false);
  const status = await api({ action: "status" }); assert.equal((await status.json()).takeover.id, id);
  const view = await api({ action: "view", id, confirmation: "OPEN PRIVATE FICTIONAL CONTROL" });
  assert.equal(view.status(), 200, "Private view capability unavailable");
  const ticket = await view.json();
  // Bearer capability remains in memory. Never print it, record network traces, or save screenshots.
  const frontend = new URL(ticket.live_view_url);
  assert.ok(frontend.protocol === "https:" && frontend.hostname === "live.browser.run", "Unexpected control UI origin");
  const endpoint = frontend.searchParams.get("wss");
  assert.ok(endpoint, "Provider control URL did not contain the expected socket transport");
  const wsUrl = new URL(endpoint.startsWith("wss://") ? endpoint : `wss://${endpoint}`);
  assert.ok(wsUrl.protocol === "wss:" && wsUrl.hostname === "api.cloudflare.com", "Unexpected control socket origin");
  socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Private socket did not connect")), 15000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(Error("Private socket connection failed")); }, { once: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Connected viewer did not answer a read-only protocol request")), 10000);
    const listener = event => {
      let data; try { data = JSON.parse(String(event.data)); } catch { return; }
      if (data.id !== 1) return;
      clearTimeout(timer); socket.removeEventListener("message", listener);
      if (data.result?.frameTree) resolve(); else reject(Error("Viewer read-only protocol request failed"));
    };
    socket.addEventListener("message", listener);
    socket.send(JSON.stringify({ id: 1, method: "Page.getFrameTree" }));
  });
  assert.equal(socket.readyState, WebSocket.OPEN, "Viewer must still be connected before revocation");
  const closedSocket = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Established viewer was not closed after revocation")), 15000);
    socket.addEventListener("close", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  void closedSocket.catch(() => {}); // Cleanup failures must not become unhandled capability-bearing errors.
  const cancelled = await api({ action: "cancel", id });
  assert.equal(cancelled.status(), 200);
  assert.equal((await cancelled.json()).takeover.phase, "closed", "Browser revocation must be confirmed, not merely requested");
  await closedSocket;
  const oldLink = await api({ action: "view", id, confirmation: "OPEN PRIVATE FICTIONAL CONTROL" });
  assert.notEqual(oldLink.status(), 200, "Cancelled generation cannot mint another link");
  assert.equal((await (await api({ action: "status" })).json()).takeover, null);
  const exported = await (await context.request.get(`${origin}/job-search/api/export`)).text();
  assert.equal(exported.includes("live.browser.run"), false); assert.equal(exported.includes("session_id"), false);
  const remove = await context.request.post(`${origin}/job-search/api/delete`, { headers: { Origin: origin }, data: { confirmation: "DELETE MY WORKSPACE" } });
  assert.equal(remove.status(), 200); deleted = true;
  const evidence = { checkedAt: new Date().toISOString(), origin, fictionalOnly: true, employerRequests: 0, applicantDataEntered: false, structuredPauseVerified: true, establishedViewerClosedOnCancel: true, staleGenerationDenied: true, controlCapabilitiesExcludedFromExport: true, fixtureAccountDeleted: true, actualApplicationsSubmitted: 0 };
  await mkdir("test-results", { recursive: true }); await writeFile("test-results/takeover-deployed.json", JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  socket?.close();
  if (id) await api({ action: "cancel", id }).catch(() => undefined);
  if (!deleted) {
    const cleanup = await context.request.post(`${origin}/job-search/api/delete`, { headers: { Origin: origin }, data: { confirmation: "DELETE MY WORKSPACE" } }).catch(() => undefined);
    if (cleanup?.status() !== 200) console.error("Fictional takeover cleanup not confirmed. Check status/lease metadata before any new run.");
  }
  await browser.close();
}
