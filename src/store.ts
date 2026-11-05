import { z } from "zod";
import { HttpError, publicJobUrl } from "./security.ts";

export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes?: number } }>;
}
export interface SqlDatabase { prepare(query: string): Statement; batch(statements: Statement[]): Promise<unknown[]> }
export const kindSchema = z.enum(["profile", "job", "assessment", "draft", "interview", "run"]);
export type Kind = z.infer<typeof kindSchema>;
const text = (max: number) => z.string().trim().max(max);
const identity = z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/);
export const profileSchema = z.object({
  goals: text(6000), preferences: text(6000), constraints: text(6000),
  evidence: z.array(z.object({ id: identity, claim: text(3000).min(1), source: text(1000).min(1), confirmed: z.boolean().default(false) }).strict()).max(60),
}).strict();
export const jobSchema = z.object({
  company: text(160).min(1), title: text(180).min(1), source_url: text(2048).min(1),
  location: text(500), compensation: text(500), posting: text(45000).min(1), checked_at: z.iso.datetime(),
  requisition_id: text(200).default(""), stage: z.enum(["discovered", "shortlisted", "drafting", "ready"]).default("discovered"),
}).strict();
export const assessmentSchema = z.object({
  profile_id: z.string().uuid().nullable().optional(),
  profile_revision: z.number().int().nonnegative().optional(),
  recommendation: z.enum(["pursue", "clarify", "pass"]), reasons: text(6000).min(1), constraints: text(6000), gaps: text(6000), unknowns: text(6000),
  requirements: z.array(z.object({ requirement: text(1000).min(1), posting_quote: text(2000).min(1), evidence_ids: z.array(identity).max(30), support: z.enum(["direct", "transferable", "missing", "unknown"]) }).strict()).max(40),
}).strict();
export const draftSchema = z.object({
  profile_id: z.string().uuid().nullable().optional(),
  profile_revision: z.number().int().nonnegative().optional(),
  type: z.enum(["resume", "cover_letter", "screening_answers"]), content: text(40000).min(1),
  evidence_ids: z.array(identity).max(60), unresolved_claims: text(6000),
}).strict();
export const interviewSchema = z.object({ profile_id: z.string().uuid().nullable().optional(), profile_revision: z.number().int().nonnegative().optional(), content: text(45000).min(1), evidence_ids: z.array(identity).max(60), unknowns: text(6000) }).strict();
export const runSchema = z.object({
  run_key: identity, status: z.enum(["running", "completed", "failed"]), summary: text(6000),
  source_urls: z.array(text(2048)).max(40), started_at: z.iso.datetime(), finished_at: z.iso.datetime().nullable(),
}).strict();
export const saveSchema = z.object({
  kind: kindSchema, id: z.string().uuid().optional(), job_id: z.string().uuid().optional(),
  expected_revision: z.number().int().min(0), data: z.unknown(),
}).strict();
export type SaveInput = z.infer<typeof saveSchema>;
export type RecordRow = { id: string; kind: Kind; job_id: string | null; data: Record<string, unknown>; revision: number; created_at: string; updated_at: string };
type RawRecord = Omit<RecordRow, "data"> & { data: string };
export type Actor = "website" | "assistant";

function parseData(kind: Kind, input: unknown): Record<string, unknown> {
  const schemas = { profile: profileSchema, job: jobSchema, assessment: assessmentSchema, draft: draftSchema, interview: interviewSchema, run: runSchema };
  const parsed = schemas[kind].safeParse(input);
  if (!parsed.success) throw new HttpError(400, `Invalid ${kind} fields: ${parsed.error.issues.slice(0, 4).map(x => x.path.join(".")).join(", ")}`);
  return parsed.data;
}

export class WorkspaceStore {
  constructor(readonly db: SqlDatabase, readonly userId: string, readonly actor: Actor) {}
  async list(kind?: Kind): Promise<RecordRow[]> {
    const query = `SELECT id,kind,job_id,data,revision,created_at,updated_at FROM records WHERE user_id=?${kind ? " AND kind=?" : ""} ORDER BY created_at DESC,id LIMIT 250`;
    const statement = this.db.prepare(query).bind(this.userId, ...(kind ? [kind] : []));
    return (await statement.all<RawRecord>()).results.map(row => ({ ...row, data: JSON.parse(row.data) }));
  }
  async get(id: string): Promise<RecordRow> {
    const row = await this.db.prepare("SELECT id,kind,job_id,data,revision,created_at,updated_at FROM records WHERE user_id=? AND id=?").bind(this.userId, id).first<RawRecord>();
    if (!row) throw new HttpError(404, "Record not found.");
    return { ...row, data: JSON.parse(row.data) };
  }
  async versions(id: string): Promise<{ revision: number; data: Record<string, unknown>; saved_at: string }[]> {
    await this.get(id);
    const rows = (await this.db.prepare("SELECT revision,data,saved_at FROM record_versions WHERE user_id=? AND record_id=? ORDER BY revision DESC").bind(this.userId, id).all<{ revision: number; data: string; saved_at: string }>()).results;
    return rows.map(row => ({ ...row, data: JSON.parse(row.data) }));
  }
  async usage(): Promise<{ records: number; current_bytes: number; history_bytes: number; historical_versions: number; total_bytes: number; record_limit: number; byte_limit: number }> {
    const row = await this.db.prepare(`SELECT
      (SELECT count(*) FROM records WHERE user_id=?) AS records,
      (SELECT coalesce(sum(length(CAST(data AS BLOB))),0) FROM records WHERE user_id=?) AS current_bytes,
      (SELECT coalesce(sum(length(CAST(data AS BLOB))),0) FROM record_versions WHERE user_id=?) AS history_bytes,
      (SELECT count(*) FROM record_versions WHERE user_id=?) AS historical_versions`).bind(this.userId, this.userId, this.userId, this.userId).first<{ records: number; current_bytes: number; history_bytes: number; historical_versions: number }>();
    if (!row) throw new HttpError(503, "Storage usage unavailable.");
    return { ...row, total_bytes: row.current_bytes + row.history_bytes, record_limit: 250, byte_limit: 2097152 };
  }
  async save(input: SaveInput): Promise<RecordRow> {
    input = saveSchema.parse(input);
    const data = parseData(input.kind, input.data);
    let existing: RecordRow | undefined;
    if (input.id) existing = await this.get(input.id);
    if (existing && (existing.kind !== input.kind || existing.job_id !== (input.job_id ?? null))) throw new HttpError(400, "Record kind and job cannot change.");
    if ((existing?.revision ?? 0) !== input.expected_revision) throw new HttpError(409, "This record changed. Read it again before saving.");
    const jobLinked = ["assessment", "draft", "interview"].includes(input.kind);
    if (jobLinked !== Boolean(input.job_id)) throw new HttpError(400, "Assessments, drafts, and interview notes require an owned job; other records cannot link one.");
    if (input.job_id && (await this.get(input.job_id)).kind !== "job") throw new HttpError(400, "Select a job record.");
    let fingerprint: string | null = null;
    if (input.kind === "job") {
      data.source_url = publicJobUrl(data.source_url as string);
      if (existing && (existing.data.source_url !== data.source_url || existing.data.posting !== data.posting)) throw new HttpError(409, "The captured posting and source URL are immutable. Save a distinct requisition or delete and recapture after review.");
      fingerprint = `${String(data.company).normalize("NFKC").trim().toLowerCase()}|${data.source_url}`;
    }
    if (input.kind === "profile") {
      fingerprint = "profile";
      const evidence = data.evidence as z.infer<typeof profileSchema>["evidence"];
      if (new Set(evidence.map(x => x.id)).size !== evidence.length) throw new HttpError(400, "Evidence IDs must be unique.");
      if (this.actor === "assistant") {
        const old = (existing?.data.evidence ?? []) as typeof evidence;
        for (const item of evidence) item.confirmed = Boolean(old.find(x => x.id === item.id && x.claim === item.claim && x.source === item.source && x.confirmed));
      }
    }
    if (input.kind === "run") {
      fingerprint = data.run_key as string;
      data.source_urls = (data.source_urls as string[]).map(publicJobUrl);
    }
    if (["assessment", "draft", "interview"].includes(input.kind)) {
      const profile = (await this.list("profile"))[0];
      data.profile_id = profile?.id ?? null;
      data.profile_revision = profile?.revision ?? 0;
      const ids = new Set(((profile?.data.evidence ?? []) as { id: string }[]).map(x => x.id));
      const cited = input.kind === "assessment" ? (data.requirements as { evidence_ids: string[] }[]).flatMap(x => x.evidence_ids) : data.evidence_ids as string[];
      if (cited.some(id => !ids.has(id))) throw new HttpError(400, "An evidence reference is missing from your profile.");
      if (input.kind === "assessment") {
        const job = await this.get(input.job_id!);
        if ((data.requirements as { posting_quote: string }[]).some(x => !String(job.data.posting).includes(x.posting_quote))) throw new HttpError(400, "Requirement quotes must occur verbatim in the saved posting.");
      }
    }
    const id = existing?.id ?? crypto.randomUUID(), timestamp = new Date().toISOString();
    const payload = JSON.stringify(data);
    if (new TextEncoder().encode(payload).length > 65536) throw new HttpError(413, "Record exceeds the 64 KiB limit.");
    try {
      const statement = existing
        ? this.db.prepare("UPDATE records SET data=?,fingerprint=?,revision=revision+1,updated_at=? WHERE id=? AND user_id=? AND revision=? RETURNING id").bind(payload, fingerprint, timestamp, id, this.userId, input.expected_revision)
        : this.db.prepare("INSERT INTO records(id,user_id,kind,job_id,fingerprint,data,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?) RETURNING id").bind(id, this.userId, input.kind, input.job_id ?? null, fingerprint, payload, timestamp, timestamp);
      const saved = await statement.first<{ id: string }>();
      if (!saved) throw new HttpError(409, "Concurrent edit. Read the record again.");
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const message = String(error);
      if (message.includes("UNIQUE")) throw new HttpError(409, "Already saved. Retrieve and update the existing record instead.");
      if (message.includes("limit")) throw new HttpError(413, "Workspace limit reached (250 records / 2 MiB). Export or delete records before adding more.");
      throw error;
    }
    await this.event("save", id);
    return this.get(id);
  }
  async event(action: string, recordId?: string): Promise<void> {
    await this.db.batch([
      this.db.prepare("INSERT INTO events(id,user_id,actor,action,record_id,created_at) VALUES(?,?,?,?,?,?)").bind(crypto.randomUUID(), this.userId, this.actor, action, recordId ?? null, new Date().toISOString()),
      this.db.prepare("DELETE FROM events WHERE user_id=? AND id NOT IN (SELECT id FROM events WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 200)").bind(this.userId, this.userId),
    ]);
  }
  async reviews(): Promise<Record<string, unknown>[]> {
    const reviews = (await this.db.prepare("SELECT job_id,action,draft_id,draft_revision,destination,confirmation,updated_at FROM reviews WHERE user_id=?").bind(this.userId).all<Record<string, unknown>>()).results;
    const records = await this.list();
    const profile = records.find(record => record.kind === "profile");
    return reviews.map(review => ({ ...review, current: records.some(record => record.id === review.draft_id && record.revision === review.draft_revision && record.data.profile_revision === (profile?.revision ?? 0) && (record.data.profile_id ?? null) === (profile?.id ?? null)) && records.some(record => record.id === review.job_id && record.data.source_url === review.destination) }));
  }
  async outcomes(): Promise<Record<string, unknown>[]> {
    return (await this.db.prepare("SELECT job_id,status,note,next_action_at,updated_at FROM outcomes WHERE user_id=?").bind(this.userId).all()).results;
  }
  async outcome(jobId: string, input: unknown): Promise<void> {
    if (this.actor !== "website") throw new HttpError(403, "Only the candidate can confirm an outcome on the website.");
    const body = z.object({ status: z.enum(["interviewing", "offered", "accepted", "rejected", "withdrawn", "closed"]), note: z.string().trim().min(1).max(2000), next_action_at: z.iso.datetime().nullable() }).strict().parse(input);
    if ((await this.get(jobId)).kind !== "job") throw new HttpError(400, "Select an owned job.");
    await this.db.prepare("INSERT INTO outcomes(job_id,user_id,status,note,next_action_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET status=excluded.status,note=excluded.note,next_action_at=excluded.next_action_at,updated_at=excluded.updated_at").bind(jobId, this.userId, body.status, body.note, body.next_action_at, new Date().toISOString()).run();
    await this.event(`outcome_${body.status}`, jobId);
  }
  async review(jobId: string, input: unknown): Promise<void> {
    if (this.actor !== "website") throw new HttpError(403, "Only the candidate can review on the website.");
    const body = z.object({ action: z.enum(["approved", "submitted", "withdrawn", "rejected"]), draft_id: z.string().uuid(), draft_revision: z.number().int().positive(), destination: z.string().max(2048), confirmation: z.string().trim().min(8).max(2000) }).strict().parse(input);
    const job = await this.get(jobId), draft = await this.get(body.draft_id);
    if (job.kind !== "job" || draft.kind !== "draft" || draft.job_id !== jobId || draft.revision !== body.draft_revision || body.destination !== job.data.source_url) throw new HttpError(409, "Review the current draft and exact destination first.");
    const profile = (await this.list("profile"))[0];
    if (draft.data.profile_revision !== (profile?.revision ?? 0) || (draft.data.profile_id ?? null) !== (profile?.id ?? null)) throw new HttpError(409, "Your profile changed. Recheck the draft against current evidence and save a new version before approval.");
    if (body.action === "submitted") {
      const approved = await this.db.prepare("SELECT action,draft_id,draft_revision FROM reviews WHERE user_id=? AND job_id=?").bind(this.userId, jobId).first<{ action: string; draft_id: string; draft_revision: number }>();
      if (approved?.action !== "approved" || approved.draft_id !== draft.id || approved.draft_revision !== draft.revision) throw new HttpError(409, "Approve the current draft before recording your submission.");
    }
    const result = await this.db.prepare(`INSERT INTO reviews(job_id,user_id,action,draft_id,draft_revision,destination,confirmation,updated_at)
      SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM records WHERE id=? AND user_id=? AND revision=?)
      AND ((? IS NULL AND NOT EXISTS(SELECT 1 FROM records WHERE user_id=? AND kind='profile'))
        OR EXISTS(SELECT 1 FROM records WHERE user_id=? AND kind='profile' AND id=? AND revision=?))
      ON CONFLICT(job_id) DO UPDATE SET action=excluded.action,draft_id=excluded.draft_id,draft_revision=excluded.draft_revision,destination=excluded.destination,confirmation=excluded.confirmation,updated_at=excluded.updated_at RETURNING job_id`).bind(jobId, this.userId, body.action, draft.id, draft.revision, body.destination, body.confirmation, new Date().toISOString(), draft.id, this.userId, draft.revision, profile?.id ?? null, this.userId, this.userId, profile?.id ?? null, profile?.revision ?? 0).first();
    if (!result) throw new HttpError(409, "Draft or profile changed during review. Review again.");
    await this.event(body.action, jobId);
  }
  async removeRecord(id: string, expectedRevision: number): Promise<void> {
    if (this.actor !== "website") throw new HttpError(403, "Deletion requires the candidate on the website.");
    const record = await this.get(id);
    if (record.revision !== expectedRevision) throw new HttpError(409, "Record changed. Refresh and review before deleting.");
    const result = await this.db.batch([
      this.db.prepare("DELETE FROM reviews WHERE user_id=? AND (job_id=? OR draft_id=?) AND EXISTS(SELECT 1 FROM records WHERE user_id=? AND id=? AND revision=?)").bind(this.userId, id, id, this.userId, id, expectedRevision),
      this.db.prepare("DELETE FROM records WHERE user_id=? AND job_id=? AND EXISTS(SELECT 1 FROM records WHERE user_id=? AND id=? AND revision=?)").bind(this.userId, id, this.userId, id, expectedRevision),
      this.db.prepare("DELETE FROM records WHERE user_id=? AND id=? AND revision=?").bind(this.userId, id, expectedRevision),
    ]);
    // D1 includes cascading history deletions in changes; Node SQLite reports the parent alone.
    if (z.object({ meta: z.object({ changes: z.number() }) }).parse(result[2]).meta.changes < 1) throw new HttpError(409, "Record changed. Refresh and review before deleting.");
    await this.event("delete_record", id);
  }
  async export(): Promise<Record<string, unknown>> {
    const account = await this.db.prepare("SELECT name,created_at FROM users WHERE id=?").bind(this.userId).first();
    const events = await this.events();
    const versions = (await this.db.prepare("SELECT record_id,revision,data,saved_at FROM record_versions WHERE user_id=? ORDER BY record_id,revision").bind(this.userId).all<{ record_id: string; revision: number; data: string; saved_at: string }>()).results.map(row => ({ ...row, data: JSON.parse(row.data) }));
    return { format: "job-search-workspace", version: 1, exported_at: new Date().toISOString(), account, records: await this.list(), versions, reviews: await this.reviews(), outcomes: await this.outcomes(), events };
  }
  async events(): Promise<Record<string, unknown>[]> {
    return (await this.db.prepare("SELECT actor,action,record_id,created_at FROM events WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 200").bind(this.userId).all()).results;
  }
}
