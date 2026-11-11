import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

const origin = process.env.WORKSPACE_ORIGIN;
if (origin !== "https://william.biggers.family") throw Error("Explicit verified deployment origin required; this creates and deletes one fictional fixture account.");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage(); page.setDefaultTimeout(30000);
const name = `Executor cloud fixture ${Date.now()}`;
const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
let cleanup = false;
try {
  await page.goto(`${origin}/job-search/workspace`, { waitUntil: "networkidle" });
  await page.getByLabel("Workspace name (a nickname is fine)").fill(name);
  await page.locator("#consent").check();
  await page.getByRole("button", { name: "Create with a passkey", exact: true }).click();
  await page.getByRole("heading", { name: "Save your recovery code now", exact: true }).waitFor();
  await page.getByRole("button", { name: "I saved it safely", exact: true }).click(); // Fictional fixture credential; never read or export the recovery value.
  const api = (path, data) => context.request.post(`${origin}/job-search/api/${path}`, { headers: { Origin: origin }, data, timeout: 110000 });
  const response = await api("executor/fixture-check", { confirmation: "FICTIONAL INFRASTRUCTURE TEST ONLY" });
  const result = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(result));
  assert.equal(result.status, "fixture_verified", JSON.stringify(result));
  assert.equal(result.receipt.synthetic, true);
  assert.match(result.receipt.id, /^fixture-[a-f0-9]{64}$/);
  assert.match(result.receipt.response_digest, /^[a-f0-9]{64}$/);
  const state = await context.request.get(`${origin}/job-search/api/state`);
  const body = await state.json();
  assert.equal(body.records.length, 0); assert.equal(body.reviews.length, 0); assert.equal(body.handoffs.length, 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const removed = await api("delete", { confirmation: "DELETE MY WORKSPACE" });
  assert.equal(removed.status(), 200); cleanup = true;
  assert.equal((await context.request.get(`${origin}/job-search/api/state`)).status(), 401);
  const evidence = { origin, checkedAt: new Date().toISOString(), fixtureOnly: true, fixtureName: name, actualEmployerSubmissions: 0, syntheticReceipt: result.receipt, fixtureAccountDeleted: cleanup };
  await mkdir("test-results", { recursive: true }); await writeFile("test-results/executor-cloud.json", JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (!cleanup) await context.request.post(`${origin}/job-search/api/delete`, { headers: { Origin: origin }, data: { confirmation: "DELETE MY WORKSPACE" }, timeout: 30000 }).catch(() => {});
  await browser.close();
}
