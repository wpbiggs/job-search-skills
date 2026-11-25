import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { greenhouseTarget } from "../src/employer-greenhouse.ts";

const origin = process.env.WORKSPACE_ORIGIN;
const destination = process.env.GREENHOUSE_JOB_URL;
if (origin !== "https://william.biggers.family" || !destination || !greenhouseTarget(destination)) throw Error("Explicit deployment origin and hosted GREENHOUSE_JOB_URL required. This performs one public metadata read, never an application.");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage(); page.setDefaultTimeout(30000);
const name = `Executor cloud fixture ${Date.now()}`;
const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
let deleted = false;
const api = (path, data) => context.request.post(`${origin}/job-search/api/${path}`, { headers: { Origin: origin }, data, timeout: 30000 });
try {
  await page.goto(`${origin}/job-search/workspace`, { waitUntil: "networkidle" });
  await page.getByLabel("Workspace name (a nickname is fine)").fill(name);
  await page.locator("#consent").check();
  await page.getByRole("button", { name: "Create with a passkey", exact: true }).click();
  await page.getByRole("heading", { name: "Save your recovery code now", exact: true }).waitFor();
  await page.getByRole("button", { name: "I saved it safely", exact: true }).click(); // Fictional account; never export/read recovery values.
  const saved = await api("records", { kind: "job", expected_revision: 0, data: { company: "Public metadata test fixture", title: "Public inspection only — not an application", source_url: destination, location: "Unknown", compensation: "Unknown", posting: "Fictional workspace record solely to test public job metadata routing. No applicant profile or materials.", checked_at: new Date().toISOString() } });
  assert.equal(saved.status(), 200);
  await page.getByRole("button", { name: "Jobs & drafts", exact: true }).click();
  const pending = page.waitForResponse(response => response.url().endsWith("/job-search/api/executor/inspect") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Inspect this employer form (no applicant data)", exact: true }).click();
  const response = await pending, result = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(result));
  assert.ok(result.inspection, JSON.stringify(result));
  assert.equal(result.inspection.adapter, "greenhouse-public-v1");
  assert.equal(result.inspection.live_submission_enabled, false);
  assert.equal(result.inspection.execution_supported, false);
  assert.equal(result.inspection.applicant_data_entered, false);
  assert.match(result.inspection.fingerprint, /^[a-f0-9]{64}$/);
  await page.getByRole("heading", { name: "Greenhouse job-specific preflight", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Public preflight must fit a phone");
  const state = await (await context.request.get(`${origin}/job-search/api/state`)).json();
  assert.equal(state.records.length, 1); assert.equal(state.reviews.length, 0); assert.equal(state.handoffs.length, 0);
  const executor = await (await context.request.get(`${origin}/job-search/api/executor`)).json();
  assert.deepEqual(executor.intents, []);
  const removed = await api("delete", { confirmation: "DELETE MY WORKSPACE" });
  assert.equal(removed.status(), 200); deleted = true;
  assert.equal((await context.request.get(`${origin}/job-search/api/state`)).status(), 401);
  const evidence = { origin, checkedAt: new Date().toISOString(), fictionalWorkspaceOnly: true, publicDestination: destination, questionCount: result.inspection.questions.length, interventionCount: result.inspection.interventions.length, fingerprint: result.inspection.fingerprint, applicantDataEntered: false, actualEmployerSubmissions: 0, fixtureAccountDeleted: deleted };
  await mkdir("test-results", { recursive: true }); await writeFile("test-results/greenhouse-deployed.json", JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (!deleted) {
    const cleanup = await api("delete", { confirmation: "DELETE MY WORKSPACE" }).catch(() => undefined);
    if (cleanup?.status() !== 200) console.error("Fictional fixture cleanup not confirmed; check fixture metadata before any new run.");
  }
  await browser.close();
}
