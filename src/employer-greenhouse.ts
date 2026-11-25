import { z } from "zod";
import { boundedBody, hash, HttpError } from "./security.ts";

const hosts = ["job-boards.greenhouse.io", "boards.greenhouse.io"];
export function greenhouseTarget(value: string): { board: string; job: string; api: string } | null {
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpError(409, "Unsupported Greenhouse destination. Review the exact hosted job URL."); }
  if (!hosts.includes(url.hostname)) return null;
  const path = /^\/([a-zA-Z0-9_-]{1,100})\/jobs\/([1-9][0-9]{0,14})\/?$/.exec(url.pathname);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || !path ||
    Array.from(url.searchParams).some(([key, token]) => key !== "gh_src" || !/^[a-zA-Z0-9_-]{1,128}$/.test(token)) || url.searchParams.getAll("gh_src").length > 1)
    throw new HttpError(409, "Unsupported Greenhouse destination. Review the exact hosted job URL.");
  return { board: path[1], job: path[2], api: `https://boards-api.greenhouse.io/v1/boards/${path[1]}/jobs/${path[2]}?questions=true` };
}

const optionSchema = z.object({ value: z.union([z.string().max(500), z.number().finite()]), label: z.string().max(1000) }).strict();
const fieldSchema = z.object({ name: z.string().min(1).max(100), type: z.string().min(1).max(80), values: z.array(optionSchema).max(200).optional() }).strict();
const questionSchema = z.object({ label: z.string().min(1).max(1000), description: z.string().max(5000).nullable().optional(), required: z.boolean(), fields: z.array(fieldSchema).min(1).max(5) }).strict();
const complianceSchema = z.object({ type: z.string().max(80), requires_consent: z.boolean().optional(), requires_processing_consent: z.boolean().optional(), requires_retention_consent: z.boolean().optional(), retention_period: z.number().nullable().optional(), demographic_data_consent_applies: z.boolean().optional() }).strict();
const demographicQuestionSchema = z.object({
  id: z.number().int().positive(), label: z.string().min(1).max(1000), required: z.boolean(), type: z.string().max(80),
  answer_options: z.array(z.object({ id: z.number().int(), label: z.string().max(1000), free_form: z.boolean() }).strict()).max(200),
}).strict();
const jobSchema = z.object({
  id: z.number().int().positive().safe(), internal_job_id: z.number().int().positive().safe().nullable(),
  absolute_url: z.string().max(2048), title: z.string().min(1).max(300), company_name: z.string().min(1).max(300),
  location: z.object({ name: z.string().max(1000) }).strict(), content: z.string().max(150000), updated_at: z.string().max(100),
  application_deadline: z.iso.datetime({ offset: true }).nullable().optional(),
  questions: z.array(questionSchema).min(1).max(60), location_questions: z.array(questionSchema).max(10).optional(),
  compliance: z.array(questionSchema).max(20).nullable().optional(), data_compliance: z.array(complianceSchema).max(10).optional(),
  demographic_questions: z.object({ header: z.string().max(1000), description: z.string().max(10000), questions: z.array(demographicQuestionSchema).max(20) }).strict().nullable().optional(),
  include_ai_disclaimer: z.boolean().nullable().optional(), ai_disclaimer: z.string().max(10000).nullable().optional(), ai_opt_out_request_url: z.string().max(2048).nullable().optional(),
  // Posting metadata is retained in the digest, not interpreted as authority or followed as URLs.
  metadata: z.unknown().optional(), requisition_id: z.string().nullable().optional(), first_published: z.string().optional(),
  language: z.string().optional(), departments: z.array(z.unknown()).max(100).optional(), offices: z.array(z.unknown()).max(100).optional(), pay_input_ranges: z.array(z.unknown()).max(100).optional(),
}).strict();

export type EmployerQuestion = {
  id: string; section: "application" | "location" | "compliance" | "demographic";
  label: string; description: string | null; required: boolean;
  alternatives: { name: string; type: string; options: { value: string | number; label: string }[] }[];
  handling: "ordinary" | "document" | "candidate" | "unsupported"; reason: string;
};
export type GreenhouseInspection = {
  adapter: "greenhouse-public-v1"; destination: string; metadata_source: string;
  board: string; job_id: string; title: string; company: string; location: string;
  fingerprint: string; checked_at: string; questions: EmployerQuestion[];
  interventions: { code: string; question_id: string | null; reason: string }[];
  live_submission_enabled: false; execution_supported: false; applicant_data_entered: false;
};
export type GreenhouseResult = { inspection: GreenhouseInspection } | {
  adapter: "greenhouse-public-v1"; status: "needs_user"; code: string; reason: string; applicant_data_entered: false; live_submission_enabled: false;
};
const sensitive = /\b(authoriz\w*|sponsor\w*|citizen\w*|residen\w*|visa|criminal|convict\w*|disab\w*|veteran\w*|gender|ethnic\w*|race|demograph\w*|salary.history|compensation.history|consent|certif\w*|attest\w*|agree\w*|signature|terms|privacy|password|payment|captcha|social.security)\b/i;
const knownTypes = ["input_file", "input_text", "textarea", "input_hidden", "multi_value_single_select", "multi_value_multi_select"];
function handling(question: z.infer<typeof questionSchema>, section: EmployerQuestion["section"]): Pick<EmployerQuestion, "handling" | "reason"> {
  const text = `${question.label} ${question.description ?? ""} ${question.fields.map(field => field.name.replaceAll("_", " ")).join(" ")}`;
  if (section === "compliance" || section === "demographic" || sensitive.test(text)) return { handling: "candidate", reason: "Sensitive answer or legal decision requires the candidate; never infer an answer or an opt-out." };
  if (question.fields.some(field => !knownTypes.includes(field.type))) return { handling: "unsupported", reason: "Unknown provider field type requires an adapter review." };
  if (section === "location") return { handling: "candidate", reason: "Location/geocoding requires exact candidate information; hidden coordinates are not inferred." };
  if (/^(resume(?:\/cv)?|cover letter)$/i.test(question.label) && question.fields.every(field => /^(resume|resume_text|cover_letter|cover_letter_text)$/.test(field.name)) && question.fields.every(field => ["input_file", "textarea"].includes(field.type)))
    return { handling: "document", reason: "Requires an individually reviewed exact document and choice of the provider's alternative fields." };
  const name = question.fields[0]?.name;
  const expectedLabel: Record<string, RegExp> = { first_name: /^first name$/i, last_name: /^last name$/i, email: /^e-?mail(?: address)?$/i, phone: /^phone(?: number)?$/i };
  if (!question.description && question.fields.length === 1 && question.fields[0].type === "input_text" && Object.hasOwn(expectedLabel, name) && expectedLabel[name].test(question.label))
    return { handling: "ordinary", reason: "Requires exact candidate-approved contact data. No value is populated during inspection." };
  // Do not infer custom question semantics from a familiar-looking label or arbitrary question ID.
  return { handling: "candidate", reason: "Job-specific question requires an exact candidate answer or explicit skip when optional." };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** GET-only official metadata. No API key, browser cookies, candidate payload, redirect or write endpoint. */
export async function inspectGreenhouse(destination: string, fetcher: typeof fetch = fetch, now = Date.now()): Promise<GreenhouseResult> {
  const target = greenhouseTarget(destination);
  if (!target) throw new HttpError(400, "Not a supported Greenhouse hosted job URL.");
  const stopped = (code: string, reason: string): GreenhouseResult => ({ adapter: "greenhouse-public-v1", status: "needs_user", code, reason, applicant_data_entered: false, live_submission_enabled: false });
  try {
    const response = await fetcher(target.api, { method: "GET", redirect: "manual", credentials: "omit", cache: "no-store", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000) });
    if (response.redirected || (response.url && response.url !== target.api)) { await response.body?.cancel(); return stopped("destination_changed", "Provider response came from a different destination. No follow-up request is permitted."); }
    if (!response.ok) {
      await response.body?.cancel();
      return stopped([404, 410].includes(response.status) ? "opening_unavailable" : [401, 403].includes(response.status) ? "authentication_required" : response.status === 429 ? "rate_limited" : "provider_unavailable", "Provider did not return a published job. No redirects or automatic retries are permitted.");
    }
    if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) { await response.body?.cancel(); return stopped("unsupported_response", "Expected official job metadata, not HTML or a challenge page."); }
    const raw: unknown = JSON.parse(await boundedBody(response, 200000));
    const parsed = jobSchema.safeParse(raw);
    if (!parsed.success) return stopped("provider_schema_changed", "Provider fields are incomplete, unknown or oversized. Review the adapter before approval; no applicant data was entered.");
    const job = parsed.data, identity = greenhouseTarget(job.absolute_url);
    if (String(job.id) !== target.job || !identity || identity.board !== target.board || identity.job !== target.job) return stopped("destination_changed", "Provider job identity/destination differs from the saved role. Recheck before approving anything.");
    if (job.internal_job_id === null) return stopped("prospect_post", "This is a prospect post, not a verified specific opening.");
    if (job.application_deadline && Date.parse(job.application_deadline) <= now) return stopped("deadline_passed", "The provider's application deadline has passed.");
    const questions: EmployerQuestion[] = [];
    const names = new Set<string>();
    for (const section of ["application", "location", "compliance"] as const) {
      const source = section === "application" ? job.questions : section === "location" ? job.location_questions ?? [] : job.compliance ?? [];
      for (const [index, question] of source.entries()) {
        for (const field of question.fields) {
          if (names.has(field.name)) return stopped("ambiguous_fields", "Duplicate provider fields require review.");
          names.add(field.name);
          if (field.values && new Set(field.values.map(option => String(option.value))).size !== field.values.length) return stopped("ambiguous_fields", "Duplicate provider option values require review.");
        }
        questions.push({ id: `${section}:${index}`, section, label: question.label, description: question.description ?? null, required: question.required,
          alternatives: question.fields.map(field => ({ name: field.name, type: field.type, options: field.values ?? [] })), ...handling(question, section) });
      }
    }
    const demographicIds = new Set<number>();
    for (const question of job.demographic_questions?.questions ?? []) {
      if (demographicIds.has(question.id)) return stopped("ambiguous_fields", "Duplicate provider demographic questions require review.");
      demographicIds.add(question.id);
      questions.push({ id: `demographic:${question.id}`, section: "demographic", label: question.label, description: null, required: question.required,
      alternatives: [{ name: `demographic:${question.id}`, type: question.type, options: question.answer_options.map(option => ({ value: option.id, label: option.label })) }], handling: "candidate", reason: "Demographic choices and optional skips belong to the candidate. Free-form options require a separate candidate answer." });
    }
    const interventions: GreenhouseInspection["interventions"] = questions.filter(question => ["candidate", "unsupported"].includes(question.handling)).map(question => ({ code: question.handling === "unsupported" ? "unsupported_field" : "candidate_question", question_id: question.id, reason: question.reason }));
    if (!job.data_compliance?.length || job.data_compliance.some(item => item.requires_consent !== false || item.requires_processing_consent !== false || item.requires_retention_consent !== false || item.demographic_data_consent_applies !== false))
      interventions.push({ code: "legal_consent", question_id: null, reason: "Provider consent configuration requires candidate review. No consent is inferred or recorded." });
    if (job.include_ai_disclaimer || job.ai_disclaimer || job.ai_opt_out_request_url)
      interventions.push({ code: "ai_notice", question_id: null, reason: "Provider AI notice or opt-out requires candidate review; no linked opt-out action is followed." });
    interventions.push({ code: "rendered_form_review", question_id: null, reason: "API metadata is not the rendered form. The browser adapter must verify final controls, hidden fields, notices and challenges before any approved disclosure." });
    const inspection: GreenhouseInspection = { adapter: "greenhouse-public-v1", destination, metadata_source: target.api, board: target.board, job_id: target.job,
      title: job.title, company: job.company_name, location: job.location.name, questions, interventions,
      fingerprint: await hash(canonical({ adapter: "greenhouse-public-v1", destination, raw })), checked_at: new Date(now).toISOString(),
      live_submission_enabled: false, execution_supported: false, applicant_data_entered: false };
    if (new TextEncoder().encode(JSON.stringify({ inspection })).byteLength > 23000) return stopped("inspection_too_large", "Provider questions exceed the bounded review contract; use an individually reviewed adapter.");
    return { inspection };
  } catch { return stopped("inspection_interrupted", "Provider read interrupted or identity/schema validation failed. No applicant data was entered; no automatic retry."); }
}
