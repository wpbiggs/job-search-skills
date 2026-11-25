import test from "node:test";
import assert from "node:assert/strict";
import { inspectGreenhouse } from "../src/employer-greenhouse.ts";
import { greenhouseStaticAsset, reviewRenderedForm, type RenderedForm, type RenderedObservation } from "../src/employer-rendered.ts";
import { claimInspectionBudget } from "../src/executor-budget.ts";
import { LocalDatabase } from "../src/sqlite.ts";
import { WorkspaceStore } from "../src/store.ts";
import { ExecutorStore } from "../src/executor-store.ts";
import { renderedReview } from "../src/web/employer-review.ts";

const destination = "https://job-boards.greenhouse.io/fictional/jobs/123";
async function fixture() {
  const result = await inspectGreenhouse(destination, async () => Response.json({ id: 123, internal_job_id: 1, absolute_url: destination, title: "Fictional writer", company_name: "Fictional", location: { name: "Unknown" }, content: "Fictional only", updated_at: new Date().toISOString(), questions: [{ label: "First Name", required: true, fields: [{ name: "first_name", type: "input_text", values: [] }] }], data_compliance: [] }));
  assert.ok("inspection" in result);
  const form: RenderedForm = { destination, action: destination, method: "post", enctype: "multipart/form-data", page_title: "Fictional", role_headings: ["Fictional writer"], page_content_digest: "a".repeat(64), controls: [{ id: "first_name", name: "first_name", type: "text", role: "", labels: ["First Name*"], required_hint: true, disabled: false, readonly: false, visible: true, accept: "", pattern: "", max_length: -1, options: [] }], submit_controls: [{ id: "submit", type: "submit", label: "Submit application", disabled: false }], legal_notices: [], challenge_present: false, password_present: false, frames_present: false };
  const observed: RenderedObservation = { assets: [], blocked_writes: 0, blocked_active_resources: 0, blocked_decorative_resources: 0, blocked_websockets: 0, popup_attempts: 0, load_failures: 0, stable: true, request_limit_reached: false };
  return { metadata: result.inspection, form, observed };
}

test("static assets are exact public hashed script/style paths, not arbitrary GET destinations", () => {
  const asset = "https://job-boards.cdn.greenhouse.io/assets/root-Abcd_123.js";
  assert.equal(greenhouseStaticAsset(asset, "script"), true);
  for (const value of [asset + "?email=private", asset + "#fragment", asset.replace("https:", "http:"), asset.replace(".io/", ".io.evil/"), asset.replace("/assets/", "/uploads/"), asset.replace("root-Abcd_123", "root"), asset.replace("https://", "https://user@")]) assert.equal(greenhouseStaticAsset(value, "script"), false, value);
  assert.equal(greenhouseStaticAsset(asset, "fetch"), false);
});
test("matching structure is inspection-only; fingerprints bind public text, metadata, assets and constraints", async () => {
  const f = await fixture(), report = await reviewRenderedForm(f.metadata, f.form, f.observed);
  assert.equal(report.questions_match_metadata, true);
  const html = renderedReview({ ...report, interventions: [{ code: "<script>", control: '<img src="https://untrusted.example">', reason: "<iframe>" }] });
  assert.equal(html.includes("<script>"), false); assert.equal(html.includes("<img src="), false); assert.equal(html.includes("<iframe>"), false);
  assert.equal(report.execution_enabled, false); assert.equal(report.values_collected, false); assert.equal(report.interactive_takeover_available, false);
  for (const changed of [{ ...f.form, page_content_digest: "b".repeat(64) }, { ...f.form, controls: [{ ...f.form.controls[0], max_length: 20 }] }]) assert.notEqual((await reviewRenderedForm(f.metadata, changed, f.observed)).form_fingerprint, report.form_fingerprint);
  assert.notEqual((await reviewRenderedForm({ ...f.metadata, fingerprint: "c".repeat(64) }, f.form, f.observed)).form_fingerprint, report.form_fingerprint);
  assert.notEqual((await reviewRenderedForm(f.metadata, f.form, { ...f.observed, assets: ["https://job-boards.cdn.greenhouse.io/assets/root-Abcd_123.js"] })).form_fingerprint, report.form_fingerprint);
});
for (const [code, change] of [
  ["control_type_changed", { type: "password" }], ["control_label_changed", { labels: ["Social Security Number"] }], ["requiredness_unverified", { required_hint: false }],
  ["control_unavailable", { disabled: true }], ["control_unavailable", { visible: false }], ["options_unverified", { options: [{ value: "unexpected", label: "Unexpected" }] }],
  ["ambiguous_control_binding", { name: "different" }],
] as const) test(`rendered mismatch fails closed: ${code} ${JSON.stringify(change)}`, async () => {
  const f = await fixture(); const report = await reviewRenderedForm(f.metadata, { ...f.form, controls: [{ ...f.form.controls[0], ...change }] }, f.observed);
  assert.equal(report.questions_match_metadata, false); assert.ok(report.interventions.some(item => item.code === code));
});
test("new, anonymous, missing, duplicate controls and role changes require review", async () => {
  const f = await fixture();
  for (const form of [{ ...f.form, controls: [] }, { ...f.form, controls: [...f.form.controls, f.form.controls[0]] }, { ...f.form, controls: [...f.form.controls, { ...f.form.controls[0], id: "", name: "" }] }, { ...f.form, role_headings: ["Different role"] }]) assert.equal((await reviewRenderedForm(f.metadata, form, f.observed)).questions_match_metadata, false);
});
test("script-managed forms, legal notices, auth, challenges and denied network activity never become executable", async () => {
  const f = await fixture();
  const report = await reviewRenderedForm(f.metadata, { ...f.form, method: "get", legal_notices: ["I certify this application"], password_present: true, challenge_present: true }, { ...f.observed, blocked_writes: 1, blocked_active_resources: 1 });
  for (const code of ["script_managed_form", "legal_notice", "authentication", "challenge_or_frame", "write_attempt_blocked", "render_incomplete"]) assert.ok(report.interventions.some(item => item.code === code));
  assert.equal(report.execution_enabled, false);
});
test("unexpected values, destinations and oversized control manifests are rejected", async () => {
  const f = await fixture();
  await assert.rejects(reviewRenderedForm(f.metadata, { ...f.form, controls: [{ ...f.form.controls[0], value: "must not collect" }] }, f.observed));
  await assert.rejects(reviewRenderedForm(f.metadata, { ...f.form, destination: destination.replace("123", "456") }, f.observed), /destination/);
  await assert.rejects(reviewRenderedForm(f.metadata, { ...f.form, controls: Array(101).fill(f.form.controls[0]) }, f.observed));
});
test("rendered inspection reserves two units atomically and never widens the shared ten-unit budget", async () => {
  const db = new LocalDatabase(":memory:"), now = Date.parse("2026-11-25T12:00:00Z");
  try {
    for (let index = 0; index < 9; index++) assert.equal(await claimInspectionBudget(db, 1, now), true);
    assert.equal(await claimInspectionBudget(db, 2, now), false);
    assert.equal((await db.prepare("SELECT used FROM executor_budget").first<{ used: number }>())?.used, 9);
    assert.equal(await claimInspectionBudget(db, 1, now), true);
    assert.equal(await claimInspectionBudget(db, 1, now), false);
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => claimInspectionBudget(db, 2, now + 86400000)));
    assert.equal(concurrent.filter(Boolean).length, 5);
    assert.equal(await claimInspectionBudget(db, 2, now + 2 * 86400000), true);
  } finally { db.close(); }
});
test("render operation is website-only, owner scoped and paused before any private-service call", async () => {
  const db = new LocalDatabase(":memory:"), userId = crypto.randomUUID(), otherId = crypto.randomUUID();
  try {
    for (const id of [userId, otherId]) await db.prepare("INSERT INTO users(id,name,epoch,recovery_hash) VALUES(?,?,?,?)").bind(id, "Fictional render test", crypto.randomUUID(), crypto.randomUUID()).run();
    const store = new WorkspaceStore(db, userId, "website");
    const job = await store.save({ kind: "job", expected_revision: 0, data: { company: "Fictional", title: "Fictional writer", source_url: destination, posting: "Fictional", checked_at: new Date().toISOString(), location: "Unknown", compensation: "Unknown" } });
    const calls: unknown[] = [];
    const service = { async fetch(request: Request) { calls.push(await request.json()); return Response.json({ execution_enabled: false }); } };
    const executor = (workspace: WorkspaceStore) => new ExecutorStore(workspace, service, ["job-boards.greenhouse.io"], "https://example.com");
    await assert.rejects(executor(new WorkspaceStore(db, userId, "assistant")).render(job.id), /Only the candidate/);
    await assert.rejects(executor(new WorkspaceStore(db, otherId, "website")).render(job.id), /not found/);
    await executor(store).pause(true); await assert.rejects(executor(store).render(job.id), /paused/);
    assert.equal(calls.length, 0);
    await executor(store).pause(false); await executor(store).render(job.id);
    assert.deepEqual(calls, [{ operation: "render", destination }]);
  } finally { db.close(); }
});
