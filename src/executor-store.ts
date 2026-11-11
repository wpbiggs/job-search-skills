import { z } from "zod";
import { employerUrl, formSchema, payloadSchema, validatePayload, type ExecutorForm, type ExecutorPayload, type ExecutorResult } from "./executor-contract.ts";
import { boundedBody, hash, HttpError, token } from "./security.ts";
import { WorkspaceStore } from "./store.ts";
import { SubmissionStore } from "./submissions.ts";

export const executorApprovalSchema = z.object({
  job_id: z.string().uuid(), draft_id: z.string().uuid(),
  snapshot_digest: z.string().regex(/^[a-f0-9]{64}$/),
  form: formSchema, payload: payloadSchema,
  confirmation: z.literal("APPROVE EXACT EXECUTOR PAYLOAD"),
}).strict();
export type ExecutorRow = { id: string; job_id: string; draft_id: string; destination: string; status: string; reason: string; created_at: string; expires_at: string; updated_at: string; payload_digest: string; attempt_id: string | null; receipt: string | null };
type Service = { fetch(request: Request): Promise<Response> };

export class ExecutorStore {
  constructor(readonly store: WorkspaceStore, readonly service: Service, readonly allowedHosts: string[], readonly fixtureOrigin: string) {}
  private candidate() { if (this.store.actor !== "website") throw new HttpError(403, "Only the candidate can authorize browser actions on the website."); }
  private async call(input: unknown): Promise<Record<string, unknown>> {
    const response = await this.service.fetch(new Request("https://executor.internal/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }));
    const text = await boundedBody(response, 24000);
    const data = z.record(z.string(), z.unknown()).parse(JSON.parse(text));
    if (!response.ok) throw new HttpError(response.status === 429 ? 429 : 503, "Executor unavailable or browser budget reached. Inspect status; do not retry automatically.");
    return data;
  }
  async inspect(jobId: string) {
    this.candidate();
    if (await this.paused()) throw new HttpError(409, "Executor paused for this account.");
    const job = await this.store.get(z.string().uuid().parse(jobId));
    if (job.kind !== "job") throw new HttpError(400, "Select an owned job.");
    return this.call({ operation: "inspect", destination: employerUrl(String(job.data.source_url), this.allowedHosts) });
  }
  async fixtureCheck() { this.candidate(); if (await this.paused()) throw new HttpError(409, "Executor paused for this account."); return this.call({ operation: "fixture" }); }
  async list(): Promise<ExecutorRow[]> {
    const now = new Date().toISOString();
    await this.store.db.prepare("UPDATE delegated_intents SET status='expired',reason='Opening approval expired.',updated_at=? WHERE user_id=? AND status='approved' AND expires_at<=?").bind(now, this.store.userId, now).run();
    // A crashed invocation is never silently retried. It might have reached the employer.
    await this.store.db.prepare("UPDATE delegated_intents SET status='uncertain',reason='Execution lease expired; reconcile before retrying.',updated_at=? WHERE user_id=? AND status IN ('running','committing') AND expires_at<=?").bind(now, this.store.userId, now).run();
    return (await this.store.db.prepare(`SELECT i.id,i.job_id,i.draft_id,i.destination,i.status,i.reason,i.created_at,i.expires_at,i.updated_at,i.payload_digest,a.id AS attempt_id,a.receipt
      FROM delegated_intents i LEFT JOIN delegated_attempts a ON a.intent_id=i.id WHERE i.user_id=? ORDER BY i.created_at DESC,i.id LIMIT 50`).bind(this.store.userId).all<ExecutorRow>()).results;
  }
  async paused(): Promise<boolean> { return Boolean((await this.store.db.prepare("SELECT paused FROM executor_controls WHERE user_id=?").bind(this.store.userId).first<{paused:number}>())?.paused); }
  async pause(paused: boolean) {
    this.candidate();
    await this.store.db.prepare("INSERT INTO executor_controls(user_id,paused) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET paused=excluded.paused").bind(this.store.userId, paused ? 1 : 0).run();
    await this.store.event(paused ? "executor_pause" : "executor_resume");
  }
  async approve(input: unknown) {
    this.candidate();
    if (await this.paused()) throw new HttpError(409, "Executor paused for this account.");
    const body = executorApprovalSchema.parse(input);
    const snapshot = await new SubmissionStore(this.store).snapshot(body.job_id, body.draft_id);
    if (snapshot.payload_digest !== body.snapshot_digest || snapshot.content !== body.payload.document.content) throw new HttpError(409, "Current document/profile snapshot changed.");
    const destination = employerUrl(body.form.destination, this.allowedHosts);
    employerUrl(body.form.action, this.allowedHosts);
    if (destination !== snapshot.destination || new URL(body.form.action).origin !== new URL(destination).origin) throw new HttpError(409, "Destination does not match the reviewed employer.");
    if (new URL(destination).origin !== this.fixtureOrigin || new URL(destination).pathname !== "/job-search/workspace/executor-fixture") throw new HttpError(409, "Live execution is locked by the current candidate-control contract; employer adapters and final-submission authorization must be reviewed first.");
    const fresh = await this.call({ operation: "inspect", destination });
    const form = formSchema.parse(fresh.form);
    if (form.fingerprint !== body.form.fingerprint || JSON.stringify(form) !== JSON.stringify(body.form)) throw new HttpError(409, "Application form changed; inspect and review it again.");
    await validatePayload(form, body.payload);
    const id = crypto.randomUUID(), now = new Date().toISOString(), expiry = new Date(Date.now() + 15 * 60000).toISOString();
    const payload = JSON.stringify(body.payload), digest = await hash(payload);
    try {
      const result = await this.store.db.prepare(`INSERT INTO delegated_intents(id,user_id,job_id,draft_id,profile_id,job_revision,draft_revision,profile_revision,destination,snapshot_digest,payload_digest,form,payload,status,created_at,expires_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,'approved',?,?,? WHERE
        EXISTS(SELECT 1 FROM records WHERE id=? AND user_id=? AND revision=?) AND
        EXISTS(SELECT 1 FROM records WHERE id=? AND user_id=? AND revision=?) AND
        EXISTS(SELECT 1 FROM records WHERE id=? AND user_id=? AND revision=?) AND
        NOT EXISTS(SELECT 1 FROM delegated_intents i JOIN delegated_attempts a ON a.intent_id=i.id WHERE i.user_id=? AND i.job_id=? AND i.status IN ('running','committing','uncertain','fixture_verified'))`)
        .bind(id, this.store.userId, snapshot.job_id, snapshot.draft_id, snapshot.profile_id, snapshot.job_revision, snapshot.draft_revision, snapshot.profile_revision, destination, snapshot.payload_digest, digest, JSON.stringify(form), payload, now, expiry, now,
          snapshot.job_id, this.store.userId, snapshot.job_revision, snapshot.draft_id, this.store.userId, snapshot.draft_revision, snapshot.profile_id, this.store.userId, snapshot.profile_revision, this.store.userId, snapshot.job_id).run();
      if (!result.meta.changes) throw new HttpError(409, "Records changed or an existing attempt needs reconciliation.");
    } catch (error) {
      if (String(error).includes("UNIQUE")) throw new HttpError(409, "An active application already exists.");
      if (String(error).includes("storage limit")) throw new HttpError(413, "Executor history limit reached (50 intents / 1 MiB payloads). Export and delete old owned records deliberately.");
      throw error;
    }
    await this.store.event("executor_approve", snapshot.job_id);
    return { id, payload_digest: digest, expires_at: expiry };
  }
  async cancel(id: string) {
    this.candidate(); z.string().uuid().parse(id);
    const result = await this.store.db.prepare("UPDATE delegated_intents SET status='cancelled',reason='Candidate cancelled before final network commit.',updated_at=? WHERE id=? AND user_id=? AND status IN ('approved','running')").bind(new Date().toISOString(), id, this.store.userId).run();
    if (!result.meta.changes) throw new HttpError(409, "Cannot cancel a closed, unknown, or committing attempt. Check status; cancellation cannot withdraw an application.");
    await this.store.event("executor_cancel");
  }
  async run(id: string) {
    this.candidate(); z.string().uuid().parse(id);
    await this.list();
    const nonce = token(), now = new Date().toISOString(), nonceHash = await hash(nonce);
    // One conditional UPDATE is the lease. One-attempt UNIQUE plus transactional batch prevents concurrent execution.
    const results = await this.store.db.batch([
      this.store.db.prepare(`UPDATE delegated_intents SET status='running',nonce_hash=?,updated_at=? WHERE id=? AND user_id=? AND status='approved' AND expires_at>?
        AND NOT EXISTS(SELECT 1 FROM executor_controls WHERE user_id=? AND paused=1)
        AND NOT EXISTS(SELECT 1 FROM delegated_intents WHERE user_id=? AND status IN ('running','committing'))
        AND (SELECT count(*) FROM delegated_attempts a JOIN delegated_intents i ON i.id=a.intent_id WHERE i.user_id=? AND a.started_at>=?)<5`)
        .bind(nonceHash, now, id, this.store.userId, now, this.store.userId, this.store.userId, this.store.userId, now.slice(0, 10)),
      this.store.db.prepare("INSERT INTO delegated_attempts(id,intent_id,started_at) SELECT ?,id,? FROM delegated_intents WHERE id=? AND user_id=? AND status='running' AND nonce_hash=? AND NOT EXISTS(SELECT 1 FROM delegated_attempts WHERE intent_id=?)")
        .bind(crypto.randomUUID(), now, id, this.store.userId, nonceHash, id),
    ]);
    if (!z.object({meta:z.object({changes:z.number()})}).parse(results[0]).meta.changes) throw new HttpError(409, "Unapproved, expired, paused, repeated, concurrent or over-quota attempt. No retry.");
    let result: ExecutorResult;
    try {
      const data = await this.call({ operation: "run", id, user_id: this.store.userId, nonce });
      result = z.object({ status: z.enum(["needs_user","fixture_verified","failed","uncertain"]), reason: z.string().max(500), receipt: z.object({ id: z.string().regex(/^fixture-[a-f0-9]{64}$/), response_digest: z.string().regex(/^[a-f0-9]{64}$/), received_at: z.iso.datetime(), synthetic: z.literal(true) }).strict().optional() }).strict().parse(data);
      if (result.status === "fixture_verified" && !result.receipt) throw new Error("Missing fixture receipt");
    } catch { result = { status: "uncertain", reason: "Executor interrupted. Reconcile before any retry; no real submission is claimed." }; }
    const finished = new Date().toISOString();
    await this.store.db.batch([
      this.store.db.prepare("UPDATE delegated_intents SET status=?,reason=?,updated_at=? WHERE id=? AND user_id=? AND nonce_hash=? AND status IN ('running','committing')").bind(result.status, result.reason, finished, id, this.store.userId, nonceHash),
      this.store.db.prepare("UPDATE delegated_attempts SET finished_at=?,receipt=? WHERE intent_id=?").bind(finished, result.receipt ? JSON.stringify(result.receipt) : null, id),
    ]);
    await this.store.event("executor_finished");
    return result;
  }
}
