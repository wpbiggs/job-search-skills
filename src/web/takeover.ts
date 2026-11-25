import { validLiveView, type TakeoverSummary } from "../takeover-controller.ts";
import { escapeHtml as esc } from "../security.ts";

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Busy = (action: () => Promise<void>) => Promise<void>;

/** Diagnostic only: the controller cannot open an employer or load candidate materials. */
export async function mountTakeover(container: Element, api: Api, busy: Busy) {
  const box = document.createElement("details");
  box.innerHTML = `<summary>Fictional takeover infrastructure check</summary><p>This is not an application workflow. It opens a blank, network-denied practice browser containing no candidate profile, documents or employer. Use fictional values only. One browser budget unit; two-minute authorization deadline with alarm-driven browser closure. Close failures remain pending for retry, not falsely reported closed. No automation resumes when practice ends.</p><label class="check"><input type="checkbox" data-practice-consent><span>I understand this is fictional practice only; I will not enter credentials or personal data.</span></label><button data-practice-start disabled>Start fictional takeover</button><button class="secondary" data-practice-status>Check practice status</button><div data-practice-state></div><div data-practice-link></div>`;
  container.append(box);
  const consent = box.querySelector<HTMLInputElement>("[data-practice-consent]")!, start = box.querySelector<HTMLButtonElement>("[data-practice-start]")!;
  const status = box.querySelector("[data-practice-state]")!, links = box.querySelector("[data-practice-link]")!;
  let current: TakeoverSummary | null = null, generation = 0, expiry: ReturnType<typeof setTimeout> | undefined;
  const discardLink = () => { generation++; links.replaceChildren(); clearTimeout(expiry); };
  const render = (takeover: TakeoverSummary | null) => {
    discardLink(); current = takeover && takeover.phase !== "closed" ? takeover : null;
    start.disabled = !consent.checked || Boolean(current);
    status.innerHTML = takeover ? `<p>Fictional practice: ${esc(takeover.phase)}. Ends by ${esc(takeover.expires_at)}. No application authority.</p>` : "<p>No active practice session.</p>";
    if (!current) return;
    if (current.phase === "paused") {
      const open = document.createElement("button"); open.className = "secondary"; open.textContent = "Get private fictional control link"; status.append(open);
      open.addEventListener("click", () => void busy(async () => {
        if (!current) return;
        discardLink(); const version = generation, id = current.id;
        const result = await api<{ takeover: TakeoverSummary; live_view_url: string }>("executor/takeover", "POST", { action: "view", id, confirmation: "OPEN PRIVATE FICTIONAL CONTROL" });
        if (!box.isConnected || generation !== version || current?.id !== id) return;
        if (!validLiveView(result.live_view_url) || Date.parse(result.takeover.expires_at) <= Date.now()) throw Error("Practice control link unavailable or expired.");
        const explanation = document.createElement("p"); explanation.textContent = "Private bearer link: do not share, save, screenshot or send it to an assistant. Open now; new connections expire quickly. Ending practice or server expiry closes the browser, including connected viewers.";
        const link = document.createElement("a"); link.href = result.live_view_url; link.target = "_blank"; link.rel = "noopener noreferrer"; link.referrerPolicy = "no-referrer"; link.textContent = "Open fictional practice browser";
        links.append(explanation, link);
        expiry = setTimeout(discardLink, Math.max(0, Math.min(30000, Date.parse(result.takeover.expires_at) - Date.now())));
      }));
    }
    for (const [action, label] of [["cancel", "Cancel practice and close browser"], ["complete", "End practice — do not resume automation"]]) {
      const button = document.createElement("button"); button.className = "secondary"; button.textContent = label; status.append(button);
      button.addEventListener("click", () => void busy(async () => {
        if (!current) return;
        const id = current.id; discardLink();
        const result = await api<{ takeover: TakeoverSummary | null }>("executor/takeover", "POST", { action, id });
        if (box.isConnected) render(result.takeover);
      }));
    }
  };
  consent.addEventListener("change", () => { start.disabled = !consent.checked || Boolean(current); });
  start.addEventListener("click", () => void busy(async () => {
    if (!consent.checked || current) throw Error("Confirm fictional practice scope first.");
    start.disabled = true;
    try {
      const result = await api<{ takeover: TakeoverSummary }>("executor/takeover", "POST", { action: "start_fixture", confirmation: "FICTIONAL TAKEOVER ONLY — NO PERSONAL DATA" });
      if (box.isConnected) render(result.takeover);
    } catch (error) { status.textContent = "Start result unknown. Check status before trying again; a browser may still be closing."; throw error; }
  }));
  const check = async () => {
    discardLink();
    const result = await api<{ takeover: TakeoverSummary | null }>("executor/takeover", "POST", { action: "status" });
    if (box.isConnected) render(result.takeover);
  };
  box.querySelector("[data-practice-status]")!.addEventListener("click", () => void busy(check));
  // Keep diagnostics lazy: ordinary job review must not create extra controller traffic.
  box.addEventListener("toggle", () => { if (box.open) void busy(check); else discardLink(); });
}
