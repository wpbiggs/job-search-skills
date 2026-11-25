import type { BrowserContext, Page } from "@cloudflare/playwright";
import { fingerprintForm, ordinaryField, validatePayload, type ExecutorForm, type ExecutorPayload, type ExecutorResult } from "./executor-contract.ts";
import { hash } from "./security.ts";

/** A deliberately non-LLM adapter. Site JavaScript, subresources, popups and redirects never receive applicant data. */
export async function describeForm(page: Page, destination: string): Promise<ExecutorForm> {
  const raw = await page.evaluate(() => {
    if (document.querySelector('iframe,[data-sitekey],input[type=password],input[type=checkbox],input[type=radio],select,[contenteditable=true]')) throw new Error("Authentication, consent, sensitive or unsupported questions require the candidate.");
    const forms = Array.from(document.forms);
    if (forms.length !== 1) throw new Error("Expected exactly one supported application form.");
    const form = forms[0];
    if (/\b(i certify|i attest|i agree|consent|by (submitting|clicking)|terms of (use|service)|privacy (notice|policy))\b/i.test(form.textContent ?? "")) throw new Error("Legal attestation requires the candidate.");
    if (form.method.toLowerCase() !== "post" || form.enctype !== "multipart/form-data") throw new Error("This ATS requires a separately tested adapter.");
    if (form.querySelectorAll('input[type=submit],button[type=submit],button:not([type])').length !== 1) throw new Error("Ambiguous final action requires the candidate.");
    const inputs = Array.from(form.querySelectorAll("input,textarea")).filter(input => (input as HTMLInputElement).type !== "submit");
    if (inputs.length > 25) throw new Error("Too many form fields.");
    const fields = inputs.map(input => {
      const element = input as HTMLInputElement | HTMLTextAreaElement;
      const type = element.tagName === "TEXTAREA" ? "textarea" : (element as HTMLInputElement).type;
      if (!["text", "email", "tel", "textarea", "file", "hidden"].includes(type) || element.disabled || !element.name) throw new Error("Unsupported or unnamed field.");
      const label = element.labels?.[0]?.textContent?.trim() || element.getAttribute("aria-label") || element.name;
      if (label.length > 200 || element.name.length > 80 || (type === "hidden" && element.value.length > 2000)) throw new Error("Oversized form metadata.");
      if (type === "file") {
        const accept = (element as HTMLInputElement).accept.toLowerCase();
        if (accept && !accept.split(",").some(value => [".txt", "text/plain", "text/*"].includes(value.trim()))) throw new Error("ATS does not accept the exact reviewed plain-text résumé; another document adapter is required.");
      }
      return { name: element.name, label, type, required: element.required, ...(type === "hidden" ? { value: element.value } : {}) };
    });
    return { action: form.action, method: "post" as const, fields, title: document.title.slice(0, 300) };
  });
  const fields = raw.fields.map(field => ({ ...field, type: field.type as ExecutorForm["fields"][number]["type"] }));
  if (fields.some(field => !ordinaryField(field))) throw new Error("Sensitive or unexpected field requires the candidate.");
  if (new Set(fields.map(field => field.name)).size !== fields.length) throw new Error("Duplicate form fields are unsupported.");
  if (new URL(raw.action).origin !== new URL(destination).origin) throw new Error("Off-origin form action requires reapproval.");
  return fingerprintForm({ ...raw, fields, destination });
}

export async function inspectBrowser(context: BrowserContext, destination: string): Promise<ExecutorForm> {
  const page = await context.newPage();
  await context.route("**/*", route => {
    const request = route.request();
    return request.url() === destination && request.method() === "GET" && request.isNavigationRequest() && !request.redirectedFrom() && request.frame() === page.mainFrame()
      ? route.continue() : route.abort();
  });
  const response = await page.goto(destination, { waitUntil: "domcontentloaded", timeout: 15000 });
  if (!response?.ok() || page.url() !== destination) throw new Error("Opening is unavailable, redirected, or requires authentication.");
  return describeForm(page, destination);
}

export async function runBrowser(context: BrowserContext, form: ExecutorForm, input: ExecutorPayload, commit: () => Promise<boolean>, fixtureOrigin: string): Promise<ExecutorResult> {
  // No live employer final action is permitted by the current repository contract.
  if (new URL(form.destination).origin !== fixtureOrigin || new URL(form.destination).pathname !== "/job-search/workspace/executor-fixture") return { status: "needs_user", reason: "Live final submission is disabled: current candidate-control policy and a tested employer-specific receipt adapter are required." };
  const payload = await validatePayload(form, input);
  const page = await context.newPage();
  let sent = false, violation = false;
  let responseBody: string | undefined;
  let canSubmit = false;
  await context.route("**/*", async route => {
    const request = route.request();
    if (!request.isNavigationRequest() || request.frame() !== page.mainFrame() || request.redirectedFrom()) { violation = true; await route.abort(); return; }
    if (!canSubmit && request.method() === "GET" && request.url() === form.destination) { await route.continue(); return; }
    if (!canSubmit || sent || request.method() !== "POST" || request.url() !== form.action) { violation = true; await route.abort(); return; }
    try {
      const body = request.postDataBuffer();
      if (!body || body.byteLength > 100000) throw new Error("Oversize submission");
      const parsed = await new Request(form.action, { method: "POST", headers: { "Content-Type": request.headers()["content-type"] }, body: Uint8Array.from(body).buffer }).formData();
      const expected = new Map(payload.fields.map(field => [field.name, field.value]));
      for (const field of form.fields.filter(field => field.type === "hidden")) expected.set(field.name, field.value ?? "");
      const fileField = form.fields.find(field => field.type === "file")!;
      const file = parsed.get(fileField.name);
      if (!(file instanceof File) || file.name !== payload.document.name || await hash(await file.text()) !== payload.document.digest) throw new Error("Document changed");
      if (Array.from(parsed.keys()).length !== expected.size + 1 || Array.from(expected).some(([key, value]) => parsed.get(key) !== value)) throw new Error("Payload changed");
      if (!await commit()) throw new Error("Approval was cancelled, paused, expired or changed");
      sent = true;
      const response = await route.fetch({ maxRedirects: 0, timeout: 10000 });
      if (response.status() !== 200 || response.headers()["location"]) throw new Error("Uncertain result");
      const text = await response.text();
      if (text.length > 2000) throw new Error("Uncertain result");
      responseBody = text;
      await route.fulfill({ response });
    } catch { violation = true; await route.abort(); }
  });
  try {
    const response = await page.goto(form.destination, { waitUntil: "domcontentloaded", timeout: 15000 });
    if (!response?.ok()) throw new Error("Form unavailable");
    if ((await describeForm(page, form.destination)).fingerprint !== form.fingerprint) return { status: "needs_user", reason: "Application form changed. Inspect and approve a fresh snapshot." };
    for (const field of payload.fields) await page.locator(`[name="${field.name}"]`).fill(field.value, { timeout: 2000 });
    const fileField = form.fields.find(field => field.type === "file")!;
    await page.locator(`[name="${fileField.name}"]`).setInputFiles({ name: payload.document.name, mimeType: "text/plain", buffer: Buffer.from(payload.document.content) });
    if (violation) throw new Error("Unexpected outbound action blocked");
    canSubmit = true;
    await page.locator('form button[type=submit],form button:not([type]),form input[type=submit]').click({ timeout: 12000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 12000 });
    if (responseBody) {
      const receipt: unknown = JSON.parse(responseBody);
      if (typeof receipt === "object" && receipt && "synthetic" in receipt && receipt.synthetic === true && "document_digest" in receipt && receipt.document_digest === payload.document.digest && "receipt" in receipt && typeof receipt.receipt === "string" && /^fixture-[a-f0-9]{64}$/.test(receipt.receipt))
        return { status: "fixture_verified", reason: "Owned fictional ATS only; this is NOT a real application.", receipt: { id: receipt.receipt, response_digest: await hash(responseBody), received_at: new Date().toISOString(), synthetic: true } };
    }
  } catch { /* No raw page, payload or exception content leaves the browser service. */ }
  return { status: sent ? "uncertain" : "needs_user", reason: sent ? "A write may have occurred but no verified receipt was obtained. Never retry automatically." : "No submission sent. Form, network, approval or policy requires review." };
}
