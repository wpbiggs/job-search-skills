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
