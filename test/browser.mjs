import assert from "node:assert/strict";
import { chromium } from "playwright";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";

const origin = process.env.WORKSPACE_ORIGIN ?? "http://localhost:8791";
const endpoint = `${origin}/job-search/mcp`;
const results = [];
const browser = await chromium.launch({ headless: true });
const clients = [], contexts = [];
const fixtureName = `Protocol test ${Date.now()}`;
const callbackServer = createHttpServer((_request, response) => { response.setHeader("Content-Type", "text/html"); response.end("<h1>Fixture callback</h1>"); });
await new Promise(resolve => callbackServer.listen(0, "127.0.0.1", resolve));
const callback = `http://127.0.0.1:${callbackServer.address().port}/job-search-fixture-callback`;
async function setupUser(name) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"] });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${origin}/job-search/workspace`, { waitUntil: "networkidle" });
  await page.getByLabel("Workspace name (a nickname is fine)").fill(name);
  await page.locator("#consent").check();
  await page.getByRole("button", { name: "Create with a passkey" }).click();
  await page.getByRole("heading", { name: "Save your recovery code now" }).waitFor({ timeout: 15000 });
  const recoveryCode = await page.locator("#new-recovery").innerText();
  assert.match(recoveryCode, /^[a-f0-9]{64}$/);
  await page.getByRole("button", { name: "I saved it safely" }).click();
  await page.getByRole("navigation", { name: "Workspace sections" }).waitFor();
  return { context, page, recoveryCode, errors };
}
async function webApi(page, path, method = "GET", body) {
  return page.evaluate(async ({ path, method, body }) => {
    const response = await fetch(`/job-search/api/${path}`, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }, { path, method, body });
}
async function connect(page, scope = "workspace:read workspace:write offline_access", deny = false) {
  // Exercise a real cross-origin redirect, not just a same-origin test callback.
  const registration = await fetch(`${origin}/job-search/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Job Search SDK fixture", redirect_uris: [callback], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) });
  assert.equal(registration.status, 201, await registration.clone().text());
  const registered = await registration.json();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(`${origin}/job-search/oauth/authorize`);
  for (const [key, value] of Object.entries({ client_id: registered.client_id, redirect_uri: callback, response_type: "code", scope, resource: endpoint, state: "fixture-state", code_challenge: challenge, code_challenge_method: "S256" })) url.searchParams.set(key, value);
  await page.goto(url.href, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /Connect Job Search SDK fixture/ }).waitFor();
  assert.match(await page.locator("main").innerText(), /Your AI provider may process/);
  await page.getByRole("button", { name: deny ? "Deny" : "Allow selected access", exact: true }).click();
  await page.waitForURL(`${callback}*`);
  const returned = new URL(page.url());
  assert.equal(returned.searchParams.get("state"), "fixture-state");
  if (deny) { assert.equal(returned.searchParams.get("error"), "access_denied"); await page.goto(`${origin}/job-search/workspace`); return null; }
  assert.ok(returned.searchParams.get("code"));
  const tokenResponse = await fetch(`${origin}/job-search/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: registered.client_id, code: returned.searchParams.get("code"), code_verifier: verifier, redirect_uri: callback, resource: endpoint }) });
  assert.equal(tokenResponse.status, 200, await tokenResponse.clone().text());
  const tokens = await tokenResponse.json();
  assert.ok(tokens.access_token);
  await page.goto(`${origin}/job-search/workspace`, { waitUntil: "networkidle" });
  const client = new Client({ name: "job-search-e2e", version: "1.0.0" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
  return { client, tokens, clientId: registered.client_id };
}
function decoded(result) { assert.equal(result.isError, undefined, result.content?.[0]?.text); return JSON.parse(result.content[0].text); }

try {
  const unauth = await fetch(endpoint);
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get("www-authenticate"), /resource_metadata/);
  const metadata = await fetch(`${origin}/.well-known/oauth-protected-resource/job-search/mcp`).then(response => response.json());
  assert.equal(metadata.resource, endpoint);
  const asMetadata = await fetch(`${origin}/.well-known/oauth-authorization-server/job-search`).then(response => response.json());
  assert.equal(asMetadata.issuer, `${origin}/job-search`);
  results.push("Unauthenticated challenge and path-aware OAuth discovery");

  const alice = await setupUser(`${fixtureName} A`);
  const other = await setupUser(`${fixtureName} B`);
  results.push("Two independently registered, user-verified discoverable passkeys");
  await connect(alice.page, "workspace:read", true);
  results.push("OAuth deny flow returns access_denied without creating access");
  const connection = await connect(alice.page);
  const readOnly = await connect(other.page, "workspace:read");
  assert.equal(readOnly.tokens.refresh_token, undefined, "Offline access must be explicitly approved before issuing refresh credentials");
  const tools = (await connection.client.listTools()).tools.map(tool => tool.name);
  assert.ok(tools.includes("capture_job") && tools.includes("save_profile") && tools.includes("save_draft"));
  assert.ok(!tools.some(name => /submit|approve|delete|send|browser|schedule/.test(name)));
  const readTools = (await readOnly.client.listTools()).tools.map(tool => tool.name);
  assert.ok(readTools.includes("get_record"));
  assert.ok(!readTools.includes("capture_job"));
  results.push("OAuth authorization-code + S256 PKCE with SDK initialization and scope-filtered tools");
  const legacy = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${connection.tokens.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legacy-fixture", version: "1.0.0" } } }) });
  assert.equal(legacy.status, 200);
  const legacyText = await legacy.text();
  const legacyMessage = legacy.headers.get("content-type")?.includes("application/json") ? JSON.parse(legacyText) : legacyText.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5).trim())).find(message => message.result);
  assert.ok(legacyMessage.result.serverInfo);
  results.push("Legacy Streamable HTTP initialization (2025-06-18) alongside modern SDK client");

  const profile = decoded(await connection.client.callTool({ name: "save_profile", arguments: { expected_revision: 0, data: { goals: "Operations work", preferences: "Remote", constraints: "Clarify travel", evidence: [{ id: "writing", claim: "Wrote process documentation", source: "Fictional candidate fixture", confirmed: true }] } } }));
  assert.equal(profile.data.evidence[0].confirmed, false);
  const job = decoded(await connection.client.callTool({ name: "capture_job", arguments: { expected_revision: 0, data: { company: "Fictional Cooperative", title: "Operations Analyst", source_url: "https://example.com/jobs/fixture-123", location: "Remote, eligibility unknown", compensation: "Unknown", posting: "Required: clear written communication. Preferred: SQL.", checked_at: new Date().toISOString(), stage: "shortlisted", requisition_id: "fixture-123" } } }));
  const assessment = decoded(await connection.client.callTool({ name: "save_assessment", arguments: { expected_revision: 0, job_id: job.id, data: { recommendation: "clarify", reasons: "Writing evidence is relevant but not yet candidate-confirmed.", constraints: "Travel policy unknown", gaps: "SQL not established", unknowns: "Salary and eligibility", requirements: [{ requirement: "Writing", posting_quote: "clear written communication", evidence_ids: ["writing"], support: "transferable" }] } } }));
  assert.equal(assessment.kind, "assessment");
  const draft = decoded(await connection.client.callTool({ name: "save_draft", arguments: { expected_revision: 0, job_id: job.id, data: { type: "resume", content: "FICTIONAL TEST DRAFT — wrote process documentation.", evidence_ids: ["writing"], unresolved_claims: "Candidate must verify experience." } } }));
  const websiteState = await webApi(alice.page, "state");
  assert.ok(websiteState.body.records.some(record => record.id === draft.id));
  const otherState = await webApi(other.page, "state");
  assert.equal(otherState.body.records.length, 0);
  const crossRead = await readOnly.client.callTool({ name: "get_record", arguments: { id: job.id } });
  assert.equal(crossRead.isError, true);
  results.push("MCP-created profile/job/assessment/draft visible on website; cross-user data denied");

  await alice.page.getByRole("button", { name: "Jobs & drafts", exact: true }).click();
  await alice.page.getByRole("heading", { name: "Operations Analyst", exact: true }).waitFor();
  assert.match(await alice.page.locator("main").innerText(), /SQL not established/);
  await alice.page.getByRole("heading", { name: "Candidate evidence behind this recommendation" }).waitFor();
  assert.match(await alice.page.locator("main").innerText(), /Source: Fictional candidate fixture/);
  assert.match(await alice.page.locator("main").innerText(), /Not yet confirmed/);
  const draftField = alice.page.locator(`#draft-${draft.id}`);
  await draftField.fill("Unsaved different content must not be approved");
  assert.equal(await alice.page.getByRole("button", { name: "Approve this version & destination" }).isDisabled(), true);
  await alice.page.getByText("Unsaved edits: save this version before approving it or recording a submission.", { exact: true }).waitFor();
  assert.equal((await webApi(alice.page, "state")).body.reviews.length, 0);
  await draftField.fill(draft.data.content);
  assert.equal(await alice.page.getByRole("button", { name: "Approve this version & destination" }).isEnabled(), true);
  results.push("Visible candidate evidence and confirmation state; unsaved draft edits cannot be approved");
  alice.page.once("dialog", dialog => dialog.accept());
  await alice.page.getByRole("button", { name: "Approve this version & destination" }).click();
  await alice.page.getByRole("button", { name: "I submitted this myself", exact: true }).waitFor();
  const edited = decoded(await connection.client.callTool({ name: "save_draft", arguments: { id: draft.id, expected_revision: 1, job_id: job.id, data: { ...draft.data, content: "FICTIONAL TEST DRAFT — updated after approval." } } }));
  assert.equal(edited.revision, 2);
  await alice.page.getByRole("button", { name: "Refresh records" }).click();
  await alice.page.getByText("approved — draft changed; review again").waitFor();
  assert.equal(await alice.page.getByRole("button", { name: "I submitted this myself", exact: true }).count(), 0);
  const tokenOnlyReview = await fetch(`${origin}/job-search/api/review`, { method: "POST", headers: { Authorization: `Bearer ${connection.tokens.access_token}`, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({}) });
  assert.equal(tokenOnlyReview.status, 401);
  const csrf = await alice.context.request.post(`${origin}/job-search/api/records`, { headers: { Origin: "https://untrusted.example" }, data: {} });
  assert.equal(csrf.status(), 403);
  const cookieOnlyMcp = await alice.context.request.post(endpoint, { data: { jsonrpc: "2.0", id: 80, method: "tools/list", params: {} } });
  assert.equal(cookieOnlyMcp.status(), 401);
  const badOrigin = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${connection.tokens.access_token}`, Origin: "https://untrusted.example", "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 81, method: "tools/list", params: {} }) });
  assert.equal(badOrigin.status, 403);
  results.push("Website-only approval, stale approval invalidation, MCP-token rejection on browser API, CSRF rejection");

  alice.page.once("dialog", dialog => dialog.accept());
  await alice.page.getByRole("button", { name: "Approve this version & destination" }).click();
  await alice.page.getByRole("button", { name: "I submitted this myself", exact: true }).waitFor();
  alice.page.once("dialog", dialog => dialog.accept("Fictional fixture receipt only; no real submission occurred"));
  await alice.page.getByRole("button", { name: "I submitted this myself", exact: true }).click();
  await alice.page.getByText("submitted — candidate-recorded", { exact: true }).waitFor();
  await alice.page.getByLabel("Known outcome", { exact: true }).selectOption("interviewing");
  await alice.page.getByLabel("What happened / next step", { exact: true }).fill("Fictional interview invitation fixture; no employer contact");
  await alice.page.getByRole("button", { name: "Record my outcome", exact: true }).click();
  await alice.page.getByText("Candidate-recorded: interviewing", { exact: true }).waitFor();
  const tracked = decoded(await connection.client.callTool({ name: "list_records", arguments: {} }));
  assert.equal(tracked.outcomes[0].status, "interviewing");
  assert.equal(tracked.reviews[0].action, "submitted");
  results.push("Candidate-only submission assertion and interview outcome appear to the connected assistant (fictional fixtures)");
  // Isolated preparation for the manual handoff flow. Never contact a real employer.
  const handoffProfile = (await webApi(other.page, "records", "POST", { kind: "profile", expected_revision: 0, data: { goals: "Fictional fixture only", preferences: "", constraints: "", evidence: [{ id: "fixture", claim: "Fictional writing", source: "Test fixture", confirmed: true }] } })).body.record;
  const handoffJob = (await webApi(other.page, "records", "POST", { kind: "job", expected_revision: 0, data: { company: "Fictional handoff fixture", title: "Fixture Writer", source_url: "https://example.com/jobs/handoff-fixture", location: "Unknown", compensation: "Unknown", posting: "Fictional writing role", checked_at: new Date().toISOString() } })).body.record;
  const handoffDraft = (await webApi(other.page, "records", "POST", { kind: "draft", job_id: handoffJob.id, expected_revision: 0, data: { type: "resume", content: "Fictional writing document — fixture only", evidence_ids: ["fixture"], unresolved_claims: "" } })).body.record;
  const preview = await webApi(other.page, "handoffs/preview", "POST", { job_id: handoffJob.id, draft_id: handoffDraft.id });
  assert.equal(preview.status, 200);
  const handoffInput = { job_id: handoffJob.id, draft_id: handoffDraft.id, expected_digest: preview.body.snapshot.payload_digest, confirmation: "APPROVE MANUAL HANDOFF" };
  const tokenHandoff = await fetch(`${origin}/job-search/api/handoffs/approve`, { method: "POST", headers: { Authorization: `Bearer ${readOnly.tokens.access_token}`, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(handoffInput) });
  assert.equal(tokenHandoff.status, 401);
  const handoffCsrf = await other.context.request.post(`${origin}/job-search/api/handoffs/approve`, { headers: { Origin: "https://untrusted.example" }, data: handoffInput });
  assert.equal(handoffCsrf.status(), 403);
  let releaseHandoff;
  const handoffGate = new Promise(resolve => { releaseHandoff = resolve; });
  const delayedHandoffs = async route => { await handoffGate; await route.continue(); };
  await other.page.route("**/job-search/api/handoffs", delayedHandoffs);
  const handoffRequest = other.page.waitForRequest(request => request.url().endsWith("/job-search/api/handoffs"));
  await other.page.getByRole("button", { name: "Jobs & drafts", exact: true }).click();
  await handoffRequest;
  assert.equal(await other.page.getByRole("button", { name: "Review saved handoff", exact: true }).isDisabled(), true, "Async controls must stay disabled until metadata and handlers are ready");
  releaseHandoff();
  await other.page.getByRole("button", { name: "Review saved handoff", exact: true }).click();
  await other.page.unroute("**/job-search/api/handoffs", delayedHandoffs);
  await other.page.getByRole("heading", { name: "Exact saved document", exact: true }).waitFor();
  await other.page.locator("#approve-handoff-check").check();
  await other.page.locator(`#draft-${handoffDraft.id}`).fill("Unsaved fictional change");
  await other.page.getByRole("button", { name: "Approve 15-minute manual handoff", exact: true }).click();
  await other.page.getByText("Save or discard your unsaved document edits before approving the saved version.", { exact: true }).waitFor();
  assert.deepEqual((await webApi(other.page, "handoffs")).body.handoffs, []);
  await other.page.locator(`#draft-${handoffDraft.id}`).fill(handoffDraft.data.content);
  await other.page.getByRole("button", { name: "Approve 15-minute manual handoff", exact: true }).click();
  await other.page.getByRole("button", { name: "Open one-use manual handoff", exact: true }).waitFor();
  const handoff = (await webApi(other.page, "handoffs")).body.handoffs[0];
  assert.equal((await webApi(alice.page, "handoffs/action", "POST", { id: handoff.id, action: "open" })).status, 404);
  assert.equal((await webApi(other.page, "handoffs/approve", "POST", handoffInput)).status, 409);
  // Two real concurrent HTTP claims on workerd/D1: only one may consume approval.
  const claims = await Promise.all([1, 2].map(() => webApi(other.page, "handoffs/action", "POST", { id: handoff.id, action: "open" })));
  assert.deepEqual(claims.map(result => result.status).sort(), [200, 409]);
  assert.equal((await webApi(other.page, "handoffs")).body.handoffs[0].status, "requires_user");
  // Candidate manually operates a synthetic ATS; all destination traffic intercepted locally.
  await other.context.route("https://example.com/jobs/handoff-fixture", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><head><title>Owned synthetic ATS fixture</title></head><body><h1>Fictional application — no employer contact</h1><label>Application text <textarea id="application"></textarea></label><button id="submit">Submit fictional application</button><p id="receipt"></p><script>document.querySelector("#submit").onclick=()=>{document.querySelector("#receipt").textContent="FICTIONAL-RECEIPT-123";document.querySelector("#submit").disabled=true;};</script></body></html>' }));
  const ats = await other.context.newPage();
  await ats.goto(handoff.destination);
  await ats.getByLabel("Application text").fill(handoffDraft.data.content);
  await ats.getByRole("button", { name: "Submit fictional application" }).click();
  const fictionalReceipt = await ats.locator("#receipt").innerText();
  assert.equal(fictionalReceipt, "FICTIONAL-RECEIPT-123");
  await ats.close();
  await other.page.getByRole("button", { name: "Refresh records", exact: true }).click();
  for (const width of [1440, 390]) {
    await other.page.setViewportSize({ width, height: 1000 });
    assert.equal(await other.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Handoffs must fit mobile screens");
  }
  await other.page.locator(`#receipt-${handoff.id}`).fill(fictionalReceipt);
  await other.page.locator(`#confirm-${handoff.id}`).check();
  await other.page.getByRole("button", { name: "Record my submission receipt", exact: true }).click();
  await other.page.getByText("Submitted — candidate-confirmed, not independently verified", { exact: true }).waitFor();
  const handoffTracked = decoded(await readOnly.client.callTool({ name: "list_records", arguments: {} }));
  assert.equal(handoffTracked.handoffs[0].receipt, fictionalReceipt);
  assert.equal(handoffTracked.handoffs[0].status, "submitted");
  const handoffExport = (await webApi(other.page, "export")).body;
  assert.equal(handoffExport.handoffs[0].attempt_id, (await webApi(other.page, "handoffs")).body.handoffs[0].attempt_id);
  for (const record of [handoffJob, handoffProfile]) assert.equal((await webApi(other.page, `records/${record.id}`, "DELETE", { confirmation: "DELETE RECORD", expected_revision: 1 })).status, 200);
  assert.deepEqual((await webApi(other.page, "handoffs")).body.handoffs, []);
  results.push("Exact saved handoff review, unsaved edit denial, token/CSRF/owner isolation, concurrent one-use D1 claims, synthetic ATS manual final click, mobile receipt confirmation, read-only MCP tracker/export and cascading cleanup");
  const executorState = await webApi(other.page, "executor");
  assert.equal(executorState.status, 200); assert.equal(executorState.body.live_submission_enabled, false);
  assert.deepEqual(executorState.body.intents, []);
  const executorTokenOnly = await fetch(`${origin}/job-search/api/executor/fixture-check`, { method: "POST", headers: { Authorization: `Bearer ${readOnly.tokens.access_token}`, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ confirmation: "FICTIONAL INFRASTRUCTURE TEST ONLY" }) });
  assert.equal(executorTokenOnly.status, 401);
  const executorCsrf = await other.context.request.post(`${origin}/job-search/api/executor/pause`, { headers: { Origin: "https://untrusted.example" }, data: { paused: true } });
  assert.equal(executorCsrf.status(), 403);
  assert.equal((await webApi(other.page, "executor/pause", "POST", { paused: true })).status, 200);
  assert.equal((await webApi(other.page, "executor/fixture-check", "POST", { confirmation: "FICTIONAL INFRASTRUCTURE TEST ONLY" })).status, 409);
  assert.equal((await webApi(other.page, "executor/pause", "POST", { paused: false })).status, 200);
  if (process.env.EXECUTOR_REMOTE_SMOKE === "1") {
    const synthetic = await webApi(other.page, "executor/fixture-check", "POST", { confirmation: "FICTIONAL INFRASTRUCTURE TEST ONLY" });
    assert.equal(synthetic.status, 200, JSON.stringify(synthetic.body));
    assert.equal(synthetic.body.status, "fixture_verified", JSON.stringify(synthetic.body));
    assert.equal(synthetic.body.receipt.synthetic, true);
    assert.match(synthetic.body.receipt.id, /^fixture-[a-f0-9]{64}$/);
    assert.equal((await webApi(other.page, "state")).body.reviews.length, 0);
    results.push("Actual private service binding and isolated Cloudflare browser completed an owned synthetic ATS test; synthetic receipt is not an employer submission");
  }
  results.push("Executor token/CSRF boundaries, candidate pause control, isolated state and locked live final submission");
  // Keep the expanded fixture suite within the real 120/minute production limit.
  // Do not disable the limiter in tests or widen it for a release.
  await new Promise(resolve => setTimeout(resolve, 61_000));
  decoded(await connection.client.callTool({ name: "save_profile", arguments: { id: profile.id, expected_revision: profile.revision, data: { ...profile.data, goals: "Updated fictional goals requiring reassessment" } } }));
  await alice.page.getByRole("button", { name: "Refresh records" }).click();
  await alice.page.getByText("Profile changed since this assessment — ask your assistant to reassess.", { exact: true }).waitFor();
  results.push("Assessment explicitly flags a newer profile instead of silently presenting old advice as current");

  for (const width of [1440, 390]) {
    await alice.page.setViewportSize({ width, height: 1000 });
    assert.equal(await alice.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await alice.page.getByRole("button", { name: "Activity & privacy", exact: true }).click();
  const exportResponse = await alice.context.request.get(`${origin}/job-search/api/export`);
  assert.equal(exportResponse.status(), 200);
  const exported = await exportResponse.json();
  assert.equal(exported.format, "job-search-workspace");
  assert.ok(exported.records.some(record => record.id === draft.id));
  assert.ok(exported.versions.some(version => version.record_id === draft.id && version.revision === 1));
  assert.doesNotMatch(JSON.stringify(exported), /recovery_hash|public_key|token_hash|access_token|refresh_token/);
  results.push("Desktop/mobile no overflow, portable export without security credentials");

  const tokenImport = await fetch(`${origin}/job-search/api/import/preview`, { method: "POST", headers: { Authorization: `Bearer ${connection.tokens.access_token}`, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ snapshot: exported }) });
  assert.equal(tokenImport.status, 401, "MCP tokens must not authorize candidate import");
  await other.page.getByRole("button", { name: "Activity & privacy", exact: true }).click();
  await other.page.getByRole("heading", { name: "Import preparation from an export", exact: true }).waitFor();
  let importRequests = 0;
  other.page.on("request", request => { if (request.url().includes("/api/import/")) importRequests++; });
  await other.page.locator("#import-file").setInputFiles({ name: "fictional-export.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(exported)) });
  await other.page.getByText(/bytes read locally/).waitFor();
  assert.equal(importRequests, 0, "Selecting a file must not upload it");
  assert.equal(await other.page.getByRole("button", { name: "Import reviewed preparation", exact: true }).isVisible(), false);
  await other.page.locator("#import-consent").check();
  await other.page.getByRole("button", { name: "Validate file in my workspace", exact: true }).click();
  await other.page.getByText(/Ready for your review:/).waitFor();
  assert.equal((await webApi(other.page, "state")).body.records.length, 0, "Preview must not store preparation");
  other.page.once("dialog", dialog => dialog.accept());
  await other.page.getByRole("button", { name: "Import reviewed preparation", exact: true }).click();
  await other.page.getByText("Import is unavailable while this workspace has records.", { exact: false }).waitFor();
  const importedState = (await webApi(other.page, "state")).body;
  assert.equal(importedState.records.length, exported.records.length);
  assert.deepEqual(importedState.reviews, []);
  assert.deepEqual(importedState.outcomes, []);
  assert.equal(importedState.usage.historical_versions, 0);
  const importedProfile = importedState.records.find(record => record.kind === "profile");
  const importedJob = importedState.records.find(record => record.kind === "job");
  const importedDraft = importedState.records.find(record => record.kind === "draft");
  assert.equal(importedProfile.data.evidence.every(item => item.confirmed === false), true);
  assert.equal(importedDraft.job_id, importedJob.id);
  assert.equal(importedState.records.some(record => exported.records.some(source => source.id === record.id)), false);
  const repeatedImport = await webApi(other.page, "import/preview", "POST", { snapshot: exported });
  assert.equal(repeatedImport.status, 409);
  const freshReview = await webApi(other.page, "review", "POST", { job_id: importedJob.id, review: { action: "approved", draft_id: importedDraft.id, draft_revision: 1, destination: importedJob.data.source_url, confirmation: "Cannot restore old authority" } });
  assert.equal(freshReview.status, 409);
  const importedMcp = decoded(await readOnly.client.callTool({ name: "get_record", arguments: { id: importedDraft.id } }));
  assert.equal(importedMcp.data.content, importedDraft.data.content);
  assert.equal((await readOnly.client.callTool({ name: "get_record", arguments: { id: draft.id } })).isError, true);
  results.push("Candidate-authorized file validation/import is atomic and shared with MCP; selection alone does not upload; authority/history not restored");

  await alice.page.getByRole("heading", { name: "Storage & all records", exact: true }).waitFor();
  for (const width of [1440, 390]) {
    await alice.page.setViewportSize({ width, height: 1000 });
    assert.equal(await alice.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Record management must not overflow on mobile");
  }
  const beforeManagement = (await webApi(alice.page, "state")).body;
  const mcpUsage = decoded(await connection.client.callTool({ name: "workspace_info", arguments: {} }));
  assert.equal(mcpUsage.usage.total_bytes, beforeManagement.usage.total_bytes);
  assert.ok(beforeManagement.usage.history_bytes > 0);
  const managedProfile = alice.page.locator(`[data-managed-id="${profile.id}"]`);
  await managedProfile.getByText("Inspect preserved history", { exact: true }).click();
  await managedProfile.getByText("Version 1 ·", { exact: false }).waitFor();
  const forbiddenDelete = await webApi(other.page, `records/${profile.id}`, "DELETE", { confirmation: "DELETE RECORD", expected_revision: 2 });
  assert.equal(forbiddenDelete.status, 404);
  const staleDelete = await webApi(alice.page, `records/${profile.id}`, "DELETE", { confirmation: "DELETE RECORD", expected_revision: 1 });
  assert.equal(staleDelete.status, 409);
  await alice.page.getByLabel("Filter records by type").selectOption("assessment");
  assert.equal(await managedProfile.isVisible(), false);
  const managedAssessment = alice.page.locator(`[data-managed-id="${assessment.id}"]`);
  await managedAssessment.getByText("Inspect saved content", { exact: true }).click();
  assert.match(await managedAssessment.innerText(), /SQL not established/);
  alice.page.once("dialog", dialog => dialog.accept());
  await managedAssessment.getByRole("button", { name: "Delete assessment record", exact: true }).click();
  await managedAssessment.waitFor({ state: "detached" });
  assert.equal((await connection.client.callTool({ name: "get_record", arguments: { id: assessment.id } })).isError, true);
  results.push("Browser/MCP usage agree; candidates inspect history, filter and delete assessments; cross-user and stale deletion denied");

  await alice.page.getByRole("button", { name: "My profile", exact: true }).click();
  await alice.page.getByRole("button", { name: "Add evidence", exact: true }).click();
  await alice.page.getByLabel("Evidence 2: what you actually did", { exact: true }).fill("Unsaved fictional item to remove");
  alice.page.once("dialog", dialog => dialog.accept());
  await alice.page.getByRole("button", { name: "Remove evidence 2", exact: true }).click();
  assert.equal(await alice.page.getByLabel("Evidence 2: what you actually did", { exact: true }).count(), 0);
  await alice.page.getByRole("button", { name: "Save profile", exact: true }).click();
  await alice.page.getByRole("button", { name: "Activity & privacy", exact: true }).click();
  await alice.page.getByLabel("Filter records by type").selectOption("profile");
  const beforeProfileDelete = (await webApi(alice.page, "state")).body.usage;
  alice.page.once("dialog", dialog => dialog.accept());
  await alice.page.getByRole("button", { name: "Delete profile record", exact: true }).click();
  await alice.page.locator(`[data-managed-id="${profile.id}"]`).waitFor({ state: "detached" });
  const afterProfileDelete = (await webApi(alice.page, "state")).body;
  assert.ok(afterProfileDelete.usage.total_bytes < beforeProfileDelete.total_bytes);
  assert.equal(afterProfileDelete.records.filter(record => record.kind === "profile").length, 0);
  const replacementProfile = decoded(await connection.client.callTool({ name: "save_profile", arguments: { expected_revision: 0, data: profile.data } }));
  assert.equal(replacementProfile.revision, profile.revision);
  assert.notEqual(replacementProfile.id, profile.id);
  assert.equal((await webApi(alice.page, "state")).body.reviews[0].current, false);
  const afterDeletionExport = await webApi(alice.page, "export");
  assert.equal(afterDeletionExport.body.versions.some(version => version.record_id === profile.id), false);
  results.push("Evidence removal, profile/history deletion and quota recovery; recreated revision-1 profile cannot revive old review");

  await alice.page.getByRole("button", { name: "Sign out", exact: true }).click();
  await alice.page.getByRole("button", { name: "Sign in with a passkey" }).waitFor();
  await alice.page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await alice.page.getByRole("navigation", { name: "Workspace sections" }).waitFor();
  results.push("Real passkey reauthentication restores persisted records");

  if (new URL(origin).hostname === "localhost") {
    // Exercise large/multi-binding imports in workerd without repeatedly filling production storage.
    for (const record of importedState.records) await webApi(other.page, `records/${record.id}`, "DELETE", { confirmation: "DELETE RECORD", expected_revision: record.revision });
    const sourceJob = exported.records.find(record => record.kind === "job");
    const bulk = { ...exported, records: Array.from({ length: 46 }, (_, index) => ({ ...sourceJob, id: crypto.randomUUID(), data: { ...sourceJob.data, source_url: `https://example.com/jobs/local-bulk-${index}`, posting: "x".repeat(45000) } })) };
    const preview = await webApi(other.page, "import/preview", "POST", { snapshot: bulk });
    assert.equal(preview.status, 200);
    assert.ok(preview.body.preview.bytes > 2_000_000);
    const confirmed = await webApi(other.page, "import/confirm", "POST", { snapshot: bulk, expected_digest: preview.body.preview.digest, confirmation: "IMPORT PREPARATION" });
    assert.equal(confirmed.status, 200);
    assert.equal((await webApi(other.page, "state")).body.records.length, 46);
    results.push("Local workerd imports all 46 records near the 2 MiB quota across bounded D1 JSON bindings");
  }

  const refreshResponse = await fetch(`${origin}/job-search/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: connection.clientId, refresh_token: connection.tokens.refresh_token, resource: endpoint }) });
  assert.equal(refreshResponse.status, 200);
  const refreshed = await refreshResponse.json();
  assert.ok(refreshed.access_token && refreshed.refresh_token);
  connection.tokens = refreshed;
  results.push("OAuth refresh-token rotation without an AI key or a browser session");

  const recovery = await webApi(alice.page, "auth/recover", "POST", { recovery_code: alice.recoveryCode, consent: true });
  assert.equal(recovery.status, 200);
  assert.notEqual(recovery.body.recovery_code, alice.recoveryCode);
  const staleRecovery = await webApi(alice.page, "auth/recover", "POST", { recovery_code: alice.recoveryCode, consent: true });
  assert.equal(staleRecovery.status, 400);
  const oldToken = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${connection.tokens.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }) });
  assert.equal(oldToken.status, 401);
  const revokedRefresh = await fetch(`${origin}/job-search/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: connection.clientId, refresh_token: refreshed.refresh_token, resource: endpoint }) });
  assert.equal(revokedRefresh.status, 400);
  results.push("Recovery code rotates once and immediately invalidates old assistant tokens");

  assert.equal((await webApi(alice.page, "delete", "POST", { confirmation: "DELETE MY WORKSPACE" })).status, 200);
  assert.equal((await webApi(alice.page, "state")).status, 401);
  assert.equal((await webApi(other.page, "delete", "POST", { confirmation: "DELETE MY WORKSPACE" })).status, 200);
  const deletedToken = await fetch(endpoint, { headers: { Authorization: `Bearer ${readOnly.tokens.access_token}` } });
  assert.equal(deletedToken.status, 401);
  assert.deepEqual(alice.errors, []);
  assert.deepEqual(other.errors, []);
  results.push("Workspace deletion ends sessions, removes records and blocks issued MCP tokens");
  await mkdir("test-results", { recursive: true });
  await writeFile("test-results/browser.json", JSON.stringify({ origin, verifiedAt: new Date().toISOString(), results, fixtureDataOnly: true }, null, 2) + "\n");
  console.log(JSON.stringify({ origin, results, fixtureDataOnly: true }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ fixtureOnly: true, verifiedGroupsBeforeFailure: results, errorClass: error?.name ?? "UnknownError" }, null, 2));
  throw error;
} finally {
  for (const client of clients) await client.close().catch(() => {});
  for (const context of contexts) {
    // These contexts are created only for this test's fictional users; clean up even after an assertion failure.
    await context.request.post(`${origin}/job-search/api/delete`, { headers: { Origin: origin }, data: { confirmation: "DELETE MY WORKSPACE" } }).catch(() => {});
    await context.close();
  }
  await browser.close();
  await new Promise(resolve => callbackServer.close(resolve));
}
