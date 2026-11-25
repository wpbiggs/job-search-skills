import { z } from "zod";
import { hash, HttpError } from "./security.ts";
import { greenhouseTarget, type GreenhouseInspection } from "./employer-greenhouse.ts";

export const GREENHOUSE_ASSET_HOST = "job-boards.cdn.greenhouse.io";
export function greenhouseStaticAsset(value: string, resourceType: string): boolean {
  let url: URL; try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" || url.hostname !== GREENHOUSE_ASSET_HOST || url.port || url.username || url.password || url.search || url.hash) return false;
  return (resourceType === "script" && /^\/assets\/[a-zA-Z0-9_.$-]{1,180}-[a-zA-Z0-9_-]{6,20}\.m?js$/.test(url.pathname)) ||
    (resourceType === "stylesheet" && /^\/assets\/[a-zA-Z0-9_.$-]{1,180}-[a-zA-Z0-9_-]{6,20}\.css$/.test(url.pathname));
}

export const renderedControlSchema = z.object({
  id: z.string().max(100), name: z.string().max(100), type: z.string().max(50), role: z.string().max(50),
  labels: z.array(z.string().max(300)).max(8), required_hint: z.boolean(), disabled: z.boolean(), readonly: z.boolean(), visible: z.boolean(),
  accept: z.string().max(300), pattern: z.string().max(300), max_length: z.number().int(),
  options: z.array(z.object({ value: z.string().max(200), label: z.string().max(300) }).strict()).max(100),
}).strict();
export const renderedFormSchema = z.object({
  destination: z.string().max(2048), action: z.string().max(2048), method: z.string().max(10), enctype: z.string().max(100),
  page_title: z.string().max(1000), role_headings: z.array(z.string().max(300)).max(4), page_content_digest: z.string().regex(/^[a-f0-9]{64}$/),
  controls: z.array(renderedControlSchema).max(100), submit_controls: z.array(z.object({ id: z.string().max(100), type: z.string().max(30), label: z.string().max(300), disabled: z.boolean() }).strict()).max(10),
  legal_notices: z.array(z.string().max(500)).max(20), challenge_present: z.boolean(), password_present: z.boolean(), frames_present: z.boolean(),
}).strict();
export type RenderedForm = z.infer<typeof renderedFormSchema>;
export type RenderedObservation = { assets: string[]; blocked_writes: number; blocked_active_resources: number; blocked_decorative_resources: number; blocked_websockets: number; popup_attempts: number; load_failures: number; stable: boolean; request_limit_reached: boolean };
export type RenderedIntervention = { code: string; control: string | null; reason: string };
export type RenderedInspection = {
  adapter: "greenhouse-rendered-v1"; destination: string; metadata_fingerprint: string; form_fingerprint: string; checked_at: string;
  form: RenderedForm; observed_assets: string[]; questions_match_metadata: boolean; interventions: RenderedIntervention[];
  observation: Omit<RenderedObservation, "assets">;
  applicant_data_entered: false; values_collected: false; execution_enabled: false; interactive_takeover_available: false;
};
function normalized(value: string): string { return value.normalize("NFKC").replace(/\*/g, "").replace(/\s+/g, " ").trim().toLowerCase(); }
function compatible(providerType: string, renderedType: string): boolean {
  return providerType === "input_text" ? ["text", "email", "tel", "url"].includes(renderedType) :
    providerType === "input_file" ? renderedType === "file" : providerType === "textarea" ? renderedType === "textarea" :
    providerType === "input_hidden" ? renderedType === "hidden" : providerType === "multi_value_single_select" ? ["select-one", "radio"].includes(renderedType) :
    providerType === "multi_value_multi_select" ? ["select-multiple", "checkbox"].includes(renderedType) : false;
}

/** Compare structure, never form values. A matching question structure is not an executable-form approval. */
export async function reviewRenderedForm(metadata: GreenhouseInspection, raw: unknown, observed: RenderedObservation, now = Date.now()): Promise<RenderedInspection> {
  const form = renderedFormSchema.parse(raw);
  const target = greenhouseTarget(form.destination);
  if (!target || form.destination !== metadata.destination || target.board !== metadata.board || target.job !== metadata.job_id) throw new HttpError(409, "Rendered destination differs from the inspected requisition.");
  const interventions: RenderedIntervention[] = [];
  const stop = (code: string, reason: string, control: string | null = null) => { if (interventions.length < 120) interventions.push({ code, control, reason }); };
  let matches = true;
  const used = new Set<number>(), identities = new Set<string>();
  if (!form.role_headings.some(heading => normalized(heading) === normalized(metadata.title))) { matches = false; stop("role_heading_changed", "Rendered role heading differs from provider metadata. Recheck the actual opening."); }
  for (const [index, control] of form.controls.entries()) {
    const identity = control.id || control.name;
    if (!identity) { matches = false; stop("unnamed_control", "Unidentified rendered control needs provider-specific review; no value was read.", `control:${index}`); }
    else if (identities.has(identity)) { matches = false; stop("duplicate_control", "Duplicate rendered field identity requires review.", identity); }
    identities.add(identity);
  }
  for (const question of metadata.questions) {
    const candidates = form.controls.map((control, index) => ({ control, index, field: question.alternatives.find(field => field.name === control.id || (control.name && field.name === control.name)) })).filter(item => item.field);
    if (!candidates.length) { matches = false; stop("missing_question", "Provider question has no verified rendered alternative.", question.id); continue; }
    for (const { control, index, field } of candidates) {
      if (used.has(index) || (control.id && control.name && control.id !== control.name)) { matches = false; stop("ambiguous_control_binding", "Rendered identity is ambiguous or reused by multiple provider questions.", control.id || control.name); }
      used.add(index);
      if (!compatible(field!.type, control.type)) { matches = false; stop("control_type_changed", "Rendered control type differs from provider metadata.", control.id || control.name); }
      const semanticLabels = control.labels.filter(label => control.type !== "file" || !/^(attach|browse|choose file|google drive|enter manually)$/i.test(label.trim()));
      if (!semanticLabels.length || semanticLabels.some(label => normalized(label) !== normalized(question.label))) { matches = false; stop("control_label_changed", "Rendered field/group label differs from the reviewed provider question.", control.id || control.name); }
      if (control.disabled || control.readonly || (!control.visible && control.type !== "file" && control.type !== "hidden")) { matches = false; stop("control_unavailable", "Control is disabled, read-only or unexpectedly hidden.", control.id || control.name); }
      if (question.required !== control.required_hint) { matches = false; stop("requiredness_unverified", "Rendered requiredness differs from the provider question.", control.id || control.name); }
      if (field!.options.length || control.options.length) {
        const optionsMatch = control.options.length === field!.options.length && field!.options.every(option => control.options.some(item => item.value === String(option.value) && normalized(item.label) === normalized(option.label)));
        if (!optionsMatch) { matches = false; stop("options_unverified", "Rendered answer options are missing or changed; selected values are not read.", control.id || control.name); }
      }
      if (control.type === "file" && control.accept && !control.accept.toLowerCase().split(",").some(value => [".txt", "text/plain", "text/*"].includes(value.trim()))) stop("document_format_unverified", "Rendered upload does not advertise support for the reviewed plain-text document.", control.id || control.name);
    }
    if (question.handling === "candidate" || question.handling === "unsupported") stop("candidate_question", "This question requires an explicit candidate decision or supported takeover; metadata matching does not answer it.", question.id);
  }
  form.controls.forEach((control, index) => {
    if (!used.has(index)) { matches = false; stop("unreviewed_control", "Rendered control is absent from the provider question manifest. Pause before any data entry.", control.id || control.name || `control:${index}`); }
  });
  if (form.method !== "post" || form.controls.some(control => !control.name)) stop("script_managed_form", "This is a JavaScript-managed form, not a verified native POST. Never submit it through a default GET action.");
  if (form.action !== form.destination) stop("action_requires_review", "Rendered action differs from the saved destination. It is not followed or authorized by inspection.");
  if (form.submit_controls.length !== 1 || form.submit_controls.some(control => control.disabled)) stop("ambiguous_final_action", "Final control is missing, ambiguous or disabled; no final action is attempted.");
  if (form.legal_notices.length) stop("legal_notice", "Rendered legal/consent text needs direct candidate review; no consent is inferred.");
  if (form.password_present) stop("authentication", "Authentication requires the candidate; no credentials were entered.");
  if (form.challenge_present || form.frames_present) stop("challenge_or_frame", "Challenge or embedded content requires candidate intervention; it is not bypassed.");
  if (observed.blocked_writes) stop("write_attempt_blocked", "Site write requests were blocked during public-only rendering.");
  if (observed.blocked_active_resources || observed.blocked_websockets || observed.popup_attempts || observed.load_failures || !observed.stable || observed.request_limit_reached)
    stop("render_incomplete", "The restricted page could not be fully verified. Blocked active resources, network failure, popups or instability require review.");
  const assets = [...new Set(observed.assets)].sort();
  if (assets.some(asset => !greenhouseStaticAsset(asset, asset.endsWith(".css") ? "stylesheet" : "script"))) throw new HttpError(409, "Unapproved rendered asset.");
  const { assets: _assets, ...observation } = observed;
  const result: RenderedInspection = { adapter: "greenhouse-rendered-v1", destination: metadata.destination, metadata_fingerprint: metadata.fingerprint,
    form_fingerprint: await hash(JSON.stringify({ adapter: "greenhouse-rendered-v1", metadata_fingerprint: metadata.fingerprint, form, assets, javaScriptEnabled: true, viewport: { width: 1280, height: 900 } })),
    checked_at: new Date(now).toISOString(), form, observed_assets: assets, questions_match_metadata: matches, interventions, observation,
    applicant_data_entered: false, values_collected: false, execution_enabled: false, interactive_takeover_available: false };
  if (new TextEncoder().encode(JSON.stringify({ rendered: result })).byteLength > 23000) throw new HttpError(413, "Rendered review exceeds the bounded inspection contract.");
  return result;
}
