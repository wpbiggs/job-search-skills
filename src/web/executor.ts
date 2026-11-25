import { escapeHtml as esc } from "../security.ts";
import type { ExecutorRow } from "../executor-store.ts";
import type { GreenhouseResult } from "../employer-greenhouse.ts";
import { greenhouseReview } from "./employer-review.ts";
import { mountPackageReview, mountPackageHistory } from "./package-review.ts";
import type { PackageSummary } from "../application-package-store.ts";
import type { RecordRow } from "../store.ts";

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export async function mountExecutor(section: Element, jobId: string, drafts: RecordRow[], api: Api, busy: (action: () => Promise<void>) => Promise<void>, refresh: () => Promise<void>) {
  const box = document.createElement("section"); box.className = "box";
  box.innerHTML = `<h2>Constrained browser executor — gated pilot</h2><p><strong>Live final submission is locked.</strong> The repository still requires your final action. Greenhouse preflight reads the official public Job Board API and identifies job-specific questions and intervention requirements; it does not fill or submit the rendered form. Other supported inspections use a conservative native-form browser adapter and stop at authentication, CAPTCHA, legal/sensitive or unanticipated questions, redirects and unsupported ATS forms.</p><p>No imported cookies, AI model, personal-field filling or downloads. Inspection contacts the employer/ATS using the exact job identity. At most 10 combined metadata inspections/browser sessions per day globally and five claimed attempts/day/account; no automatic retries.</p><div class="actions"><button id="executor-inspect" class="secondary" disabled>Inspect this employer form (no applicant data)</button><button id="executor-fixture" class="secondary" disabled>Test fictional ATS only</button></div><pre id="executor-result" role="status"></pre><div id="executor-controls"></div><div id="executor-attempts"></div>`;
  section.append(box);
  const state = await api<{ intents: ExecutorRow[]; packages: PackageSummary[]; paused: boolean }>("executor");
  if (!box.isConnected) return;
  box.querySelector("#executor-controls")!.innerHTML = `<p>Executor is ${state.paused ? "paused" : "not paused"}; live final submission remains locked either way.</p><button id="executor-pause" class="secondary">${state.paused ? "Resume preparation executor" : "Pause preparation executor"}</button>`;
  box.querySelector("#executor-attempts")!.innerHTML = state.intents.filter(item => item.job_id === jobId).map(item => `<article class="record"><p class="badge">${esc(item.status)}</p><p>${esc(item.reason)}</p><p class="wrap">Destination: ${esc(item.destination)}<br>Payload digest: ${esc(item.payload_digest)}<br>Attempt: ${esc(item.attempt_id ?? "Not started")}</p>${item.receipt ? `<pre>SYNTHETIC INFRASTRUCTURE RECEIPT — NOT an employer application\n${esc(item.receipt)}</pre>` : ""}${["approved", "running"].includes(item.status) ? `<button class="secondary" data-executor-cancel="${item.id}">Cancel before commit</button>` : ""}</article>`).join("");
  const output = box.querySelector("#executor-result")!;
  const review = document.createElement("div"); output.after(review);
  box.querySelector("#executor-inspect")!.addEventListener("click", () => void busy(async () => {
    review.replaceChildren();
    const result = await api<GreenhouseResult | { form?: unknown }>("executor/inspect", "POST", { job_id: jobId });
    if (!box.isConnected) return;
    if ("inspection" in result) {
      review.innerHTML = greenhouseReview(result.inspection);
      mountPackageReview(review, jobId, result.inspection, drafts, api, busy, refresh);
      output.textContent = "Official public metadata inspected. No applicant data entered; execution remains disabled.";
    } else output.textContent = JSON.stringify(result, null, 2);
  }));
  box.querySelector("#executor-fixture")!.addEventListener("click", () => void busy(async () => {
    const result = await api("executor/fixture-check", "POST", { confirmation: "FICTIONAL INFRASTRUCTURE TEST ONLY" });
    if (box.isConnected) output.textContent = `FICTIONAL TEST ONLY — no real employer submission\n${JSON.stringify(result, null, 2)}`;
  }));
  box.querySelector("#executor-pause")!.addEventListener("click", () => void busy(async () => { await api("executor/pause", "POST", { paused: !state.paused }); await refresh(); }));
  box.querySelectorAll<HTMLButtonElement>("[data-executor-cancel]").forEach(button => button.addEventListener("click", () => void busy(async () => {
    await api("executor/action", "POST", { id: button.dataset.executorCancel, action: "cancel" }); await refresh();
  })));
  for (const id of ["#executor-inspect", "#executor-fixture"]) box.querySelector<HTMLButtonElement>(id)!.disabled = state.paused;
  mountPackageHistory(box, state.packages ?? [], jobId, api, busy, refresh);
}
