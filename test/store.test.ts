import test from "node:test";
import assert from "node:assert/strict";
import { LocalDatabase } from "../src/sqlite.ts";
import { WorkspaceStore } from "../src/store.ts";
import { boundedBody, publicJobUrl, HttpError } from "../src/security.ts";

async function fixture() {
  const db = new LocalDatabase(":memory:");
  const alice = crypto.randomUUID(), bob = crypto.randomUUID();
  for (const id of [alice, bob]) await db.prepare("INSERT INTO users(id,name,epoch,recovery_hash) VALUES(?,?,?,?)").bind(id, "Fixture", crypto.randomUUID(), crypto.randomUUID()).run();
  return { db, alice, bob, user: new WorkspaceStore(db, alice, "website"), assistant: new WorkspaceStore(db, alice, "assistant"), other: new WorkspaceStore(db, bob, "assistant") };
}
const posting = "Required: clear written communication. Preferred: SQL. Location unknown.";
const jobData = { company: "Fictional Cooperative", title: "Operations Analyst", source_url: "https://example.com/jobs/123", location: "Unknown", compensation: "Unknown", posting, checked_at: "2026-11-05T12:00:00Z", stage: "discovered" as const, requisition_id: "123" };
const jobInput = () => ({ kind: "job" as const, expected_revision: 0, data: { ...jobData } });
const profileData = { goals: "Meaningful work", preferences: "Remote", constraints: "Unknown salary", evidence: [{ id: "communication", claim: "Wrote process documentation", source: "Candidate example", confirmed: true }] };

test("all record reads, writes and linked references are owner-scoped", async () => {
  const f = await fixture();
  try {
    const job = await f.user.save(jobInput());
    assert.equal((await f.other.list()).length, 0);
    await assert.rejects(f.other.get(job.id), /not found/);
    await assert.rejects(f.other.save({ ...jobInput(), id: job.id, expected_revision: 1 }), /not found/);
    await assert.rejects(f.other.save({ kind: "draft", job_id: job.id, expected_revision: 0, data: { type: "resume", content: "Draft", evidence_ids: [], unresolved_claims: "" } }), /not found/);
  } finally { f.db.close(); }
});
test("assistant cannot promote evidence to confirmed or change a candidate confirmation", async () => {
  const f = await fixture();
  try {
    let profile = await f.assistant.save({ kind: "profile", expected_revision: 0, data: profileData });
    assert.equal((profile.data.evidence as { confirmed: boolean }[])[0].confirmed, false);
    profile = await f.user.save({ kind: "profile", id: profile.id, expected_revision: profile.revision, data: profileData });
    profile = await f.assistant.save({ kind: "profile", id: profile.id, expected_revision: profile.revision, data: profileData });
    assert.equal((profile.data.evidence as { confirmed: boolean }[])[0].confirmed, true);
    profile = await f.assistant.save({ kind: "profile", id: profile.id, expected_revision: profile.revision, data: { ...profileData, evidence: [{ ...profileData.evidence[0], claim: "Invented metric" }] } });
    assert.equal((profile.data.evidence as { confirmed: boolean }[])[0].confirmed, false);
  } finally { f.db.close(); }
});
test("same requisition deduplicates; different requisitions stay distinct", async () => {
  const f = await fixture();
  try {
    await f.user.save(jobInput());
    await assert.rejects(f.user.save({ ...jobInput(), data: { ...jobData, source_url: `${jobData.source_url}?utm_source=test` } }), /Already saved/);
    await f.user.save({ ...jobInput(), data: { ...jobData, source_url: "https://example.com/jobs/456" } });
    assert.equal((await f.user.list()).length, 2);
  } finally { f.db.close(); }
});
test("optimistic revisions reject stale edits without changing saved content", async () => {
  const f = await fixture();
  try {
    const job = await f.user.save(jobInput());
    await f.user.save({ ...jobInput(), id: job.id, expected_revision: 1, data: { ...jobData, title: "Current" } });
    await assert.rejects(f.user.save({ ...jobInput(), id: job.id, expected_revision: 1 }), /changed/);
    assert.equal((await f.user.get(job.id)).data.title, "Current");
  } finally { f.db.close(); }
});
test("assessments require original posting quotes and existing evidence IDs", async () => {
  const f = await fixture();
  try {
    const job = await f.user.save(jobInput());
    const assessment = { recommendation: "clarify", reasons: "Transferable evidence", constraints: "Unknown", gaps: "SQL", unknowns: "Salary", requirements: [{ requirement: "Writing", posting_quote: "clear written communication", evidence_ids: ["communication"], support: "direct" }] };
    await assert.rejects(f.assistant.save({ kind: "assessment", job_id: job.id, expected_revision: 0, data: assessment }), /evidence reference/);
    await f.user.save({ kind: "profile", expected_revision: 0, data: profileData });
    await f.assistant.save({ kind: "assessment", job_id: job.id, expected_revision: 0, data: assessment });
    await assert.rejects(f.assistant.save({ kind: "assessment", job_id: job.id, expected_revision: 0, data: { ...assessment, requirements: [{ ...assessment.requirements[0], posting_quote: "A fabricated requirement" }] } }), /verbatim/);
  } finally { f.db.close(); }
});
test("only website candidate reviews; changed draft invalidates approval", async () => {
  const f = await fixture();
  try {
    const job = await f.user.save(jobInput());
    const draft = await f.assistant.save({ kind: "draft", job_id: job.id, expected_revision: 0, data: { type: "resume", content: "Factual draft", evidence_ids: [], unresolved_claims: "Check accuracy" } });
    const review = { action: "approved", draft_id: draft.id, draft_revision: 1, destination: jobData.source_url, confirmation: "Candidate checked the current draft and destination" };
    await assert.rejects(f.assistant.review(job.id, review), /Only the candidate/);
    await assert.rejects(f.user.review(job.id, { ...review, destination: "https://evil.example/collect" }), /destination/);
    await assert.rejects(f.user.review(job.id, { ...review, action: "submitted" }), /Approve/);
    await f.user.review(job.id, review);
    assert.equal((await f.user.reviews())[0].current, true);
    await f.assistant.save({ kind: "draft", id: draft.id, job_id: job.id, expected_revision: 1, data: { ...draft.data, content: "A changed draft" } });
    assert.equal((await f.user.versions(draft.id))[0].data.content, "Factual draft");
    assert.equal((await f.user.reviews())[0].current, false);
    await assert.rejects(f.user.review(job.id, { ...review, action: "submitted", draft_revision: 2 }), /Approve/);
    await f.user.review(job.id, { ...review, draft_revision: 2 });
    await f.user.review(job.id, { ...review, draft_revision: 2, action: "submitted", confirmation: "User-reported receipt, no independent employer verification" });
    assert.equal((await f.user.reviews())[0].action, "submitted");
  } finally { f.db.close(); }
});
test("export excludes authentication material; deleting a workspace cascades", async () => {
  const f = await fixture();
  try {
    const job = await f.user.save(jobInput());
    const exported = JSON.stringify(await f.user.export());
    assert.ok(exported.includes(jobData.company));
    assert.doesNotMatch(exported, /recovery_hash|public_key|token_hash|epoch/);
    await f.db.prepare("DELETE FROM users WHERE id=?").bind(f.alice).run();
    assert.equal((await f.user.list()).length, 0);
    assert.equal((await f.db.prepare("SELECT count(*) AS n FROM events").first<{ n: number }>())!.n, 0);
  } finally { f.db.close(); }
});
test("only the candidate records outcomes; preparation records cannot smuggle status or owner", async () => {
  const f = await fixture();
  try {
    const job = await f.user.save(jobInput());
    await assert.rejects(f.assistant.outcome(job.id, { status: "accepted", note: "Invented", next_action_at: null }), /Only the candidate/);
    await assert.rejects(f.other.outcome(job.id, { status: "accepted", note: "Invented", next_action_at: null }), /Only the candidate/);
    await f.user.outcome(job.id, { status: "interviewing", note: "Candidate confirmed interview invitation", next_action_at: "2026-11-10T15:00:00Z" });
    assert.equal((await f.user.outcomes())[0].status, "interviewing");
    assert.equal((await f.other.outcomes()).length, 0);
    await assert.rejects(f.assistant.save({ ...jobInput(), data: { ...jobData, stage: "submitted" } }), /Invalid job/);
    await assert.rejects(f.assistant.save({ ...jobInput(), user_id: f.bob } as Parameters<typeof f.assistant.save>[0]));
  } finally { f.db.close(); }
});
test("profile evidence changes make a prior approval stale", async () => {
  const f = await fixture();
  try {
    const p = await f.user.save({ kind: "profile", expected_revision: 0, data: profileData });
    const job = await f.user.save(jobInput());
    const draft = await f.assistant.save({ kind: "draft", job_id: job.id, expected_revision: 0, data: { type: "resume", content: "Factual draft", evidence_ids: ["communication"], unresolved_claims: "" } });
    const review = { action: "approved", draft_id: draft.id, draft_revision: 1, destination: jobData.source_url, confirmation: "Candidate checked this version" };
    await f.user.review(job.id, review);
    await f.user.save({ kind: "profile", id: p.id, expected_revision: 1, data: { ...profileData, goals: "Changed career goals" } });
    assert.equal((await f.user.reviews())[0].current, false);
    await assert.rejects(f.user.review(job.id, review), /profile changed/);
  } finally { f.db.close(); }
});
test("agent cannot delete records; website deletion removes linked records", async () => {
  const f = await fixture();
  try {
    const job = await f.user.save(jobInput());
    await f.user.save({ kind: "draft", job_id: job.id, expected_revision: 0, data: { type: "resume", content: "Draft", evidence_ids: [], unresolved_claims: "" } });
    await assert.rejects(f.assistant.removeRecord(job.id), /candidate/);
    await f.user.removeRecord(job.id);
    assert.equal((await f.user.list()).length, 0);
  } finally { f.db.close(); }
});
test("URLs reject local and credential destinations; streaming body limits apply without Content-Length", async () => {
  for (const url of ["file:///etc/passwd", "https://127.0.0.1/x", "https://[::1]/x", "https://u:p@example.com", "https://corp.internal"]) assert.throws(() => publicJobUrl(url));
  const request = new Request("https://example.com", { method: "POST", body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(100)); controller.close(); } }), duplex: "half" } as RequestInit);
  await assert.rejects(boundedBody(request, 20), (error: unknown) => error instanceof HttpError && error.status === 413);
});
test("database quotas apply atomically and audit history is bounded", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 250; i++) await f.user.save({ ...jobInput(), data: { ...jobData, source_url: `https://example.com/jobs/${i}` } });
    await assert.rejects(f.user.save({ ...jobInput(), data: { ...jobData, source_url: "https://example.com/jobs/over-limit" } }), /Workspace limit/);
    const result = await f.db.prepare("SELECT count(*) AS n FROM events WHERE user_id=?").bind(f.alice).first<{ n: number }>();
    assert.equal(result!.n, 200);
  } finally { f.db.close(); }
});
