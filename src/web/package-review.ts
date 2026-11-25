import { acceptsOrdinaryAnswer, type PackageInput, type ApplicationPackage } from "../application-package.ts";
import type { GreenhouseInspection } from "../employer-greenhouse.ts";
import type { PackageSummary } from "../application-package-store.ts";
import type { RecordRow } from "../store.ts";
import { escapeHtml as esc } from "../security.ts";

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Busy = (action: () => Promise<void>) => Promise<void>;

export function exactPackageView(exact: ApplicationPackage): string {
  return `<h3>Exact preparation package</h3><p>${esc(exact.employer)} · ${esc(exact.title)}</p><p class="wrap">Destination: ${esc(exact.destination)}<br>Package SHA-256: ${esc(exact.package_digest)}<br>Profile version ${exact.profile_revision} · job version ${exact.job_revision}</p><h4>Exact ordinary answers</h4>${exact.answers.map(answer => `<p class="wrap"><strong>${esc(answer.question_label)}</strong> (${esc(answer.field_name)}): ${esc(answer.value)}</p>`).join("") || "<p>No ordinary answers included.</p>"}<h4>Exact document bytes</h4>${exact.documents.map(document => `<article class="record"><p class="wrap">${esc(document.question_label)} · saved version ${document.draft_revision} · ${esc(document.field_name)} (${esc(document.provider_type)})<br>${esc(document.file_name)} · ${esc(document.mime_type)}<br>SHA-256: ${esc(document.document_digest)}</p><pre>${esc(document.content)}</pre></article>`).join("")}<h4>Explicit optional skips</h4><ul>${exact.skips.map(item => `<li>${esc(item.question_label)}</li>`).join("") || "<li>None.</li>"}</ul><h4>Deferred to candidate takeover</h4><ul>${exact.deferred.map(item => `<li>${esc(item.question_label)}</li>`).join("") || "<li>None.</li>"}</ul><p><strong>Execution is disabled.</strong> This approval only freezes ordinary data and documents, not sensitive answers, legal consent or final submission. No applicant data is sent to the employer. Pending execution gates: ${esc(exact.pending_steps.join(", "))}.</p>`;
}

export function mountPackageReview(container: Element, jobId: string, inspection: GreenhouseInspection, drafts: RecordRow[], api: Api, busy: Busy, refresh: () => Promise<void>) {
  const box = document.createElement("section"); box.className = "box";
  const documents = inspection.questions.map(question => question.alternatives.flatMap(field => {
    const type = /^(resume|resume_text)$/.test(field.name) ? "resume" : /^(cover_letter|cover_letter_text)$/.test(field.name) ? "cover_letter" : "";
    return question.handling === "document" && ["input_file", "textarea"].includes(field.type)
      ? drafts.filter(draft => draft.data.type === type).map(draft => ({ question_id: question.id, field_name: field.name, draft_id: draft.id, revision: draft.revision, type, provider_type: field.type })) : [];
  }));
  box.innerHTML = `<h3>Review one exact employer package</h3><p>Select an explicit answer, saved document, optional skip or deferred candidate step for every question. Preview sends these answers to your private workspace for validation; approval stores the exact package there. Nothing is inferred or sent to the employer. Sensitive/legal answers stay out of this package. Plain-text documents are not PDF files.</p><form data-package-form><fieldset><legend>Exact question decisions</legend>${inspection.questions.map((question, index) => `<div class="record"><label for="package-choice-${index}">${esc(question.label)} · ${question.required ? "Required" : "Optional"}</label><select id="package-choice-${index}"><option value="">Choose a decision</option>${acceptsOrdinaryAnswer(question) ? '<option value="answer">Include my exact ordinary answer</option>' : ""}${documents[index].map((document, choice) => `<option value="document:${choice}">Use saved ${esc(document.type)} v${document.revision} as ${esc(document.field_name)} (${document.provider_type === "input_file" ? ".txt upload" : "text alternative"})</option>`).join("")}${!question.required && question.handling !== "unsupported" ? '<option value="skip">Explicitly leave this optional question unanswered</option>' : ""}<option value="defer">Pause for my answer / intervention later</option></select><div data-package-answer="${index}" hidden><label for="package-answer-${index}">Exact answer: ${esc(question.label)}</label><input id="package-answer-${index}" autocomplete="off" maxlength="2000"></div></div>`).join("")}<button type="submit">Preview exact package</button></fieldset></form><div data-package-preview></div>`;
  container.append(box);
  const form = box.querySelector("form")!, fieldset = box.querySelector("fieldset")!, output = box.querySelector("[data-package-preview]")!;
  let generation = 0;
  const invalidate = () => { generation++; output.replaceChildren(); };
  form.addEventListener("input", invalidate);
  form.addEventListener("change", invalidate);
  inspection.questions.forEach((_question, index) => {
    box.querySelector<HTMLSelectElement>(`#package-choice-${index}`)!.addEventListener("change", event => {
      box.querySelector<HTMLElement>(`[data-package-answer="${index}"]`)!.hidden = (event.target as HTMLSelectElement).value !== "answer";
    });
  });
  const collect = (): PackageInput => {
    const input: PackageInput = { job_id: jobId, inspection_fingerprint: inspection.fingerprint, answers: [], documents: [], skips: [], deferred: [] };
    inspection.questions.forEach((question, index) => {
      const choice = box.querySelector<HTMLSelectElement>(`#package-choice-${index}`)!.value;
      if (!choice) throw new Error(`Choose an explicit decision for ${question.label}.`);
      if (choice === "answer") input.answers.push({ question_id: question.id, field_name: question.alternatives[0].name, value: box.querySelector<HTMLInputElement>(`#package-answer-${index}`)!.value });
      else if (choice === "skip") input.skips.push(question.id);
      else if (choice === "defer") input.deferred.push(question.id);
      else {
        const selected = documents[index][Number(choice.slice(9))];
        if (!selected) throw new Error("Choose a supported saved document.");
        const saved = drafts.find(item => item.id === selected.draft_id)!;
        const editor = document.getElementById(`draft-${saved.id}`) as HTMLTextAreaElement | null;
        if (editor && editor.value.trim() !== saved.data.content) throw new Error("Save or discard unsaved document edits before reviewing an exact package.");
        input.documents.push({ question_id: question.id, field_name: selected.field_name, draft_id: selected.draft_id });
      }
    });
    return input;
  };
  form.addEventListener("submit", event => {
    event.preventDefault(); void busy(async () => {
      const input = collect(), version = generation;
      output.replaceChildren();
      const result = await api<{ package: ApplicationPackage }>("packages/preview", "POST", input);
      if (!box.isConnected || generation !== version) return;
      output.innerHTML = `${exactPackageView(result.package)}<label class="check"><input type="checkbox" data-package-consent><span>I reviewed this exact employer, ordinary answers, document contents, explicit skips and deferred steps. Approve only this preparation package; nothing is uploaded or submitted.</span></label><button data-package-approve disabled>Approve exact preparation package</button>`;
      const approve = output.querySelector<HTMLButtonElement>("[data-package-approve]")!, consent = output.querySelector<HTMLInputElement>("[data-package-consent]")!;
      consent.addEventListener("change", () => { approve.disabled = !consent.checked; });
      approve.addEventListener("click", () => void busy(async () => {
        if (!consent.checked || generation !== version) throw new Error("Preview and review the exact package first.");
        collect(); // Recheck unsaved document editors; captured server input remains the exact displayed package.
        fieldset.disabled = true; consent.disabled = true;
        try {
          await api("packages/approve", "POST", { input, expected_digest: result.package.package_digest, confirmation: "APPROVE EXACT PREPARATION PACKAGE" });
          await refresh();
        } finally { fieldset.disabled = false; consent.disabled = false; }
      }));
    });
  });
}

export function mountPackageHistory(container: Element, packages: PackageSummary[], jobId: string, api: Api, busy: Busy, refresh: () => Promise<void>) {
  const box = document.createElement("section"); box.className = "box";
  box.innerHTML = `<h3>Exact package approval history</h3>${packages.filter(item => item.job_id === jobId).map(item => `<article class="record"><p>Preparation package: ${esc(item.status)} — not submitted</p><p class="wrap">Digest: ${esc(item.digest)}<br>Approved ${esc(item.approved_at)}<br>Expires ${esc(item.expires_at)}</p><button class="secondary" data-package-inspect="${item.id}">Inspect exact stored package</button>${item.status !== "cancelled" ? `<button class="secondary" data-package-cancel="${item.id}">Cancel package approval</button>` : ""}</article>`).join("") || "<p>No exact preparation packages approved for this job.</p>"}<div data-package-history-content></div>`;
  container.append(box);
  box.querySelectorAll<HTMLButtonElement>("[data-package-inspect]").forEach(button => button.addEventListener("click", () => void busy(async () => {
    const result = await api<{ package: ApplicationPackage }>(`packages/${button.dataset.packageInspect}`);
    if (box.isConnected) box.querySelector("[data-package-history-content]")!.innerHTML = exactPackageView(result.package);
  })));
  box.querySelectorAll<HTMLButtonElement>("[data-package-inspect]").forEach(button => {
    if (packages.find(item => item.id === button.dataset.packageInspect)?.status !== "approved") return;
    const recheck = document.createElement("button"); recheck.className = "secondary"; recheck.textContent = "Recheck package snapshot";
    button.after(recheck);
    recheck.addEventListener("click", () => void busy(async () => {
      const result = await api<{ status: string; snapshot_current: boolean }>("packages/revalidate", "POST", { id: button.dataset.packageInspect });
      if (box.isConnected) box.querySelector("[data-package-history-content]")!.textContent = `Recheck: ${result.status}; snapshot ${result.snapshot_current ? "current at this check" : "not confirmed current"}. Employer execution remains disabled. Refresh records to update history.`;
    }));
  });
  box.querySelectorAll<HTMLButtonElement>("[data-package-cancel]").forEach(button => button.addEventListener("click", () => void busy(async () => {
    await api(`packages/${button.dataset.packageCancel}`, "DELETE", { confirmation: "CANCEL EXACT PACKAGE" }); await refresh();
  })));
}
