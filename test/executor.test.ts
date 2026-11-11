import test from "node:test";
import assert from "node:assert/strict";
import { LocalDatabase } from "../src/sqlite.ts";
import { WorkspaceStore } from "../src/store.ts";
import { ExecutorStore } from "../src/executor-store.ts";
import { employerUrl, fingerprintForm, ordinaryField, validatePayload, EXECUTOR_FIXTURE_DOCUMENT } from "../src/executor-contract.ts";
import { hash } from "../src/security.ts";
import { SubmissionStore } from "../src/submissions.ts";
import { executorFixture } from "../src/executor-fixture.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";

async function fixture(filename = ":memory:") {
  const db = new LocalDatabase(filename), userId = crypto.randomUUID(), otherId = crypto.randomUUID();
  for (const id of [userId, otherId]) await db.prepare("INSERT INTO users(id,name,epoch,recovery_hash) VALUES(?,?,?,?)").bind(id, "Fictional test", crypto.randomUUID(), crypto.randomUUID()).run();
  const store = new WorkspaceStore(db, userId, "website");
  const profile = await store.save({ kind: "profile", expected_revision: 0, data: { goals: "Fixture only", preferences: "", constraints: "", evidence: [{ id: "writing", claim: "Fictional writing", source: "Owned fixture", confirmed: true }] } });
  const job = await store.save({ kind: "job", expected_revision: 0, data: { company: "Owned fictional ATS", title: "Fixture writer", source_url: "https://example.com/job-search/workspace/executor-fixture", posting: "Fictional posting", checked_at: new Date().toISOString(), location: "Unknown", compensation: "Unknown" } });
  const draft = await store.save({ kind: "draft", expected_revision: 0, job_id: job.id, data: { type: "resume", content: "FICTIONAL CANDIDATE — controlled test", evidence_ids: ["writing"], unresolved_claims: "" } });
  const form = await fingerprintForm({ destination: String(job.data.source_url), action: String(job.data.source_url), method: "post", title: "Owned fictional ATS", fields: [{ name: "name", label: "Name", type: "text", required: true }, { name: "email", label: "Email", type: "email", required: true }, { name: "resume", label: "Résumé", type: "file", required: true }] });
  const payload = { fields: [{ name: "name", value: "Fictional Candidate" }, { name: "email", value: "fixture@example.invalid" }], document: { name: "resume.txt" as const, content: String(draft.data.content), digest: await hash(String(draft.data.content)) } };
  let runCalls = 0, interrupted = false;
  const service = { async fetch(request: Request) {
    const body = await request.json() as { operation: string };
    if (body.operation === "inspect") return Response.json({ form, live_submission_enabled: false });
    if (body.operation === "run") { runCalls++; if (interrupted) throw new Error("Synthetic interruption"); return Response.json({ status: "fixture_verified", reason: "Fictional ATS only", receipt: { id: `fixture-${"1".repeat(64)}`, response_digest: "2".repeat(64), received_at: new Date().toISOString(), synthetic: true } }); }
    throw new Error("Unexpected operation");
  } };
  const executor = new ExecutorStore(store, service, ["example.com"], "https://example.com");
  const input = async () => ({ job_id: job.id, draft_id: draft.id, snapshot_digest: (await new SubmissionStore(store).snapshot(job.id, draft.id)).payload_digest, form, payload, confirmation: "APPROVE EXACT EXECUTOR PAYLOAD" });
  return { db, store, executor, userId, otherId, job, profile, draft, form, payload, service, input, runCalls: () => runCalls, interrupt: () => { interrupted = true; } };
}

test("executor URL allowlist is exact, HTTPS-only and cannot be expanded by payload", () => {
  assert.equal(employerUrl("https://jobs.lever.co/company/role", ["jobs.lever.co"]), "https://jobs.lever.co/company/role");
  for (const url of ["https://jobs.lever.co.attacker.invalid/a", "http://jobs.lever.co/a", "https://user:secret@jobs.lever.co/a", "https://jobs.lever.co:444/a", "https://127.0.0.1/a", "https://jobs.lever.co/a#change"]) assert.throws(() => employerUrl(url, ["jobs.lever.co"]));
});
test("sensitive, legal and unknown fields fail closed", () => {
  for (const label of ["Consent", "Work authorization", "Sponsorship", "Veteran status", "Gender", "Criminal history", "I agree to terms", "Disability", "Password", "Compensation history"]) assert.equal(ordinaryField({ name: "name", label, type: "text" }), false, label);
  assert.equal(ordinaryField({ name: "extra_question", label: "Tell us more", type: "textarea" }), false);
  assert.equal(ordinaryField({ name: "csrf_token", label: "csrf_token", type: "hidden" }), false);
});
test("exact document and field payload cannot smuggle extra questions or changed documents", async () => {
  const f = await fixture();
  try {
    await validatePayload(f.form, f.payload);
    await assert.rejects(validatePayload(f.form, { ...f.payload, document: { ...f.payload.document, content: "Changed" } }), /digest/);
    await assert.rejects(validatePayload(f.form, { ...f.payload, fields: [...f.payload.fields, { name: "work_authorization", value: "Invented" }] }), /unapproved/);
    await assert.rejects(validatePayload(f.form, { ...f.payload, fields: [f.payload.fields[0], f.payload.fields[0]] }), /Duplicate/);
  } finally { f.db.close(); }
});
test("website-only exact approval, owner isolation and synthetic receipts never create real submissions", async () => {
  const f = await fixture();
  try {
    const input = await f.input();
    const assistant = new ExecutorStore(new WorkspaceStore(f.db, f.userId, "assistant"), f.service, ["example.com"], "https://example.com");
    await assert.rejects(assistant.approve(input), /Only the candidate/);
    await assert.rejects(assistant.pause(false), /Only the candidate/);
    const other = new ExecutorStore(new WorkspaceStore(f.db, f.otherId, "website"), f.service, ["example.com"], "https://example.com");
    await assert.rejects(other.approve(input), /not found/);
    const { id } = await f.executor.approve(input);
    await assert.rejects(other.run(id), /Unapproved/);
    assert.deepEqual(await other.list(), []);
    const result = await f.executor.run(id);
    assert.equal(result.status, "fixture_verified");
    assert.equal(f.runCalls(), 1);
    await assert.rejects(f.executor.run(id), /repeated/);
    assert.equal((await f.store.reviews()).length, 0);
    assert.equal((await f.store.handoffs()).length, 0);
    assert.equal((await f.executor.list())[0].status, "fixture_verified");
  } finally { f.db.close(); }
});
for (const kind of ["job", "draft", "profile"] as const) test(`executor ${kind} changes invalidate approvals synchronously`, async () => {
  const f = await fixture();
  try {
    const { id } = await f.executor.approve(await f.input());
    const record = f[kind];
    await f.store.save({ kind, id: record.id, expected_revision: 1, ...(kind === "draft" ? { job_id: f.job.id } : {}), data: record.data });
    assert.equal((await f.executor.list())[0].status, "stale");
    await assert.rejects(f.executor.run(id), /Unapproved/);
    assert.equal(f.runCalls(), 0);
  } finally { f.db.close(); }
});
test("pause and cancel prevent execution, expiry cannot be reused", async () => {
  const f = await fixture();
  try {
    const { id } = await f.executor.approve(await f.input());
    await f.executor.pause(true);
    await assert.rejects(f.executor.run(id), /paused/);
    await f.executor.pause(false);
    await f.executor.cancel(id);
    await assert.rejects(f.executor.run(id), /Unapproved/);
    const next = await f.executor.approve(await f.input());
    await f.db.prepare("UPDATE delegated_intents SET expires_at=? WHERE id=?").bind("2020-01-01T00:00:00.000Z", next.id).run();
    await assert.rejects(f.executor.run(next.id), /expired/);
    assert.equal(f.runCalls(), 0);
  } finally { f.db.close(); }
});
test("uncertain execution cannot be automatically retried or reapproved", async () => {
  const f = await fixture();
  try {
    const { id } = await f.executor.approve(await f.input()); f.interrupt();
    assert.equal((await f.executor.run(id)).status, "uncertain");
    await assert.rejects(f.executor.run(id), /Unapproved/);
    await assert.rejects(f.executor.approve(await f.input()), /reconciliation|active/);
    assert.equal(f.runCalls(), 1);
  } finally { f.db.close(); }
});
test("approval cannot target a live employer under the current contract", async () => {
  const f = await fixture();
  try {
    const executor = new ExecutorStore(f.store, f.service, ["example.com"], "https://different.example.com");
    await assert.rejects(executor.approve(await f.input()), /Live execution is locked/);
    assert.deepEqual(await executor.list(), []);
  } finally { f.db.close(); }
});
test("deletion cascades executor payloads, attempts and controls", async () => {
  const f = await fixture();
  try {
    const { id } = await f.executor.approve(await f.input()); await f.executor.run(id); await f.executor.pause(true);
    await f.db.prepare("DELETE FROM users WHERE id=?").bind(f.userId).run();
    for (const table of ["delegated_intents", "delegated_attempts", "executor_controls"]) assert.equal((await f.db.prepare(`SELECT count(*) AS count FROM ${table}`).first<{count:number}>())?.count, 0);
  } finally { f.db.close(); }
});
test("executor exports contain owned payload history but no lease credentials; import cannot restore authority", async () => {
  const f = await fixture();
  try {
    const { id } = await f.executor.approve(await f.input()); await f.executor.run(id);
    const exported = await f.store.export();
    assert.equal((exported.executor as unknown[]).length, 1);
    assert.doesNotMatch(JSON.stringify(exported), /nonce_hash/);
    const other = new WorkspaceStore(f.db, f.otherId, "website");
    const preview = await other.previewImport(exported); await other.importPreparation(exported, preview.digest);
    assert.equal((await other.export()).executor instanceof Array, true);
    assert.deepEqual((await other.export()).executor, []);
  } finally { f.db.close(); }
});
test("global browser budget is atomically capped at ten sessions per day", async () => {
  const f = await fixture();
  try {
    for (let i = 1; i <= 10; i++) {
      const row = await f.db.prepare("INSERT INTO executor_budget(day,used) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET used=used+1 WHERE used<10 RETURNING used").bind("2026-11-10").first<{used:number}>();
      assert.equal(row?.used, i);
    }
    assert.equal(await f.db.prepare("INSERT INTO executor_budget(day,used) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET used=used+1 WHERE used<10 RETURNING used").bind("2026-11-10").first(), null);
  } finally { f.db.close(); }
});
test("two simultaneous independent SQLite connections consume only one executor lease", { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "executor-race-")), filename = join(directory, "fixture.sqlite");
  const f = await fixture(filename);
  const workers: Worker[] = [];
  try {
    const { id } = await f.executor.approve(await f.input());
    const barrier = new SharedArrayBuffer(4);
    const runs = [1, 2].map(() => {
      let ready!: () => void, finish!: (value: {success:boolean}) => void;
      const waiting = new Promise<void>(resolve => { ready = resolve; });
      const outcome = new Promise<{success:boolean}>(resolve => { finish = resolve; });
      const worker = new Worker(new URL("./fixtures/executor-race-worker.mjs", import.meta.url), { workerData: { filename, userId: f.userId, id, barrier } });
      workers.push(worker);
      worker.on("message", message => message === "ready" ? ready() : finish(message));
      worker.on("error", error => { console.error(error); ready(); finish({ success: false }); });
      return { waiting, outcome };
    });
    await Promise.all(runs.map(run => run.waiting));
    Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0);
    assert.deepEqual((await Promise.all(runs.map(run => run.outcome))).map(value => value.success).sort(), [false, true]);
    assert.equal((await f.db.prepare("SELECT count(*) AS count FROM delegated_attempts").first<{count:number}>())?.count, 1);
  } finally { await Promise.all(workers.map(worker => worker.terminate())); f.db.close(); await rm(directory, { recursive: true, force: true }); }
});
test("owned ATS rejects real-looking applicant data and issues synthetic-only receipt", async () => {
  const form = new FormData(); form.set("name", "Real Candidate"); form.set("email", "real@example.org"); form.set("resume", new File(["Real résumé"], "resume.txt"));
  const bad = await executorFixture(new Request("https://example.com/job-search/workspace/executor-fixture", { method: "POST", body: form }));
  assert.equal(bad.status, 400);
  form.set("name", "Fictional Candidate"); form.set("email", "fixture@example.invalid"); form.set("resume", new File([EXECUTOR_FIXTURE_DOCUMENT], "resume.txt"));
  const good = await executorFixture(new Request("https://example.com/job-search/workspace/executor-fixture", { method: "POST", body: form }));
  assert.equal(good.status, 200);
  assert.equal((await good.json() as {synthetic:boolean}).synthetic, true);
});
