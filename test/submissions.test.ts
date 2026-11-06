import test from "node:test";
import assert from "node:assert/strict";
import { LocalDatabase } from "../src/sqlite.ts";
import { WorkspaceStore } from "../src/store.ts";
import { SubmissionStore } from "../src/submissions.ts";

async function fixture() {
  const db = new LocalDatabase(":memory:");
  const userId = crypto.randomUUID(), otherId = crypto.randomUUID();
  for (const id of [userId, otherId]) await db.prepare("INSERT INTO users(id,name,epoch,recovery_hash) VALUES(?,?,?,?)").bind(id, "Fictional fixture", crypto.randomUUID(), crypto.randomUUID()).run();
  const workspace = new WorkspaceStore(db, userId, "website"), submissions = new SubmissionStore(workspace);
  const profile = await workspace.save({ kind: "profile", expected_revision: 0, data: { goals: "Fixture", preferences: "", constraints: "", evidence: [{ id: "writing", claim: "Fictional writing", source: "Fixture only", confirmed: true }] } });
  const job = await workspace.save({ kind: "job", expected_revision: 0, data: { company: "Fixture", title: "Writer", source_url: "https://example.com/jobs/fixture", location: "Unknown", compensation: "Unknown", posting: "Fictional posting", checked_at: new Date().toISOString() } });
  const draft = await workspace.save({ kind: "draft", job_id: job.id, expected_revision: 0, data: { type: "resume", content: "Fictional writer", evidence_ids: ["writing"], unresolved_claims: "" } });
  const input = async () => ({ job_id: job.id, draft_id: draft.id, expected_digest: (await submissions.snapshot(job.id, draft.id)).payload_digest, confirmation: "APPROVE MANUAL HANDOFF" });
  return { db, userId, otherId, workspace, submissions, profile, job, draft, input };
}

test("candidate-only exact snapshot; foreign ownership and changed digest denied", async () => {
  const f = await fixture();
  try {
    const input = await f.input();
    const assistant = new SubmissionStore(new WorkspaceStore(f.db, f.userId, "assistant"));
    await assert.rejects(assistant.approve(input), /candidate/);
    assert.deepEqual(await assistant.list(), []);
    const other = new SubmissionStore(new WorkspaceStore(f.db, f.otherId, "website"));
    await assert.rejects(other.approve(input), /not found/);
    await assert.rejects(f.submissions.approve({ ...input, expected_digest: "0".repeat(64) }), /changed/);
    const id = await f.submissions.approve(input);
    await assert.rejects(other.act(id, "open"), /not found/);
    assert.equal((await other.list()).length, 0);
    await assert.rejects(f.submissions.approve(input), /active handoff/);
  } finally { f.db.close(); }
});

test("one-use opening and candidate receipt; cannot confirm before opening or apply twice", async () => {
  const f = await fixture();
  try {
    const id = await f.submissions.approve(await f.input());
    await assert.rejects(f.submissions.act(id, "confirm", "Fictional receipt"), /Open the current/);
    const opened = await f.submissions.act(id, "open");
    assert.equal(opened.destination, f.job.data.source_url);
    await assert.rejects(f.submissions.act(id, "open"), /already opened/);
    assert.equal((await f.db.prepare("SELECT count(*) AS count FROM submission_attempts").first<{count:number}>())?.count, 1);
    await assert.rejects(f.submissions.act(id, "confirm", "short"));
    await f.submissions.act(id, "confirm", "Fictional confirmation REF-123");
    assert.equal((await f.submissions.list())[0].status, "submitted");
    assert.equal((await f.submissions.list())[0].receipt, "Fictional confirmation REF-123");
    await assert.rejects(f.submissions.act(id, "confirm", "Repeated receipt"), /Open the current/);
    await assert.rejects(f.submissions.act(id, "cancel"), /closed/);
    await assert.rejects(f.submissions.approve(await f.input()), /already recorded/);
  } finally { f.db.close(); }
});

for (const kind of ["draft", "profile", "job"] as const) test(`${kind} edits atomically invalidate handoffs`, async () => {
  const f = await fixture();
  try {
    const id = await f.submissions.approve(await f.input());
    const record = f[kind];
    await f.workspace.save({ kind, id: record.id, ...(kind === "draft" ? { job_id: f.job.id } : {}), expected_revision: 1, data: record.data });
    assert.equal((await f.submissions.list())[0].status, "stale");
    await assert.rejects(f.submissions.act(id, "open"), /changed/);
  } finally { f.db.close(); }
});

test("expiry denies opening; cancelling never asserts employer withdrawal", async () => {
  const f = await fixture();
  try {
    const id = await f.submissions.approve(await f.input());
    await f.db.prepare("UPDATE submission_intents SET expires_at=? WHERE id=?").bind("2020-01-01T00:00:00.000Z", id).run();
    await assert.rejects(f.submissions.act(id, "open"), /expired/);
    assert.equal((await f.submissions.list())[0].status, "expired");
    await f.submissions.act(id, "cancel");
    assert.equal((await f.submissions.list())[0].status, "cancelled");
    assert.ok(await f.submissions.approve(await f.input()));
    assert.equal((await f.workspace.reviews()).length, 0);
  } finally { f.db.close(); }
});

test("uncertain opened handoff blocks retries even after draft changes", async () => {
  const f = await fixture();
  try {
    const id = await f.submissions.approve(await f.input());
    await f.submissions.act(id, "open");
    await f.workspace.save({ kind: "draft", id: f.draft.id, job_id: f.job.id, expected_revision: 1, data: f.draft.data });
    await assert.rejects(f.submissions.approve(await f.input()), /already recorded/);
    await assert.rejects(f.submissions.act(id, "confirm", "Uncertain receipt"), /Changed records/);
    await f.submissions.act(id, "cancel");
    assert.ok(await f.submissions.approve(await f.input()));
  } finally { f.db.close(); }
});

test("unconfirmed evidence and unresolved claims cannot become handoffs", async () => {
  const f = await fixture();
  try {
    await f.workspace.save({ kind: "draft", id: f.draft.id, job_id: f.job.id, expected_revision: 1, data: { ...f.draft.data, unresolved_claims: "Must verify" } });
    await assert.rejects(f.input(), /Resolve draft claims/);
    await f.workspace.save({ kind: "profile", id: f.profile.id, expected_revision: 1, data: { ...f.profile.data, evidence: [{ id: "writing", claim: "Fictional", source: "Fixture", confirmed: false }] } });
    await f.workspace.save({ kind: "draft", id: f.draft.id, job_id: f.job.id, expected_revision: 2, data: f.draft.data });
    await assert.rejects(f.input(), /confirm cited/);
  } finally { f.db.close(); }
});

test("profile deletion invalidates; job/draft and account deletion cascade audit metadata", async () => {
  const f = await fixture();
  try {
    const id = await f.submissions.approve(await f.input());
    await f.submissions.act(id, "open");
    await f.workspace.removeRecord(f.profile.id, 1);
    assert.equal((await f.submissions.list())[0].status, "stale");
    await f.workspace.removeRecord(f.job.id, 1);
    assert.equal((await f.submissions.list()).length, 0);
    assert.equal((await f.db.prepare("SELECT count(*) AS count FROM submission_attempts").first<{count:number}>())?.count, 0);
  } finally { f.db.close(); }
});

test("approval rejects a profile write racing between preview validation and conditional insert", async () => {
  const f = await fixture();
  try {
    const input = await f.input();
    const prepare = f.db.prepare.bind(f.db);
    f.db.prepare = query => {
      if (query.startsWith("INSERT INTO submission_intents")) f.db.connection.prepare("UPDATE records SET revision=revision+1 WHERE id=?").run(f.profile.id);
      return prepare(query);
    };
    await assert.rejects(f.submissions.approve(input), /Records changed/);
    assert.deepEqual(await f.submissions.list(), []);
  } finally { f.db.close(); }
});

test("account deletion cascades intents and attempts; exports import no handoff authority", async () => {
  const f = await fixture();
  try {
    const id = await f.submissions.approve(await f.input());
    await f.submissions.act(id, "open");
    const exported = await f.workspace.export();
    assert.equal((exported.handoffs as unknown[]).length, 1);
    const other = new WorkspaceStore(f.db, f.otherId, "website");
    const preview = await other.previewImport(exported);
    await other.importPreparation(exported, preview.digest);
    assert.deepEqual(await other.handoffs(), []);
    await f.db.prepare("DELETE FROM users WHERE id=?").bind(f.userId).run();
    assert.equal((await f.db.prepare("SELECT count(*) AS count FROM submission_intents").first<{count:number}>())?.count, 0);
    assert.equal((await f.db.prepare("SELECT count(*) AS count FROM submission_attempts").first<{count:number}>())?.count, 0);
  } finally { f.db.close(); }
});

test("handoff history quota is bounded independently of preparation storage", async () => {
  const f = await fixture();
  try {
    const input = await f.input();
    const first = await f.submissions.approve(input);
    await f.submissions.act(first, "cancel");
    f.db.connection.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<249)
      INSERT INTO submission_intents SELECT lower(hex(randomblob(16))),user_id,job_id,draft_id,job_revision,draft_revision,profile_id,profile_revision,destination,payload_digest,approved_at,expires_at,status,updated_at FROM submission_intents,n WHERE id='${first}'`);
    await assert.rejects(f.submissions.approve(input), /history limit/);
    assert.equal((await f.submissions.list()).length, 250);
  } finally { f.db.close(); }
});
