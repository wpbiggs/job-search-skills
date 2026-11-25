import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { greenhouseTarget } from "../src/employer-greenhouse.ts";
import { acceptsOrdinaryAnswer } from "../src/application-package.ts";

const origin = process.env.WORKSPACE_ORIGIN;
const destination = process.env.GREENHOUSE_JOB_URL;
const checkPackage = process.env.CHECK_PACKAGE_FIXTURE === "1";
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
  let fixtureProfile, fixtureDraft;
  if (checkPackage) {
    const job = (await saved.json()).record;
    const profile = await api("records", { kind: "profile", expected_revision: 0, data: { goals: "Fictional package test only", preferences: "", constraints: "No real candidate or employer disclosure", evidence: [{ id: "fixture-writing", claim: "Fictional writing", source: "Owned infrastructure fixture", confirmed: true }] } });
    assert.equal(profile.status(), 200); fixtureProfile = (await profile.json()).record;
    const draft = await api("records", { kind: "draft", job_id: job.id, expected_revision: 0, data: { type: "resume", content: "FICTIONAL CANDIDATE — exact-package infrastructure test only. Never send this to an employer.", evidence_ids: ["fixture-writing"], unresolved_claims: "" } });
    assert.equal(draft.status(), 200); fixtureDraft = (await draft.json()).record;
  }
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
  let packageDigest;
  if (checkPackage) {
    const contact = { first_name: "Fictional", last_name: "Candidate", email: "fixture@example.invalid", phone: "+1 202 555 0100" };
    let resumeSelected = false;
    for (const [index, question] of result.inspection.questions.entries()) {
      const field = question.alternatives[0].name;
      if (acceptsOrdinaryAnswer(question) && Object.hasOwn(contact, field)) {
        await page.locator(`#package-choice-${index}`).selectOption("answer");
        await page.locator(`#package-answer-${index}`).fill(contact[field]);
      } else if (question.handling === "document" && question.alternatives.some(field => field.name === "resume") && !resumeSelected) {
        await page.locator(`#package-choice-${index}`).selectOption("document:0"); resumeSelected = true;
      } else await page.locator(`#package-choice-${index}`).selectOption(!question.required && question.handling !== "unsupported" ? "skip" : "defer");
    }
    assert.equal(resumeSelected, true, "This explicit read-only fixture requires a supported résumé question");
    await page.getByRole("button", { name: "Preview exact package", exact: true }).click();
    await page.getByRole("heading", { name: "Exact preparation package", exact: true }).waitFor();
    assert.equal(await page.locator("[data-package-approve]").isDisabled(), true);
    await page.locator("[data-package-consent]").check();
    const approvalResponse = page.waitForResponse(response => response.url().endsWith("/job-search/api/packages/approve"));
    await page.getByRole("button", { name: "Approve exact preparation package", exact: true }).click();
    const approved = await approvalResponse; assert.equal(approved.status(), 200, await approved.text());
    const approvedBody = await approved.json(); assert.equal(approvedBody.execution_enabled, false); packageDigest = approvedBody.digest;
    await page.getByText("Preparation package: approved — not submitted", { exact: true }).waitFor();
    const exact = await (await context.request.get(`${origin}/job-search/api/packages/${approvedBody.id}`)).json();
    assert.equal(exact.package.documents[0].content, fixtureDraft.data.content);
    assert.equal(exact.package.package_digest, approvedBody.digest);
    assert.equal(exact.package.execution_enabled, false);
    await page.getByRole("button", { name: "Applications", exact: true }).click();
    await page.getByText("Exact package approved — execution pending", { exact: true }).waitFor();
    const changed = await api("records", { kind: "profile", id: fixtureProfile.id, expected_revision: fixtureProfile.revision, data: fixtureProfile.data });
    assert.equal(changed.status(), 200);
    const stale = await (await context.request.get(`${origin}/job-search/api/packages/${approvedBody.id}`)).json(); assert.equal(stale.status, "stale");
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Public preflight must fit a phone");
  const state = await (await context.request.get(`${origin}/job-search/api/state`)).json();
  assert.equal(state.records.length, checkPackage ? 3 : 1); assert.equal(state.reviews.length, 0); assert.equal(state.handoffs.length, 0);
  const executor = await (await context.request.get(`${origin}/job-search/api/executor`)).json();
  assert.deepEqual(executor.intents, []);
  const removed = await api("delete", { confirmation: "DELETE MY WORKSPACE" });
  assert.equal(removed.status(), 200); deleted = true;
  assert.equal((await context.request.get(`${origin}/job-search/api/state`)).status(), 401);
  const evidence = { origin, checkedAt: new Date().toISOString(), fictionalWorkspaceOnly: true, publicDestination: destination, questionCount: result.inspection.questions.length, interventionCount: result.inspection.interventions.length, fingerprint: result.inspection.fingerprint, employerDataEntered: false, actualEmployerSubmissions: 0, fixtureAccountDeleted: deleted, fictionalPackageApprovalVerified: checkPackage, packageDigest };
  await mkdir("test-results", { recursive: true }); await writeFile("test-results/greenhouse-deployed.json", JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (!deleted) {
    const cleanup = await api("delete", { confirmation: "DELETE MY WORKSPACE" }).catch(() => undefined);
    if (cleanup?.status() !== 200) console.error("Fictional fixture cleanup not confirmed; check fixture metadata before any new run.");
  }
  await browser.close();
}
