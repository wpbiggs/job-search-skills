import { z } from "zod";
import { packageInputSchema, buildApplicationPackage, type ApplicationPackage } from "./application-package.ts";
import { greenhouseInspectionSchema } from "./employer-greenhouse.ts";
import { HttpError } from "./security.ts";
import { SubmissionStore } from "./submissions.ts";
import type { WorkspaceStore } from "./store.ts";

export type PackageSummary = { id: string; job_id: string; status: "approved" | "stale" | "expired" | "cancelled"; digest: string; approved_at: string; expires_at: string; updated_at: string; approval_scope: "ordinary-data-and-documents-only"; execution_enabled: false };
export const packageApprovalSchema = z.object({ input: packageInputSchema, expected_digest: z.string().regex(/^[a-f0-9]{64}$/), confirmation: z.literal("APPROVE EXACT PREPARATION PACKAGE") }).strict();
type Inspect = (jobId: string) => Promise<Record<string, unknown>>;

export class ApplicationPackageStore {
  constructor(readonly store: WorkspaceStore, readonly inspect: Inspect) {}
  private candidate() { if (this.store.actor !== "website") throw new HttpError(403, "Only the candidate on the website can review or approve an exact package."); }
  async preview(input: unknown): Promise<ApplicationPackage> {
    this.candidate();
    const parsed = packageInputSchema.parse(input);
    const job = await this.store.get(parsed.job_id);
    if (job.kind !== "job") throw new HttpError(409, "Choose an owned job.");
    const inspectionResult = await this.inspect(job.id);
    const checked = greenhouseInspectionSchema.safeParse(inspectionResult.inspection);
    if (!checked.success) throw new HttpError(409, "A fresh supported employer inspection is required before package review.");
    const inspectedAt = Date.parse(checked.data.checked_at);
    if (inspectedAt < Date.now() - 60000 || inspectedAt > Date.now() + 5000) throw new HttpError(409, "Employer inspection is stale or future-dated. Inspect again before package review.");
    if (checked.data.destination !== job.data.source_url) throw new HttpError(409, "Employer destination changed. Review the saved job.");
    const snapshots = await Promise.all(parsed.documents.map(document => new SubmissionStore(this.store).snapshot(job.id, document.draft_id)));
    if (snapshots.some(snapshot => snapshot.job_revision !== job.revision)) throw new HttpError(409, "Saved job changed during package review.");
    return buildApplicationPackage(parsed, checked.data, snapshots);
  }
  async list(): Promise<PackageSummary[]> {
    return this.store.packageApprovals();
  }
  async get(id: string) {
    this.candidate(); z.string().uuid().parse(id); await this.list();
    const row = await this.store.db.prepare("SELECT id,job_id,status,digest,approved_at,expires_at,updated_at,package FROM application_packages WHERE id=? AND user_id=?")
      .bind(id, this.store.userId).first<Omit<PackageSummary, "approval_scope" | "execution_enabled"> & { package: string }>();
    if (!row) throw new HttpError(404, "Application package not found.");
    return { ...row, approval_scope: "ordinary-data-and-documents-only" as const, execution_enabled: false as const, package: JSON.parse(row.package) as ApplicationPackage };
  }
  async approve(input: unknown) {
    this.candidate();
    const parsed = packageApprovalSchema.parse(input);
    const exact = await this.preview(parsed.input); // Fresh provider and saved-document binding, never trusting a client-supplied package.
    if (exact.package_digest !== parsed.expected_digest) throw new HttpError(409, "Exact application package changed. Preview and review it again.");
    await this.list();
    const id = crypto.randomUUID(), now = new Date().toISOString(), expires = new Date(Date.now() + 15 * 60000).toISOString();
    const documents = JSON.stringify(exact.documents.map(item => ({ id: item.draft_id, revision: item.draft_revision })));
    try {
      const statements = [this.store.db.prepare(`INSERT INTO application_packages(id,user_id,job_id,profile_id,job_revision,profile_revision,digest,package,status,approved_at,expires_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,'approved',?,?,? WHERE
        EXISTS(SELECT 1 FROM records WHERE id=? AND user_id=? AND kind='job' AND revision=?) AND
        EXISTS(SELECT 1 FROM records WHERE id=? AND user_id=? AND kind='profile' AND revision=?) AND
        NOT EXISTS(SELECT 1 FROM json_each(?) d WHERE NOT EXISTS(SELECT 1 FROM records r WHERE r.id=json_extract(d.value,'$.id') AND r.user_id=? AND r.job_id=? AND r.kind='draft' AND r.revision=json_extract(d.value,'$.revision'))) AND
        NOT EXISTS(SELECT 1 FROM executor_controls WHERE user_id=? AND paused=1) AND
        NOT EXISTS(SELECT 1 FROM reviews WHERE user_id=? AND job_id=? AND action='submitted') AND
        NOT EXISTS(SELECT 1 FROM outcomes WHERE user_id=? AND job_id=?) AND
        NOT EXISTS(SELECT 1 FROM submission_intents i JOIN submission_attempts a ON a.intent_id=i.id WHERE i.user_id=? AND i.job_id=?) AND
        NOT EXISTS(SELECT 1 FROM delegated_intents i JOIN delegated_attempts a ON a.intent_id=i.id WHERE i.user_id=? AND i.job_id=?)`)
        .bind(id, this.store.userId, exact.job_id, exact.profile_id, exact.job_revision, exact.profile_revision, exact.package_digest, JSON.stringify(exact), now, expires, now,
          exact.job_id, this.store.userId, exact.job_revision, exact.profile_id, this.store.userId, exact.profile_revision,
          documents, this.store.userId, exact.job_id, this.store.userId, this.store.userId, exact.job_id, this.store.userId, exact.job_id, this.store.userId, exact.job_id, this.store.userId, exact.job_id)];
      for (const document of exact.documents) statements.push(this.store.db.prepare("INSERT INTO application_package_documents(package_id,draft_id,draft_revision) SELECT id,?,? FROM application_packages WHERE id=? AND user_id=?")
        .bind(document.draft_id, document.draft_revision, id, this.store.userId));
      const result = await this.store.db.batch(statements);
      if (!z.object({ meta: z.object({ changes: z.number() }) }).parse(result[0]).meta.changes) throw new HttpError(409, "Records changed, executor paused, or an existing employer outcome/attempt needs reconciliation. No package approved.");
    } catch (error) {
      if (String(error).includes("UNIQUE")) throw new HttpError(409, "An approved package already exists for this job. Review or cancel it before replacing it.");
      if (String(error).includes("package storage limit")) throw new HttpError(413, "Package history limit reached (50 packages / 1 MiB). Export and deliberately erase old linked preparation before adding more.");
      throw error;
    }
    await this.store.event("approve_exact_package", exact.job_id);
    return { id, digest: exact.package_digest, expires_at: expires, execution_enabled: false, pending_steps: exact.pending_steps };
  }
  async cancel(id: string) {
    this.candidate(); z.string().uuid().parse(id);
    const result = await this.store.db.prepare("UPDATE application_packages SET status='cancelled',updated_at=? WHERE id=? AND user_id=? AND status IN ('approved','stale','expired')")
      .bind(new Date().toISOString(), id, this.store.userId).run();
    if (!result.meta.changes) throw new HttpError(404, "Open package not found.");
    await this.store.event("cancel_exact_package");
  }
  async revalidate(id: string) {
    this.candidate();
    const saved = await this.get(id);
    if (saved.status !== "approved") return { id, status: saved.status, snapshot_current: false, execution_enabled: false };
    const exact = saved.package;
    try {
      const fresh = await this.preview({ job_id: exact.job_id, inspection_fingerprint: exact.inspection_fingerprint,
        answers: exact.answers.map(item => ({ question_id: item.question_id, field_name: item.field_name, value: item.value })),
        documents: exact.documents.map(item => ({ question_id: item.question_id, field_name: item.field_name, draft_id: item.draft_id })),
        skips: exact.skips.map(item => item.question_id), deferred: exact.deferred.map(item => item.question_id) });
      if (fresh.package_digest !== saved.digest) throw new HttpError(409, "Package source changed.");
      const now = new Date().toISOString();
      const result = await this.store.db.prepare("UPDATE application_packages SET updated_at=? WHERE id=? AND user_id=? AND status='approved' AND digest=? AND expires_at>? AND NOT EXISTS(SELECT 1 FROM executor_controls WHERE user_id=? AND paused=1) RETURNING id")
        .bind(now, id, this.store.userId, saved.digest, now, this.store.userId).first();
      const current = await this.get(id);
      return { id, status: current.status, snapshot_current: Boolean(result) && current.status === "approved", checked_at: now, execution_enabled: false, pending_steps: exact.pending_steps };
    } catch (error) {
      if (error instanceof HttpError && [400, 404, 409, 413].includes(error.status)) {
        await this.store.db.prepare("UPDATE application_packages SET status='stale',updated_at=? WHERE id=? AND user_id=? AND status='approved' AND digest=?")
          .bind(new Date().toISOString(), id, this.store.userId, saved.digest).run();
      }
      return { id, status: (await this.get(id)).status, snapshot_current: false, execution_enabled: false, reason: "Package sources could not be confirmed current. No employer action occurred; review before any future use." };
    }
  }
}
