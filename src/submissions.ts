import { z } from "zod";
import { hash, HttpError, publicJobUrl } from "./security.ts";
import { WorkspaceStore } from "./store.ts";

export const approvalSchema = z.object({
  job_id: z.string().uuid(), draft_id: z.string().uuid(),
  expected_digest: z.string().regex(/^[a-f0-9]{64}$/),
  confirmation: z.literal("APPROVE MANUAL HANDOFF"),
}).strict();
export type Handoff = {
  id: string; job_id: string; draft_id: string; job_revision: number; draft_revision: number;
  profile_id: string | null; profile_revision: number; destination: string; payload_digest: string;
  approved_at: string; expires_at: string; updated_at: string;
  status: "approved" | "requires_user" | "submitted" | "cancelled" | "expired" | "stale";
  attempt_id: string | null; opened_at: string | null; confirmed_at: string | null; receipt: string | null;
};

/** Website-only, manual final action. This class never fetches employer destinations. */
export class SubmissionStore {
  constructor(readonly workspace: WorkspaceStore) {}
  private candidate() {
    if (this.workspace.actor !== "website") throw new HttpError(403, "Handoffs require the candidate on the website.");
  }
  async snapshot(jobId: string, draftId: string) {
    this.candidate();
    const job = await this.workspace.get(jobId), draft = await this.workspace.get(draftId);
    const profile = (await this.workspace.list("profile"))[0];
    if (job.kind !== "job" || draft.kind !== "draft" || draft.job_id !== job.id) throw new HttpError(409, "Select a draft belonging to this job.");
    if (!profile || draft.data.profile_id !== profile.id || draft.data.profile_revision !== profile.revision)
      throw new HttpError(409, "Save the draft against your current profile before reviewing a handoff.");
    const evidence = profile.data.evidence as { id: string; confirmed: boolean }[];
    if (String(draft.data.unresolved_claims).trim() || (draft.data.evidence_ids as string[]).some(id => !evidence.find(item => item.id === id)?.confirmed))
      throw new HttpError(409, "Resolve draft claims and confirm cited profile evidence before a handoff.");
    const destination = publicJobUrl(String(job.data.source_url));
    const snapshot = { job_id: job.id, job_revision: job.revision, draft_id: draft.id, draft_revision: draft.revision,
      profile_id: profile.id, profile_revision: profile.revision, destination,
      draft_type: String(draft.data.type), content: String(draft.data.content) };
    // Hash the exact records, including posting, evidence, and unresolved claims. No content duplication in D1.
    return { ...snapshot, payload_digest: await hash(JSON.stringify({ snapshot, job: job.data, draft: draft.data, profile: profile.data })) };
  }
  async list(): Promise<Handoff[]> {
    return this.workspace.handoffs();
  }
  async approve(input: unknown): Promise<string> {
    this.candidate();
    const body = approvalSchema.parse(input), snapshot = await this.snapshot(body.job_id, body.draft_id);
    if (snapshot.payload_digest !== body.expected_digest) throw new HttpError(409, "Application changed. Preview and review it again.");
    const { db, userId } = this.workspace;
    await this.list();
    const id = crypto.randomUUID(), now = new Date().toISOString(), expiry = new Date(Date.now() + 15 * 60_000).toISOString();
    // The INSERT checks current revisions atomically. Triggers invalidate subsequent edits.
    try {
      const result = await db.prepare(`INSERT INTO submission_intents
        (id,user_id,job_id,draft_id,job_revision,draft_revision,profile_id,profile_revision,destination,payload_digest,approved_at,expires_at,status,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,'approved',? WHERE
        EXISTS(SELECT 1 FROM records WHERE user_id=? AND id=? AND revision=?) AND
        EXISTS(SELECT 1 FROM records WHERE user_id=? AND id=? AND revision=?) AND
        EXISTS(SELECT 1 FROM records WHERE user_id=? AND id=? AND revision=?) AND
        NOT EXISTS(SELECT 1 FROM reviews WHERE user_id=? AND job_id=? AND action='submitted') AND
        NOT EXISTS(SELECT 1 FROM submission_intents i JOIN submission_attempts a ON a.intent_id=i.id
          WHERE i.user_id=? AND i.job_id=? AND i.status<>'cancelled')`)
        .bind(id, userId, snapshot.job_id, snapshot.draft_id, snapshot.job_revision, snapshot.draft_revision,
          snapshot.profile_id, snapshot.profile_revision, snapshot.destination, snapshot.payload_digest, now, expiry, now,
          userId, snapshot.job_id, snapshot.job_revision, userId, snapshot.draft_id, snapshot.draft_revision,
          userId, snapshot.profile_id, snapshot.profile_revision, userId, snapshot.job_id, userId, snapshot.job_id).run();
      if (!result.meta.changes) throw new HttpError(409, "Records changed or submission already recorded. Review again.");
    } catch (error) {
      if (String(error).includes("UNIQUE")) throw new HttpError(409, "This job already has an active handoff or recorded submission. Inspect it before retrying.");
      if (String(error).includes("history limit")) throw new HttpError(409, "Handoff history limit reached (250). Export and remove old job records before adding more.");
      throw error;
    }
    await this.workspace.event("approve_manual_handoff", snapshot.job_id);
    return id;
  }
  async act(id: string, action: "open" | "cancel" | "confirm", receipt?: string) {
    this.candidate(); z.string().uuid().parse(id);
    const { db, userId } = this.workspace;
    const handoff = (await this.list()).find(item => item.id === id);
    if (!handoff) throw new HttpError(404, "Handoff not found.");
    const now = new Date().toISOString();
    if (action === "cancel") {
      const result = await db.prepare("UPDATE submission_intents SET status='cancelled',updated_at=? WHERE id=? AND user_id=? AND status IN ('approved','requires_user','stale','expired')")
        .bind(now, id, userId).run();
      if (!result.meta.changes) throw new HttpError(409, "Handoff already closed.");
    } else if (action === "open") {
      // A transactional conditional UPDATE plus INSERT makes double clicks/retries single-use.
      const attemptId = crypto.randomUUID();
      const results = await db.batch([
        db.prepare("UPDATE submission_intents SET status='requires_user',updated_at=? WHERE id=? AND user_id=? AND status='approved' AND expires_at>?").bind(now, id, userId, now),
        db.prepare(`INSERT INTO submission_attempts(id,intent_id,opened_at)
          SELECT ?,id,? FROM submission_intents WHERE id=? AND user_id=? AND status='requires_user'
          AND NOT EXISTS(SELECT 1 FROM submission_attempts WHERE intent_id=?)`).bind(attemptId, now, id, userId, id),
      ]);
      if (!z.object({ meta: z.object({ changes: z.number() }) }).parse(results[0]).meta.changes) throw new HttpError(409, "Handoff already opened, expired, or changed. Inspect status; do not repeat an uncertain submission.");
    } else {
      receipt = z.string().trim().min(8).max(500).parse(receipt);
      // User assertion, not independently verified delivery. Keep confirmation even after expiry;
      // opening expiry is a permission deadline, not a deadline to report a real manual result.
      const results = await db.batch([
        db.prepare("UPDATE submission_intents SET status='submitted',updated_at=? WHERE id=? AND user_id=? AND status='requires_user'").bind(now, id, userId),
        db.prepare(`UPDATE submission_attempts SET confirmed_at=?,receipt=? WHERE intent_id=? AND confirmed_at IS NULL
          AND EXISTS(SELECT 1 FROM submission_intents WHERE id=? AND user_id=? AND status='submitted')`).bind(now, receipt, id, id, userId),
      ]);
      if (!z.object({ meta: z.object({ changes: z.number() }) }).parse(results[0]).meta.changes) throw new HttpError(409, "Open the current handoff before recording a submission. Changed records need fresh review.");
    }
    await this.workspace.event(`handoff_${action}`, handoff.job_id);
    return { destination: handoff.destination, status: action === "open" ? "requires_user" : action === "cancel" ? "cancelled" : "submitted" };
  }
}
