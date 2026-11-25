import assert from "node:assert/strict";
import { chromium } from "playwright";
import { build } from "esbuild";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { inspectGreenhouse } from "../src/employer-greenhouse.ts";
import { buildApplicationPackage, packageInputSchema } from "../src/application-package.ts";

const origin = "https://owned-workspace.example.test";
const jobId = crypto.randomUUID(), draftId = crypto.randomUUID(), profileId = crypto.randomUUID();
const destination = "https://job-boards.greenhouse.io/fictionalcompany/jobs/123456";
const q = (label, name, required = true, type = "input_text") => ({ label, required, fields: [{ name, type, values: [] }] });
const result = await inspectGreenhouse(destination, async () => Response.json({ id: 123456, internal_job_id: 999, absolute_url: destination, title: "Fictional writer", company_name: "Fictional company", location: { name: "Unknown" }, content: "Fictional job", updated_at: new Date().toISOString(), questions: [q("First Name", "first_name"), q("Last Name", "last_name"), q("Email", "email"), q("Resume/CV", "resume", true, "input_file"), q("Cover Letter", "cover_letter", false, "input_file"), q("Website", "question_123", false), q("Work authorization", "question_456")], data_compliance: [] }));
assert.ok(result.inspection);
const inspection = result.inspection;
const content = "FICTIONAL CANDIDATE — exact document bytes\nNo real application.";
const snapshot = { job_id: jobId, job_revision: 1, draft_id: draftId, draft_revision: 1, profile_id: profileId, profile_revision: 1, destination, draft_type: "resume", content, payload_digest: "a".repeat(64) };
const draft = { id: draftId, job_id: jobId, kind: "draft", revision: 1, data: { type: "resume", content }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
const bundled = await build({ stdin: { contents: `import {mountPackageReview} from './src/web/package-review.ts'; const {inspection,jobId,draft}=window.fixture; const api=async(path,method='GET',body)=>{const r=await fetch('/api/'+path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const value=await r.json();if(!r.ok)throw Error(value.error);return value;}; const busy=async(action)=>{try{await action();}catch(error){document.querySelector('#error').textContent=error.message;}}; mountPackageReview(document.querySelector('#container'),jobId,inspection,[draft],api,busy,async()=>{document.querySelector('#refreshed').textContent='Approved package stored; execution disabled';});`, resolveDir: process.cwd(), loader: "js" }, bundle: true, write: false, format: "iife", target: "es2022" });
const css = await readFile("public/job-search/workspace/style.css", "utf8");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 1000 } });
const page = await context.newPage();
let approved = null, previews = 0, leaked = 0, hold = false, release;
let previewGate = Promise.resolve();
const results = [];
try {
  await page.addInitScript(data => { window.fixture = data; }, { inspection, jobId, draft });
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { leaked++; await route.abort(); return; }
    if (url.pathname === "/") { await route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${css}</style></head><body><main><div id="error" role="status"></div><p id="refreshed"></p><label for="draft-${draftId}">Saved draft editor</label><textarea id="draft-${draftId}"></textarea><div id="container"></div></main></body></html>` }); return; }
    const body = request.postDataJSON();
    if (url.pathname === "/api/packages/preview") {
      previews++;
      if (hold) await previewGate;
      try { const exact = await buildApplicationPackage(packageInputSchema.parse(body), inspection, [snapshot]); await route.fulfill({ json: { package: exact } }); }
      catch (error) { await route.fulfill({ status: 409, json: { error: error.message } }); }
      return;
    }
    if (url.pathname === "/api/packages/approve") {
      approved = body; const exact = await buildApplicationPackage(packageInputSchema.parse(body.input), inspection, [snapshot]);
      assert.equal(body.expected_digest, exact.package_digest); assert.equal(body.confirmation, "APPROVE EXACT PREPARATION PACKAGE");
      await route.fulfill({ json: { id: crypto.randomUUID(), execution_enabled: false } }); return;
    }
    leaked++; await route.abort();
  });
  await page.goto(origin); await page.addScriptTag({ content: bundled.outputFiles[0].text });
  await page.locator(`#draft-${draftId}`).fill(content);
  assert.equal(await page.locator('#package-choice-6 option[value="answer"]').count(), 0);
  assert.equal(await page.locator('#package-choice-6 option[value="skip"]').count(), 0);
  await page.getByRole("button", { name: "Preview exact package", exact: true }).click();
  await page.getByText("Choose an explicit decision for First Name.", { exact: true }).waitFor();
  assert.equal(previews, 0); results.push("Every question requires an explicit decision; required sensitive questions cannot be answered or skipped by the package UI");
  for (const [index, value] of [[0, "Fictional"], [1, "Candidate"], [2, "fixture@example.invalid"]]) { await page.locator(`#package-choice-${index}`).selectOption("answer"); await page.locator(`#package-answer-${index}`).fill(value); }
  for (const [index, value] of [[3, "document:0"], [4, "skip"], [5, "skip"], [6, "defer"]]) await page.locator(`#package-choice-${index}`).selectOption(value);
  await page.locator(`#draft-${draftId}`).fill("Unsaved change");
  await page.getByRole("button", { name: "Preview exact package", exact: true }).click();
  await page.getByText("Save or discard unsaved document edits before reviewing an exact package.", { exact: true }).waitFor();
  assert.equal(previews, 0); await page.locator(`#draft-${draftId}`).fill(content);
  await page.getByRole("button", { name: "Preview exact package", exact: true }).click();
  await page.getByRole("heading", { name: "Exact preparation package", exact: true }).waitFor();
  assert.equal(await page.locator("[data-package-approve]").isDisabled(), true);
  assert.equal(await page.locator("pre").innerText(), content);
  assert.equal(approved, null); results.push("Unsaved editor changes are denied; exact saved document, answers, skips, deferred steps and disabled execution are shown before approval");
  await page.locator("[data-package-consent]").check();
  await page.locator("#package-answer-0").fill("Edited fictional name");
  assert.equal(await page.locator("[data-package-approve]").count(), 0);
  hold = true;
  previewGate = new Promise(resolve => { release = resolve; });
  const pending = page.waitForRequest(request => request.url().endsWith("/api/packages/preview"));
  await page.getByRole("button", { name: "Preview exact package", exact: true }).click(); await pending;
  await page.locator("#package-answer-0").fill("Final fictional name");
  hold = false; release();
  await page.waitForLoadState("networkidle");
  assert.equal(await page.locator("[data-package-approve]").count(), 0); results.push("Changing answers invalidates a displayed review and discards a delayed stale preview response");
  await page.getByRole("button", { name: "Preview exact package", exact: true }).click();
  await page.getByRole("heading", { name: "Exact preparation package", exact: true }).waitFor();
  for (const width of [360, 390, 1440]) { await page.setViewportSize({ width, height: 1000 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); }
  await page.locator("[data-package-consent]").check(); await page.getByRole("button", { name: "Approve exact preparation package", exact: true }).click();
  await page.getByText("Approved package stored; execution disabled", { exact: true }).waitFor();
  assert.equal(approved.input.answers[0].value, "Final fictional name"); assert.deepEqual(approved.input.deferred, ["application:6"]);
  assert.equal(leaked, 0); results.push("Explicit candidate confirmation sends only the displayed package/digest to the owned workspace, fits mobile, and never contacts an employer");
  await mkdir("test-results", { recursive: true }); await writeFile("test-results/package-ui.json", JSON.stringify({ results, fictionalDataOnly: true, employerRequests: leaked }, null, 2));
  console.log(JSON.stringify({ results, fictionalDataOnly: true, employerRequests: leaked }, null, 2));
} finally { await browser.close(); }
