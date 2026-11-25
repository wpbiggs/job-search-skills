import test from "node:test";
import assert from "node:assert/strict";
import { LocalDatabase } from "../src/sqlite.ts";
import { WorkspaceStore, type SqlDatabase } from "../src/store.ts";
import { inspectGreenhouse } from "../src/employer-greenhouse.ts";
import { ApplicationPackageStore } from "../src/application-package-store.ts";
import { packageInputSchema } from "../src/application-package.ts";
import { hash } from "../src/security.ts";
import { SubmissionStore } from "../src/submissions.ts";
import { ExecutorStore } from "../src/executor-store.ts";

async function fixture() {
  const db = new LocalDatabase(":memory:"), userId = crypto.randomUUID(), otherId = crypto.randomUUID();
  for (const id of [userId, otherId]) await db.prepare("INSERT INTO users(id,name,epoch,recovery_hash) VALUES(?,?,?,?)").bind(id, "Package fixture only", crypto.randomUUID(), crypto.randomUUID()).run();
  const store = new WorkspaceStore(db, userId, "website");
  const profile = await store.save({ kind: "profile", expected_revision: 0, data: { goals: "Fictional test", preferences: "", constraints: "", evidence: [{ id: "writing", claim: "Fictional writing", source: "Owned fixture", confirmed: true }] } });
  const destination = "https://job-boards.greenhouse.io/fictionalcompany/jobs/123456";
  const job = await store.save({ kind: "job", expected_revision: 0, data: { company: "Fictional company", title: "Fictional writer", source_url: destination, posting: "Fictional writing role", checked_at: new Date().toISOString(), location: "Unknown", compensation: "Unknown" } });
  const draftData = { content: "FICTIONAL CANDIDATE — approved source only", evidence_ids: ["writing"], unresolved_claims: "" };
  const resume = await store.save({ kind: "draft", expected_revision: 0, job_id: job.id, data: { ...draftData, type: "resume" } });
  const cover = await store.save({ kind: "draft", expected_revision: 0, job_id: job.id, data: { ...draftData, content: "FICTIONAL COVER LETTER", type: "cover_letter" } });
  const q = (label: string, name: string, required = true, type = "input_text") => ({ label, required, fields: [{ name, type, values: [] }] });
  let raw = { id: 123456, internal_job_id: 999, absolute_url: destination, title: "Fictional writer", company_name: "Fictional company", location: { name: "Remote" }, content: "Fictional writing role", updated_at: new Date().toISOString(),
    questions: [q("First Name", "first_name"), q("Last Name", "last_name"), q("Email", "email"), q("Resume/CV", "resume", true, "input_file"), q("Cover Letter", "cover_letter", false, "input_file"), q("Website", "question_123", false), q("Work authorization", "question_456")],
    data_compliance: [{ type: "gdpr", requires_consent: false, requires_processing_consent: false, requires_retention_consent: false, demographic_data_consent_applies: false }],
  };
  let inspections = 0;
  const inspect = async (id: string) => { assert.equal(id, job.id); inspections++; return { ...await inspectGreenhouse(destination, async () => Response.json(raw)) }; };
  const initial = await inspect(job.id); assert.ok("inspection" in initial);
  const input = packageInputSchema.parse({ job_id: job.id, inspection_fingerprint: initial.inspection.fingerprint,
    answers: [{ question_id: "application:0", field_name: "first_name", value: "Fictional" }, { question_id: "application:1", field_name: "last_name", value: "Candidate" }, { question_id: "application:2", field_name: "email", value: "fixture@example.invalid" }],
    documents: [{ question_id: "application:3", field_name: "resume", draft_id: resume.id }], skips: ["application:4", "application:5"], deferred: ["application:6"] });
  const packages = new ApplicationPackageStore(store, inspect);
  const approval = async () => ({ input, expected_digest: (await packages.preview(input)).package_digest, confirmation: "APPROVE EXACT PREPARATION PACKAGE" });
  return { db, store, userId, otherId, profile, job, resume, cover, input, inspect, packages, approval, inspections: () => inspections, changeProvider: () => { raw = { ...raw, content: "Changed provider requirements" }; } };
}

test("exact package binds employer, ordinary answers, chosen document bytes, explicit skips and deferred steps without executing", async () => {
  const f = await fixture();
  try {
    const exact = await f.packages.preview(f.input);
    assert.equal(exact.documents[0].content, f.resume.data.content);
    assert.equal(exact.documents[0].document_digest, await hash(String(f.resume.data.content)));
    assert.equal(exact.answers[2].value, "fixture@example.invalid");
    assert.equal(exact.deferred[0].question_label, "Work authorization");
    assert.equal(exact.execution_enabled, false);
    const { package_digest, ...core } = exact;
    assert.equal(package_digest, await hash(JSON.stringify(core)));
    const count = f.inspections();
    const approved = await f.packages.approve({ input: f.input, expected_digest: exact.package_digest, confirmation: "APPROVE EXACT PREPARATION PACKAGE" });
    assert.equal(f.inspections(), count + 1, "Approval must read fresh provider metadata");
    assert.equal(approved.execution_enabled, false);
    const saved = await f.packages.get(approved.id);
    assert.deepEqual(saved.package, exact);
    assert.equal(saved.status, "approved");
    const executor = new ExecutorStore(f.store, { async fetch() { throw new Error("Package must never authorize a browser invocation"); } }, ["job-boards.greenhouse.io"], "https://example.com");
    await assert.rejects(executor.run(approved.id), /Unapproved/);
    assert.equal((await f.db.prepare("SELECT count(*) AS n FROM delegated_attempts").first<{ n: number }>())?.n, 0);
    assert.deepEqual(await f.store.reviews(), []); assert.deepEqual(await f.store.handoffs(), []);
  } finally { f.db.close(); }
});
test("required questions cannot be silently skipped and every optional/deferred decision is explicit", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.packages.preview({ ...f.input, deferred: [] }), /exactly one/);
    await assert.rejects(f.packages.preview({ ...f.input, skips: [...f.input.skips, "application:6"], deferred: [] }), /cannot be skipped/);
    await assert.rejects(f.packages.preview({ ...f.input, skips: ["application:4", "application:4", "application:5"] }), /exactly one/);
    await assert.rejects(f.packages.preview({ ...f.input, deferred: ["unanticipated"] }), /exactly one/);
  } finally { f.db.close(); }
});
test("ordinary package rejects sensitive answers, unsupported fields, malformed contacts and private links", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.packages.preview({ ...f.input, answers: [...f.input.answers, { question_id: "application:6", field_name: "question_456", value: "Inferred authorization" }], deferred: [] }), /Sensitive/);
    await assert.rejects(f.packages.preview({ ...f.input, answers: f.input.answers.map(item => item.field_name === "email" ? { ...item, value: "not-email" } : item) }), /email/);
    await assert.rejects(f.packages.preview({ ...f.input, answers: [...f.input.answers, { question_id: "application:5", field_name: "question_123", value: "http://localhost/private" }], skips: ["application:4"] }), /public HTTPS/);
    await assert.rejects(f.packages.preview({ ...f.input, answers: f.input.answers.map(item => ({ ...item, field_name: "unexpected" })) }), /Sensitive/);
  } finally { f.db.close(); }
});
test("document types and profile evidence are checked, and mixed jobs or changed bytes cannot be approved", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.packages.preview({ ...f.input, documents: [{ ...f.input.documents[0], draft_id: f.cover.id }] }), /requested type/);
    await f.store.save({ kind: "draft", id: f.resume.id, job_id: f.job.id, expected_revision: 1, data: { ...f.resume.data, unresolved_claims: "Unverified claim" } });
    await assert.rejects(f.packages.preview(f.input), /Resolve draft/);
  } finally { f.db.close(); }
});
test("website-only owner-scoped approval cannot be exercised through an assistant or another account", async () => {
  const f = await fixture();
  try {
    const body = await f.approval();
    const assistant = new ApplicationPackageStore(new WorkspaceStore(f.db, f.userId, "assistant"), f.inspect);
    await assert.rejects(assistant.preview(f.input), /Only the candidate/); await assert.rejects(assistant.approve(body), /Only the candidate/);
    const other = new ApplicationPackageStore(new WorkspaceStore(f.db, f.otherId, "website"), f.inspect);
    await assert.rejects(other.preview(f.input), /not found/);
    const approved = await f.packages.approve(body);
    await assert.rejects(other.get(approved.id), /not found/); await assert.rejects(other.cancel(approved.id), /not found/);
    await assert.rejects(assistant.cancel(approved.id), /Only the candidate/);
    assert.deepEqual(await other.list(), []);
  } finally { f.db.close(); }
});
for (const kind of ["job", "profile", "resume", "cover"] as const) test(`saved ${kind} revisions invalidate a linked approved package synchronously`, async () => {
  const f = await fixture();
  try {
    f.input.documents.push({ question_id: "application:4", field_name: "cover_letter", draft_id: f.cover.id }); f.input.skips = ["application:5"];
    const approved = await f.packages.approve(await f.approval());
    const record = f[kind];
    await f.store.save({ kind: record.kind, id: record.id, expected_revision: record.revision, ...(record.job_id ? { job_id: record.job_id } : {}), data: record.data });
    assert.equal((await f.packages.get(approved.id)).status, "stale");
  } finally { f.db.close(); }
});
test("provider changes, tampered ordinary answers and a wrong approval digest require fresh review", async () => {
  const f = await fixture();
  try {
    const body = await f.approval();
    await assert.rejects(f.packages.approve({ ...body, expected_digest: "0".repeat(64) }), /changed/);
    await assert.rejects(f.packages.approve({ ...body, input: { ...f.input, answers: f.input.answers.map(answer => ({ ...answer, value: answer.field_name === "email" ? "other@example.invalid" : answer.value })) } }), /changed/);
    f.changeProvider(); await assert.rejects(f.packages.approve(body), /snapshot changed/);
    assert.deepEqual(await f.packages.list(), []);
  } finally { f.db.close(); }
});
test("revalidation detects a provider change after approval and cannot revive cancelled authority", async () => {
  const f = await fixture();
  try {
    const first = await f.packages.approve(await f.approval());
    const current = await f.packages.revalidate(first.id);
    assert.equal(current.snapshot_current, true); assert.equal(current.execution_enabled, false);
    f.changeProvider();
    const changed = await f.packages.revalidate(first.id);
    assert.equal(changed.snapshot_current, false); assert.equal(changed.status, "stale");
    await f.packages.cancel(first.id);
    const calls = f.inspections();
    assert.equal((await f.packages.revalidate(first.id)).snapshot_current, false);
    assert.equal(f.inspections(), calls, "Cancelled approvals are not refreshed or revived");
  } finally { f.db.close(); }
});
test("atomic revision checks catch a document write between final validation and package insertion", async () => {
  const f = await fixture();
  try {
    const body = await f.approval(); let raced = false;
    const db: SqlDatabase = { prepare(query) { if (!raced && query.startsWith("INSERT INTO application_packages")) { raced = true; f.db.connection.prepare("UPDATE records SET revision=revision+1 WHERE id=?").run(f.resume.id); } return f.db.prepare(query); }, batch: statements => f.db.batch(statements) };
    const packages = new ApplicationPackageStore(new WorkspaceStore(db, f.userId, "website"), f.inspect);
    await assert.rejects(packages.approve(body), /Records changed/);
    assert.deepEqual(await packages.list(), []);
    assert.equal((await f.db.prepare("SELECT count(*) AS n FROM application_package_documents").first<{ n: number }>())?.n, 0);
  } finally { f.db.close(); }
});
test("duplicate approval is single-package; cancellation, expiry and pause never create execution", async () => {
  const f = await fixture();
  try {
    const body = await f.approval();
    const results = await Promise.allSettled([f.packages.approve(body), f.packages.approve(body)]);
    assert.deepEqual(results.map(item => item.status).sort(), ["fulfilled", "rejected"]);
    const first = (await f.packages.list())[0]; await f.packages.cancel(first.id);
    assert.equal((await f.packages.get(first.id)).status, "cancelled");
    const next = await f.packages.approve(body);
    await f.db.prepare("UPDATE application_packages SET expires_at='2020-01-01T00:00:00.000Z' WHERE id=?").bind(next.id).run();
    assert.equal((await f.packages.get(next.id)).status, "expired");
    await f.db.prepare("INSERT INTO executor_controls(user_id,paused) VALUES(?,1)").bind(f.userId).run();
    await assert.rejects(f.packages.approve(body), /paused/);
    assert.equal((await f.db.prepare("SELECT count(*) AS n FROM delegated_attempts").first<{ n: number }>())?.n, 0);
  } finally { f.db.close(); }
});
test("known outcomes or prior submission attempts block approval instead of inviting duplicate applications", async () => {
  const f = await fixture();
  try {
    const body = await f.approval();
    await f.store.outcome(f.job.id, { status: "closed", note: "Fictional closed-role fixture", next_action_at: null });
    await assert.rejects(f.packages.approve(body), /reconciliation/);
  } finally { f.db.close(); }
});
test("opened and later cancelled manual attempts still require reconciliation before package approval", async () => {
  const f = await fixture();
  try {
    const body = await f.approval(), submissions = new SubmissionStore(f.store);
    const snapshot = await submissions.snapshot(f.job.id, f.resume.id);
    const id = await submissions.approve({ job_id: f.job.id, draft_id: f.resume.id, expected_digest: snapshot.payload_digest, confirmation: "APPROVE MANUAL HANDOFF" });
    await submissions.act(id, "open");
    await assert.rejects(f.packages.approve(body), /reconciliation/);
    await submissions.act(id, "cancel");
    await assert.rejects(f.packages.approve(body), /reconciliation/);
  } finally { f.db.close(); }
});
test("stale provider responses and unconfirmed current evidence cannot produce an approved package", async () => {
  const f = await fixture();
  try {
    const result = await f.inspect(f.job.id); assert.ok("inspection" in result);
    const stale = new ApplicationPackageStore(f.store, async () => ({ inspection: { ...result.inspection, checked_at: "2020-01-01T00:00:00.000Z" } }));
    await assert.rejects(stale.preview(f.input), /stale or future/);
    await f.store.save({ kind: "profile", id: f.profile.id, expected_revision: 1, data: { ...f.profile.data, evidence: [{ id: "writing", claim: "Fictional writing", source: "Owned fixture", confirmed: false }] } });
    await f.store.save({ kind: "draft", id: f.resume.id, job_id: f.job.id, expected_revision: 1, data: f.resume.data });
    await assert.rejects(f.packages.preview(f.input), /confirm cited profile evidence/);
  } finally { f.db.close(); }
});
test("package history count limit is enforced independently of the active-approval unique constraint", async () => {
  const f = await fixture();
  try {
    const body = await f.approval();
    for (let index = 0; index < 50; index++) { const approved = await f.packages.approve(body); await f.packages.cancel(approved.id); }
    await assert.rejects(f.packages.approve(body), /history limit/);
    assert.equal((await f.packages.list()).length, 50);
  } finally { f.db.close(); }
});
test("UTF-8 package bytes and total stored history are bounded even below the package count limit", async () => {
  const f = await fixture();
  try {
    const large = await f.store.save({ kind: "draft", id: f.resume.id, job_id: f.job.id, expected_revision: 1, data: { ...f.resume.data, content: "é".repeat(32000) } });
    await assert.rejects(f.packages.preview(f.input), /exceeds 64 KiB/);
    await f.store.save({ kind: "draft", id: f.resume.id, job_id: f.job.id, expected_revision: large.revision, data: { ...f.resume.data, content: "Fictional ".repeat(3000) } });
    const body = await f.approval(); let stopped = false;
    for (let index = 0; index < 50; index++) {
      try { const approved = await f.packages.approve(body); await f.packages.cancel(approved.id); }
      catch (error) { assert.match(String(error), /history limit/); stopped = true; break; }
    }
    assert.equal(stopped, true);
    const row = await f.db.prepare("SELECT count(*) AS n,sum(length(CAST(package AS BLOB))) AS bytes FROM application_packages").first<{ n: number; bytes: number }>();
    assert.ok(row!.n < 50 && row!.bytes <= 1048576);
  } finally { f.db.close(); }
});
test("exports include exact private packages, while preparation import never restores approval authority", async () => {
  const f = await fixture();
  try {
    await f.packages.approve(await f.approval());
    const exported = await f.store.export();
    assert.equal((exported.application_packages as unknown[]).length, 1);
    const other = new WorkspaceStore(f.db, f.otherId, "website");
    const preview = await other.previewImport(exported);
    assert.equal(preview.not_restored.application_packages, 1);
    await other.importPreparation(exported, preview.digest);
    assert.deepEqual(await other.packageApprovals(), []);
  } finally { f.db.close(); }
});
for (const kind of ["job", "profile", "resume", "cover", "account"] as const) test(`deleting ${kind} erases associated exact package data and document links`, async () => {
  const f = await fixture();
  try {
    f.input.documents.push({ question_id: "application:4", field_name: "cover_letter", draft_id: f.cover.id }); f.input.skips = ["application:5"];
    await f.packages.approve(await f.approval());
    if (kind === "account") await f.db.prepare("DELETE FROM users WHERE id=?").bind(f.userId).run();
    else await f.store.removeRecord(f[kind].id, 1);
    assert.equal((await f.db.prepare("SELECT count(*) AS n FROM application_packages").first<{ n: number }>())?.n, 0);
    assert.equal((await f.db.prepare("SELECT count(*) AS n FROM application_package_documents").first<{ n: number }>())?.n, 0);
  } finally { f.db.close(); }
});
