import { z } from "zod";
import { hash, HttpError } from "./security.ts";

export const EXECUTOR_FIXTURE_DOCUMENT = "FICTIONAL CANDIDATE — controlled infrastructure test only. No employer application.";

export const fieldSchema = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_\[\]-]{0,79}$/),
  label: z.string().trim().min(1).max(200),
  type: z.enum(["text", "email", "tel", "textarea", "file", "hidden"]),
  required: z.boolean(), value: z.string().max(2000).optional(),
}).strict();
export const formSchema = z.object({
  destination: z.string().max(2048), action: z.string().max(2048),
  method: z.literal("post"), fields: z.array(fieldSchema).min(1).max(25),
  title: z.string().max(300), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ExecutorForm = z.infer<typeof formSchema>;
export const payloadSchema = z.object({
  fields: z.array(z.object({ name: fieldSchema.shape.name, value: z.string().min(1).max(2000) }).strict()).min(1).max(12),
  document: z.object({ name: z.literal("resume.txt"), content: z.string().min(1).max(40000), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
}).strict();
export type ExecutorPayload = z.infer<typeof payloadSchema>;
export type ExecutorResult = { status: "needs_user" | "fixture_verified" | "failed" | "uncertain"; reason: string; receipt?: { id: string; response_digest: string; received_at: string; synthetic: true } };

const sensitive = /\b(consent|certif\w*|attest\w*|agree|signature|terms|privacy|authoriz\w*|sponsor\w*|citizen\w*|criminal|convict\w*|disabil\w*|veteran\w*|gender|ethnic\w*|race|demograph\w*|(?:salary|compensation).history|payment|password|login|log in|sign in|captcha|social.security)\b/i;
export function ordinaryField(field: Pick<z.infer<typeof fieldSchema>, "name" | "label" | "type">): boolean {
  if (sensitive.test(`${field.name.replaceAll("_", " ")} ${field.label}`)) return false;
  if (field.type === "hidden") return /^(job_id|job_ref|utf8)$/.test(field.name);
  return /^(first_name|last_name|name|email|phone|website|linkedin|resume|cover_letter|job_application\[(first_name|last_name|email|phone|resume|cover_letter)\])$/.test(field.name);
}
export function employerUrl(value: string, hosts: string[]): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpError(400, "Invalid application URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || !url.hostname.includes(".") || url.hostname.includes(":") || /^(\d+\.){3}\d+$/.test(url.hostname) || /(^|\.)(localhost|local|internal|test|invalid)$/.test(url.hostname) || !hosts.includes(url.hostname)) throw new HttpError(400, "Application destination is not an explicitly allowed public HTTPS host.");
  return url.href;
}
export async function fingerprintForm(form: Omit<ExecutorForm, "fingerprint">): Promise<ExecutorForm> {
  return { ...form, fingerprint: await hash(JSON.stringify(form)) };
}
export async function validatePayload(form: ExecutorForm, input: unknown): Promise<ExecutorPayload> {
  const payload = payloadSchema.parse(input);
  if (await hash(payload.document.content) !== payload.document.digest) throw new HttpError(409, "Document digest changed.");
  if (new Set(payload.fields.map(field => field.name)).size !== payload.fields.length) throw new HttpError(400, "Duplicate payload fields.");
  const files = form.fields.filter(field => field.type === "file");
  if (files.length !== 1 || !ordinaryField(files[0])) throw new HttpError(409, "A supported résumé upload field is required.");
  for (const field of form.fields) {
    if (!ordinaryField(field)) throw new HttpError(409, "Sensitive or unanticipated question requires the candidate.");
    if (field.type === "hidden" || field.type === "file") continue;
    if (field.required && !payload.fields.some(item => item.name === field.name)) throw new HttpError(409, "A required field has no approved answer.");
  }
  for (const field of payload.fields) {
    const target = form.fields.find(item => item.name === field.name);
    if (!target || !ordinaryField(target) || ["hidden", "file"].includes(target.type)) throw new HttpError(409, "Payload contains an unapproved field.");
    if (target.type === "email" && !z.email().safeParse(field.value).success) throw new HttpError(400, "Invalid contact email.");
  }
  return payload;
}
