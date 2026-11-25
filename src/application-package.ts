import { z } from "zod";
import { greenhouseTarget, type GreenhouseInspection, type EmployerQuestion } from "./employer-greenhouse.ts";
import { hash, HttpError, publicJobUrl } from "./security.ts";
import type { SubmissionStore } from "./submissions.ts";

const questionId = z.string().min(1).max(100);
export const packageInputSchema = z.object({
  job_id: z.string().uuid(), inspection_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  answers: z.array(z.object({ question_id: questionId, field_name: z.string().min(1).max(100), value: z.string().trim().min(1).max(2000) }).strict()).max(20),
  documents: z.array(z.object({ question_id: questionId, field_name: z.string().min(1).max(100), draft_id: z.string().uuid() }).strict()).min(1).max(2),
  skips: z.array(questionId).max(110), deferred: z.array(questionId).max(110),
}).strict();
export type PackageInput = z.infer<typeof packageInputSchema>;
export type DocumentSnapshot = Awaited<ReturnType<SubmissionStore["snapshot"]>>;

export function acceptsOrdinaryAnswer(question: EmployerQuestion): boolean {
  if (question.section !== "application" || question.description || question.alternatives.length !== 1 || question.alternatives[0].type !== "input_text") return false;
  const labels: Record<string, RegExp> = { first_name: /^first name$/i, last_name: /^last name$/i, email: /^e-?mail(?: address)?$/i, phone: /^phone(?: number)?$/i };
  const field = question.alternatives[0].name;
  if (question.handling === "ordinary" && Object.hasOwn(labels, field)) return labels[field].test(question.label);
  return question.handling === "candidate" && /^question_[0-9]+$/.test(field) && /^(website|linkedin(?: profile| url)?)$/i.test(question.label);
}

/** Builds only the exact ordinary-data package. No sensitive values, form filling, provider writes or execution authority. */
export async function buildApplicationPackage(input: PackageInput, inspection: GreenhouseInspection, snapshots: DocumentSnapshot[]) {
  const target = greenhouseTarget(inspection.destination);
  if (!target || target.board !== inspection.board || target.job !== inspection.job_id || target.api !== inspection.metadata_source || inspection.fingerprint !== input.inspection_fingerprint)
    throw new HttpError(409, "Employer question snapshot changed. Inspect and review again.");
  const decisions = [...input.answers.map(item => item.question_id), ...input.documents.map(item => item.question_id), ...input.skips, ...input.deferred];
  const questionIds = inspection.questions.map(question => question.id);
  if (new Set(questionIds).size !== questionIds.length || new Set(decisions).size !== decisions.length || decisions.length !== questionIds.length || decisions.some(id => !questionIds.includes(id)))
    throw new HttpError(409, "Choose exactly one answer, document, explicit optional skip or deferred intervention for every question.");
  const first = snapshots[0];
  if (!first || snapshots.length !== input.documents.length || new Set(snapshots.map(item => item.draft_id)).size !== snapshots.length || snapshots.some(item => item.job_id !== input.job_id || item.destination !== inspection.destination || item.job_revision !== first.job_revision || item.profile_id !== first.profile_id || item.profile_revision !== first.profile_revision))
    throw new HttpError(409, "Documents must belong to the same current job and profile snapshot.");
  const answers = input.answers.map(answer => {
    const question = inspection.questions.find(item => item.id === answer.question_id)!;
    if (!acceptsOrdinaryAnswer(question) || question.alternatives[0].name !== answer.field_name) throw new HttpError(409, "Sensitive, unsupported or unanticipated answers require candidate takeover; do not store them in an ordinary package.");
    const value = answer.value;
    if (answer.field_name === "email" && !z.email().safeParse(value).success) throw new HttpError(400, "Provide an exact valid email address.");
    if (["first_name", "last_name"].includes(answer.field_name) && (value.length > 255 || /[\r\n]|https?:\/\//i.test(value))) throw new HttpError(400, "Invalid contact name.");
    if (answer.field_name === "phone" && (!/^\+?[0-9() .-]{7,40}$/.test(value) || value.replace(/\D/g, "").length < 7)) throw new HttpError(400, "Provide a real candidate-confirmed phone number, or defer that question.");
    if (/^question_/.test(answer.field_name)) publicJobUrl(value); // Validate a public HTTPS link; never fetch it.
    return { question_id: question.id, question_label: question.label, field_name: answer.field_name, value };
  }).sort((a, b) => a.question_id.localeCompare(b.question_id));
  const documents = await Promise.all(input.documents.map(async document => {
    const question = inspection.questions.find(item => item.id === document.question_id)!;
    const field = question.alternatives.find(item => item.name === document.field_name);
    const snapshot = snapshots.find(item => item.draft_id === document.draft_id);
    if (question.handling !== "document" || question.section !== "application" || !field || !["input_file", "textarea"].includes(field.type) || !snapshot)
      throw new HttpError(409, "Unsupported document question or alternative.");
    const type = /^(resume|resume_text)$/.test(field.name) ? "resume" : /^(cover_letter|cover_letter_text)$/.test(field.name) ? "cover_letter" : null;
    if (!type || type !== snapshot.draft_type) throw new HttpError(409, "Select a saved document of the exact requested type.");
    return { question_id: question.id, question_label: question.label, field_name: field.name, provider_type: field.type,
      draft_id: snapshot.draft_id, draft_revision: snapshot.draft_revision, snapshot_digest: snapshot.payload_digest,
      type, file_name: `${type}.txt`, mime_type: "text/plain", content: snapshot.content, document_digest: await hash(snapshot.content) };
  }));
  documents.sort((a, b) => a.question_id.localeCompare(b.question_id));
  if (documents.filter(item => item.type === "resume").length !== 1 || documents.filter(item => item.type === "cover_letter").length > 1) throw new HttpError(409, "Exactly one reviewed résumé is required; at most one cover letter is supported.");
  const skips = input.skips.map(id => {
    const question = inspection.questions.find(item => item.id === id)!;
    if (question.required || question.handling === "unsupported") throw new HttpError(409, "Required or unsupported questions cannot be skipped.");
    return { question_id: id, question_label: question.label };
  }).sort((a, b) => a.question_id.localeCompare(b.question_id));
  const deferred = input.deferred.map(id => ({ question_id: id, question_label: inspection.questions.find(item => item.id === id)!.label })).sort((a, b) => a.question_id.localeCompare(b.question_id));
  const core = {
    version: 1 as const, approval_scope: "ordinary-data-and-documents-only" as const, adapter: inspection.adapter,
    job_id: input.job_id, job_revision: first.job_revision, profile_id: first.profile_id, profile_revision: first.profile_revision,
    employer: inspection.company, title: inspection.title, destination: inspection.destination, provider_job_id: inspection.job_id, board: inspection.board,
    inspection_fingerprint: inspection.fingerprint, answers, documents, skips, deferred,
    // API-only review never waives these gates. Sensitive answers must be entered directly during candidate takeover.
    pending_steps: ["rendered_form_parity", "candidate_takeover", "final_submission_policy", "employer_receipt_adapter", ...(deferred.length ? ["deferred_questions"] : []), ...inspection.interventions.filter(item => item.question_id === null && item.code !== "rendered_form_review").map(item => item.code)],
    execution_enabled: false as const,
  };
  const serialized = JSON.stringify(core);
  const result = { ...core, package_digest: await hash(serialized) };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 65536) throw new HttpError(413, "Exact package exceeds 64 KiB. Shorten reviewed preparation documents before approving.");
  return result;
}
export type ApplicationPackage = Awaited<ReturnType<typeof buildApplicationPackage>>;
