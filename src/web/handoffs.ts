import { escapeHtml as esc } from "../security.ts";
import type { SubmissionStore, Handoff } from "../submissions.ts";
import type { RecordRow } from "../store.ts";

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Snapshot = Awaited<ReturnType<SubmissionStore["snapshot"]>>;

export async function mountHandoffs(section: Element, jobId: string, drafts: RecordRow[], api: Api, refresh: () => Promise<void>, busy: (action: () => Promise<void>) => Promise<void>) {
  const box = document.createElement("section"); box.className = "box";
  box.innerHTML = `<h2>Reviewed application handoff</h2><p>You perform all employer-site actions, including uploads, answers, consent and the final submission. This service never fills forms or contacts employers. Approval here is <strong>not permission for an agent to submit</strong>.</p><p>Review one saved document at a time. A handoff does not include other drafts or screening answers. Confirm the exact destination and all additional materials yourself. Opening a link can follow employer redirects; stop if the employer or role changes.</p><div data-handoff-list role="status">Loading handoffs…</div>${drafts.length ? `<label for="handoff-draft">Saved document to review</label><select id="handoff-draft">${drafts.map(draft => `<option value="${draft.id}">${esc(draft.data.type)} · version ${draft.revision}</option>`).join("")}</select><button id="handoff-preview" class="secondary">Review saved handoff</button><div id="handoff-preview-content"></div>` : '<p>Save a draft against your current, confirmed profile first.</p>'}`;
  section.append(box);
  const { handoffs } = await api<{ handoffs: Handoff[] }>("handoffs");
  if (!box.isConnected) return;
  const list = box.querySelector("[data-handoff-list]")!;
  const related = handoffs.filter(item => item.job_id === jobId);
  list.innerHTML = related.length ? related.map(item => `<article class="record"><p><span class="badge">${esc(item.status === "submitted" ? "Submitted — candidate-confirmed, not independently verified" : item.status === "requires_user" ? "Awaiting your manual submission / confirmation" : item.status)}</span></p><p>Draft version ${item.draft_revision} · ${esc(item.approved_at)}</p><p class="wrap">Destination: ${esc(item.destination)}</p><details><summary>Audit details</summary><p class="wrap">Handoff ${item.id}<br>Digest ${item.payload_digest}<br>Opening approval expires ${esc(item.expires_at)}${item.attempt_id ? `<br>Attempt ${item.attempt_id}<br>Opened ${esc(item.opened_at)}` : ""}</p></details>${item.receipt ? `<p>Candidate-reported receipt: ${esc(item.receipt)}</p>` : ""}${item.status === "approved" ? `<button data-handoff-open="${item.id}">Open one-use manual handoff</button>` : ""}${item.status === "requires_user" ? `<p>If you already submitted, do not apply again. Record only a real confirmation. If the outcome is unknown, check the employer portal before retrying.</p><label for="receipt-${item.id}">Receipt reference / confirmation text (8–500 characters; no secrets)</label><textarea id="receipt-${item.id}" maxlength="500"></textarea><label class="check"><input type="checkbox" id="confirm-${item.id}"><span>I personally submitted this application and saw an employer confirmation.</span></label><button data-handoff-confirm="${item.id}">Record my submission receipt</button>` : ""}${["approved", "requires_user", "stale", "expired"].includes(item.status) ? `<button class="secondary" data-handoff-cancel="${item.id}">Cancel handoff</button>` : ""}</article>`).join("") : "<p>No handoffs yet. A saved draft approval alone does not open one.</p>";
  box.querySelector<HTMLButtonElement>("#handoff-preview")?.addEventListener("click", () => void busy(async () => {
    const draftId = box.querySelector<HTMLSelectElement>("#handoff-draft")!.value;
    const { snapshot } = await api<{ snapshot: Snapshot }>("handoffs/preview", "POST", { job_id: jobId, draft_id: draftId });
    if (!box.isConnected) return;
    const output = box.querySelector("#handoff-preview-content")!;
    output.innerHTML = `<h3>Exact saved document</h3><p>${esc(snapshot.draft_type)} · version ${snapshot.draft_revision} · profile version ${snapshot.profile_revision}</p><pre>${esc(snapshot.content)}</pre><p class="wrap"><strong>Employer destination:</strong> ${esc(snapshot.destination)}</p><details><summary>Document binding</summary><p class="wrap">${snapshot.payload_digest}</p></details><label class="check"><input id="approve-handoff-check" type="checkbox"><span>I reviewed this exact saved document and destination. I will check all employer forms and perform final submission myself. Nothing is uploaded or submitted by this approval.</span></label><button id="approve-handoff">Approve 15-minute manual handoff</button>`;
    output.querySelector("#approve-handoff")!.addEventListener("click", () => void busy(async () => {
      if (!output.querySelector<HTMLInputElement>("#approve-handoff-check")!.checked) throw new Error("Review the exact saved document and check the confirmation first.");
      const field = document.getElementById(`draft-${snapshot.draft_id}`) as HTMLTextAreaElement | null;
      if (field && field.value.trim() !== snapshot.content) throw new Error("Save or discard your unsaved document edits before approving the saved version.");
      await api("handoffs/approve", "POST", { job_id: jobId, draft_id: snapshot.draft_id, expected_digest: snapshot.payload_digest, confirmation: "APPROVE MANUAL HANDOFF" });
      await refresh();
    }));
  }));
  box.querySelectorAll<HTMLButtonElement>("[data-handoff-open]").forEach(button => button.addEventListener("click", () => void busy(async () => {
    const { destination } = await api<{ destination: string }>("handoffs/action", "POST", { id: button.dataset.handoffOpen, action: "open" });
    // No automatic popup: give a real user-activated link after the one-use claim persists.
    const link = document.createElement("a"); link.href = destination; link.target = "_blank"; link.rel = "noopener noreferrer"; link.className = "button"; link.textContent = "Continue to employer — you submit manually ↗";
    button.replaceWith(link);
    const note = document.createElement("p"); note.textContent = "Handoff opened once. After visiting the employer, use Refresh records to record your receipt. Do not repeat an uncertain submission."; link.after(note);
  })));
  box.querySelectorAll<HTMLButtonElement>("[data-handoff-cancel]").forEach(button => button.addEventListener("click", () => void busy(async () => {
    if (!window.confirm("Cancel this local handoff? This cannot withdraw an application already submitted to an employer. Check any uncertain employer outcome before starting another handoff.")) return;
    await api("handoffs/action", "POST", { id: button.dataset.handoffCancel, action: "cancel" }); await refresh();
  })));
  box.querySelectorAll<HTMLButtonElement>("[data-handoff-confirm]").forEach(button => button.addEventListener("click", () => void busy(async () => {
    const id = button.dataset.handoffConfirm!;
    if (!box.querySelector<HTMLInputElement>(`#confirm-${id}`)!.checked) throw new Error("Confirm that you personally submitted and saw an employer confirmation.");
    await api("handoffs/action", "POST", { id, action: "confirm", receipt: box.querySelector<HTMLTextAreaElement>(`#receipt-${id}`)!.value, confirmation: "I SUBMITTED THIS APPLICATION" }); await refresh();
  })));
}
