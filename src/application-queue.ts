import type { RecordRow } from "./store.ts";
import type { Handoff } from "./submissions.ts";
import type { PackageSummary } from "./application-package-store.ts";

type QueueState = {
  records: RecordRow[];
  handoffs: Handoff[];
  reviews: { job_id: string; action: string }[];
  outcomes: { job_id: string; status: string }[];
  application_packages?: PackageSummary[];
};
export type ApplicationStep = { job: RecordRow; label: string; detail: string; reviewable: boolean };

/** Local preparation readiness only. Never vacancy verification, approval or permission to transmit. */
export function applicationQueue(state: QueueState, now = Date.now()): ApplicationStep[] {
  const profile = state.records.find(record => record.kind === "profile");
  const evidence = (profile?.data.evidence ?? []) as { id: string; confirmed: boolean }[];
  return state.records.filter(record => record.kind === "job").map(job => {
    const step = (label: string, detail: string, reviewable = false): ApplicationStep => ({ job, label, detail, reviewable });
    const handoffs = state.handoffs.filter(item => item.job_id === job.id);
    if (state.reviews.some(item => item.job_id === job.id && item.action === "submitted") || handoffs.some(item => item.status === "submitted"))
      return step("Submission recorded", "You reported submission. Do not apply again; check the employer confirmation and track responses.");
    const outcome = state.outcomes.find(item => item.job_id === job.id);
    if (outcome) return step("Outcome recorded", `Candidate-recorded: ${outcome.status}. Review that outcome before any further application action.`);
    if (handoffs.some(item => item.attempt_id))
      return step("Check employer outcome", "A handoff was opened. Opening is not submission. Check the employer portal before retrying; record a receipt only if you personally submitted and saw confirmation.");
    const exact = state.application_packages?.find(item => item.job_id === job.id && item.status === "approved" && Date.parse(item.expires_at) > now);
    if (exact) return step("Exact package approved — execution pending", "Ordinary answers and documents are frozen. No employer submission is enabled or claimed; review pending execution/intervention steps in the job details.");
    const opening = handoffs.find(item => item.status === "approved" && Date.parse(item.expires_at) > now);
    if (opening) return step("Handoff approved", "Open the one-use manual handoff in Jobs & drafts. You upload, answer questions and perform final submission.", true);
    if (!profile) return step("Set up profile", "Add your current experience and evidence under My profile before reviewing application materials.");
    const drafts = state.records.filter(record => record.kind === "draft" && record.job_id === job.id);
    if (!drafts.length) return step("Prepare materials", "Save a factual résumé or application draft for this role. A ranked lead or daily report is not an application.");
    const current = drafts.filter(draft => draft.data.profile_id === profile.id && draft.data.profile_revision === profile.revision);
    if (!current.length) return step("Refresh materials", "The profile changed. Review and save a draft against the current profile; previous approvals do not carry over.");
    const ready = current.some(draft => !String(draft.data.unresolved_claims).trim() && (draft.data.evidence_ids as string[]).every(id => evidence.some(item => item.id === id && item.confirmed)));
    if (!ready) return step("Resolve evidence", "Confirm cited profile evidence yourself and resolve draft claims. Your assistant cannot confirm these on your behalf.");
    return step("Review materials", "Review the exact saved document and destination, then approve a manual handoff. This is preparation readiness, not verified suitability or a live vacancy.", true);
  });
}

export function postingNeedsRecheck(checkedAt: unknown, now = Date.now()): boolean {
  const checked = typeof checkedAt === "string" ? Date.parse(checkedAt) : NaN;
  return !Number.isFinite(checked) || checked > now || now - checked > 7 * 86400000;
}
