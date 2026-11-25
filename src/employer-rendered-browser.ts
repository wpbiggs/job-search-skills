import type { BrowserContext, Page } from "@cloudflare/playwright";
import { greenhouseStaticAsset, renderedFormSchema, reviewRenderedForm, type RenderedObservation, type RenderedForm } from "./employer-rendered.ts";
import type { GreenhouseInspection } from "./employer-greenhouse.ts";

// Literal JavaScript avoids transpiler-injected helpers in serialized callbacks.
// The isolated world has clean built-ins even when the page replaces its own prototypes.
const describeSource = String.raw`async function(destination) {
    const form = document.forms.length === 1 ? document.forms[0] : null;
    if (!form) throw Error("Expected exactly one rendered form");
    const text = (element) => {
      if (element.closest("textarea,select,[contenteditable]")) return "";
      const clone = element.cloneNode(true);
      clone.querySelectorAll("input,textarea,select,[contenteditable],script,style,svg").forEach(element => element.remove());
      return (clone.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    };
    const elements = Array.from(form.querySelectorAll("input,textarea,select,[contenteditable=true]"));
    if (elements.length > 100) throw Error("Too many controls");
    const controls = elements.filter(element => !["submit", "button", "reset", "image"].includes(element.type)).map(element => {
      const input = element;
      const labels = Array.from(input.labels ?? []).map(text);
      const aria = input.getAttribute("aria-label"); if (aria) labels.push(aria.slice(0, 300));
      let parent = input.parentElement;
      for (let depth = 0; parent && parent !== form && depth < 7; depth++, parent = parent.parentElement) {
        for (const label of parent.querySelectorAll(":scope > label,:scope > legend,:scope > .label")) labels.push(text(label));
      }
      const unique = [...new Set(labels.filter(Boolean))].slice(0, 8);
      const type = input.tagName === "TEXTAREA" ? "textarea" : input.tagName === "SELECT" ? input.type : input.getAttribute("contenteditable") === "true" ? "contenteditable" : input.type;
      const options = input.tagName === "SELECT" ? Array.from(input.options).slice(0, 101).map(option => ({ value: option.value, label: option.textContent?.trim().slice(0, 300) ?? "" })) : [];
      return { id: input.id, name: input.name ?? "", type, role: input.getAttribute("role") ?? "", labels: unique,
        required_hint: Boolean(input.required) || input.getAttribute("aria-required") === "true" || unique.some(label => /\*\s*$/.test(label)),
        disabled: Boolean(input.disabled), readonly: input.hasAttribute("readonly"), visible: input.getClientRects().length > 0,
        accept: input.getAttribute("accept") ?? "", pattern: input.getAttribute("pattern") ?? "", max_length: Number(input.getAttribute("maxlength") ?? -1), options };
    });
    const submitControls = Array.from(form.querySelectorAll('button[type="submit"],button:not([type]),input[type="submit"],input[type="image"]'));
    if (submitControls.length > 10) throw Error("Too many final controls");
    const legal = [];
    for (const element of document.querySelectorAll("p,label,legend,a")) {
      const value = text(element);
      if (/\b(i agree|i certify|i attest|by submitting|consent|terms of|privacy policy|privacy notice)\b/i.test(value)) legal.push(value);
      if (legal.length > 20) throw Error("Too many legal notices");
    }
    const body = document.body.cloneNode(true);
    body.querySelectorAll("input,textarea,select,[contenteditable],script,style,svg").forEach(element => element.remove());
    const bodyText = (body.textContent ?? "").replace(/\s+/g, " ").trim();
    if (bodyText.length > 100000) throw Error("Public page text exceeds inspection bound");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bodyText));
    const result = { destination, action: form.action, method: form.method, enctype: form.enctype, controls,
      page_title: document.title, role_headings: Array.from(document.querySelectorAll("h1")).slice(0, 4).map(text), page_content_digest: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""),
      submit_controls: submitControls.map(element => ({ id: element.id, type: element.type, label: element.getAttribute("aria-label")?.slice(0, 300) || text(element), disabled: Boolean(element.disabled) })),
      legal_notices: [...new Set(legal)], challenge_present: Boolean(document.querySelector('[data-sitekey],iframe[src*="captcha"],iframe[src*="challenge"]')),
      password_present: Boolean(document.querySelector('input[type="password"]')), frames_present: Boolean(document.querySelector("iframe,frame")) };
    if (JSON.stringify(result).length > 20000) throw Error("Rendered snapshot too large");
    return result;
  }`;

export async function describeRenderedForm(page: Page, destination: string): Promise<RenderedForm> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { frameTree } = await cdp.send("Page.getFrameTree");
    if (frameTree.frame.url !== destination) throw Error("Unexpected rendered frame destination");
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: `inspection-${crypto.randomUUID()}`, grantUniveralAccess: false });
    const response = await cdp.send("Runtime.callFunctionOn", {
      functionDeclaration: describeSource, executionContextId, arguments: [{ value: destination }],
      awaitPromise: true, returnByValue: true, generatePreview: false, userGesture: false,
    });
    if (response.exceptionDetails || response.result.type !== "object") throw Error("Isolated rendered inspection failed");
    if (page.url() !== destination) throw Error("Rendered destination changed during inspection");
    return renderedFormSchema.parse(response.result.value);
  } finally { await cdp.detach(); }
}

/** Fresh context only. No inputs, uploads, final clicks, page-value reads or non-GET requests. */
export async function inspectGreenhouseRendered(context: BrowserContext, metadata: GreenhouseInspection) {
  const observed: RenderedObservation = { assets: [], blocked_writes: 0, blocked_active_resources: 0, blocked_decorative_resources: 0, blocked_websockets: 0, popup_attempts: 0, load_failures: 0, stable: true, request_limit_reached: false };
  const page = await context.newPage();
  let mainLoaded = false, requests = 0;
  const closing: Promise<void>[] = [];
  context.on("page", popup => { if (popup !== page) { observed.popup_attempts++; closing.push(popup.close().catch(() => {})); } });
  await context.routeWebSocket("**/*", async socket => { observed.blocked_websockets++; await socket.close(); });
  await context.route("**/*", async route => {
    const request = route.request();
    requests++;
    if (requests > 100) { observed.request_limit_reached = true; await route.abort(); return; }
    if (request.method() !== "GET") { observed.blocked_writes++; await route.abort(); return; }
    let mainFrame = false; try { mainFrame = request.frame() === page.mainFrame(); } catch { /* Worker requests have no permitted frame. */ }
    if (request.redirectedFrom() || !mainFrame) { observed.blocked_active_resources++; await route.abort(); return; }
    if (!mainLoaded && request.isNavigationRequest() && request.url() === metadata.destination) { mainLoaded = true; await route.fallback(); return; }
    if (!request.isNavigationRequest() && greenhouseStaticAsset(request.url(), request.resourceType())) { observed.assets.push(request.url()); await route.fallback(); return; }
    if (["image", "font", "media"].includes(request.resourceType())) observed.blocked_decorative_resources++;
    else observed.blocked_active_resources++;
    await route.abort();
  });
  page.on("requestfailed", request => { if (greenhouseStaticAsset(request.url(), request.resourceType())) observed.load_failures++; });
  page.on("response", response => { const request = response.request(); if (greenhouseStaticAsset(request.url(), request.resourceType()) && !response.ok()) observed.load_failures++; });
  try {
    const response = await page.goto(metadata.destination, { waitUntil: "domcontentloaded", timeout: 20000 });
    if (!response?.ok() || page.url() !== metadata.destination || !response.headers()["content-type"]?.toLowerCase().startsWith("text/html")) throw Error("Rendered opening unavailable, redirected or not HTML");
    try { await page.waitForLoadState("networkidle", { timeout: 5000 }); } catch { observed.stable = false; }
    const first = await describeRenderedForm(page, metadata.destination);
    const form = await describeRenderedForm(page, metadata.destination);
    if (JSON.stringify(first) !== JSON.stringify(form)) observed.stable = false;
    if (page.url() !== metadata.destination) throw Error("Rendered destination changed");
    return await reviewRenderedForm(metadata, form, observed);
  } finally { await Promise.allSettled(closing); }
}
