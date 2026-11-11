import { escapeHtml as esc } from "../security.ts";
import type { ExecutorRow } from "../executor-store.ts";

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export async function mountExecutor(section: Element, jobId: string, api: Api, busy: (action: () => Promise<void>) => Promise<void>, refresh: () => Promise<void>) {
  const box = document.createElement("section"); box.className = "box";
  box.innerHTML = `<h2>Constrained browser executor — gated pilot</h2><p><strong>Live final submission is locked.</strong> The repository still requires your final action and employer-specific adapters have not been validated. The browser can inspect the public application form without candidate data; it stops at authentication, CAPTCHA, legal/sensitive or unanticipated questions, redirects and unsupported ATS forms.</p><p>Inspection uses an isolated Cloudflare browser, no imported cookies, no AI model, no personal-field filling and no downloads. Read-only inspection still contacts the employer website. At most 10 browser sessions/day globally and five claimed attempts/day/account; no automatic retries.</p><div class="actions"><button id="executor-inspect" class="secondary" disabled>Inspect this employer form (no applicant data)</button><button id="executor-fixture" class="secondary" disabled>Test fictional ATS only</button></div><pre id="executor-result" role="status"></pre><div id="executor-controls"></div><div id="executor-attempts"></div>`;
  section.append(box);
  const state = await api<{ intents: ExecutorRow[]; paused: boolean }>("executor");
  if (!box.isConnected) return;
  box.querySelector("#executor-controls")!.innerHTML = `<p>Executor is ${state.paused ? "paused" : "not paused"}; live final submission remains locked either way.</p><button id="executor-pause" class="secondary">${state.paused ? "Resume preparation executor" : "Pause preparation executor"}</button>`;
  box.querySelector("#executor-attempts")!.innerHTML = state.intents.filter(item => item.job_id === jobId).map(item => `<article class="record"><p class="badge">${esc(item.status)}</p><p>${esc(item.reason)}</p><p class="wrap">Destination: ${esc(item.destination)}<br>Payload digest: ${esc(item.payload_digest)}<br>Attempt: ${esc(item.attempt_id ?? "Not started")}</p>${item.receipt ? `<pre>SYNTHETIC INFRASTRUCTURE RECEIPT — NOT an employer application\n${esc(item.receipt)}</pre>` : ""}${["approved", "running"].includes(item.status) ? `<button class="secondary" data-executor-cancel="${item.id}">Cancel before commit</button>` : ""}</article>`).join("");
  const output = box.querySelector("#executor-result")!;
  box.querySelector("#executor-inspect")!.addEventListener("click", () => void busy(async () => {
    const result = await api("executor/inspect", "POST", { job_id: jobId });
    if (box.isConnected) output.textContent = JSON.stringify(result, null, 2);
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
}
