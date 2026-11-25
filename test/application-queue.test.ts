import test from "node:test";
import assert from "node:assert/strict";
import { applicationQueue, postingNeedsRecheck } from "../src/application-queue.ts";
import { applicationsView } from "../src/web/applications.ts";
import type { RecordRow } from "../src/store.ts";
import type { Handoff } from "../src/submissions.ts";

const now = Date.parse("2026-11-25T12:00:00Z");
function record(kind: RecordRow["kind"], data: Record<string, unknown>, job_id: string | null = null): RecordRow {
  return { id: kind, kind, job_id, data, revision: 1, created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() };
}
function fixture() {
  const profile = record("profile", { evidence: [{ id: "writing", confirmed: true }] });
  const job = record("job", { company: "Fictional only", title: "Writer", checked_at: new Date(now).toISOString() });
  const draft = record("draft", { profile_id: profile.id, profile_revision: 1, evidence_ids: ["writing"], unresolved_claims: "", content: "Fictional draft" }, job.id);
  const state: Parameters<typeof applicationQueue>[0] = { records: [profile, job, draft], handoffs: [], reviews: [], outcomes: [] };
  return { profile, job, draft, state, label: () => applicationQueue(state, now)[0].label };
}
function handoff(status: Handoff["status"], attempted = false): Handoff {
  return { id: "handoff", job_id: "job", draft_id: "draft", job_revision: 1, draft_revision: 1, profile_id: "profile", profile_revision: 1, destination: "https://example.com/job", payload_digest: "0".repeat(64), approved_at: new Date(now).toISOString(), expires_at: new Date(now + 60000).toISOString(), updated_at: new Date(now).toISOString(), status, attempt_id: attempted ? "attempt" : null, opened_at: attempted ? new Date(now).toISOString() : null, confirmed_at: null, receipt: null };
}

test("application queue distinguishes missing, stale and unconfirmed preparation", () => {
  const f = fixture();
  assert.equal(f.label(), "Review materials");
  f.draft.data.unresolved_claims = "Unverified employment dates";
  assert.equal(f.label(), "Resolve evidence");
  f.draft.data.unresolved_claims = "";
  f.profile.data.evidence = [{ id: "writing", confirmed: false }];
  assert.equal(f.label(), "Resolve evidence");
  f.profile.revision = 2;
  assert.equal(f.label(), "Refresh materials");
  f.state.records = [f.profile, f.job];
  assert.equal(f.label(), "Prepare materials");
  f.state.records = [f.job];
  assert.equal(f.label(), "Set up profile");
  assert.deepEqual(applicationQueue({ ...f.state, records: [] }, now), []);
});
test("opened and even cancelled/changed handoffs require outcome reconciliation, never automatic retry", () => {
  for (const status of ["requires_user", "stale", "expired", "cancelled"] as const) {
    const f = fixture(); f.state.handoffs = [handoff(status, true)];
    assert.equal(f.label(), "Check employer outcome");
    assert.equal(applicationQueue(f.state, now)[0].reviewable, false);
  }
  const f = fixture(); f.state.handoffs = [handoff("approved")];
  assert.equal(f.label(), "Handoff approved");
  f.state.handoffs[0].expires_at = new Date(now - 1).toISOString();
  assert.equal(f.label(), "Review materials");
});
test("candidate submission history and outcomes always take precedence over readiness", () => {
  const f = fixture(); f.state.reviews = [{ job_id: "job", action: "submitted" }];
  assert.equal(f.label(), "Submission recorded");
  f.state.reviews = []; f.state.handoffs = [handoff("submitted", true)];
  assert.equal(f.label(), "Submission recorded");
  f.state.handoffs = []; f.state.outcomes = [{ job_id: "job", status: "closed" }];
  assert.equal(f.label(), "Outcome recorded");
});
test("posting age warnings never claim that a recent posting is live", () => {
  for (const date of [undefined, "invalid", "2026-11-11T12:00:00Z", "2026-12-01T12:00:00Z"]) assert.equal(postingNeedsRecheck(date, now), true);
  assert.equal(postingNeedsRecheck(new Date(now).toISOString(), now), false);
  assert.equal(postingNeedsRecheck(new Date(now - 7 * 86400000).toISOString(), now), false);
});
test("queue escapes stored content and never creates employer navigation or submission actions", () => {
  const f = fixture(); f.job.data.company = '<img src="https://example.com/leak">';
  const html = applicationsView(f.state);
  assert.doesNotMatch(html, /<img|href=|data-handoff-open|data-review=/);
  assert.match(html, /&lt;img/);
  assert.match(html, /No autonomous employer submission is enabled/);
  assert.match(applicationsView({ ...f.state, records: [] }), /Shared-chat reports are not imported automatically/);
});
