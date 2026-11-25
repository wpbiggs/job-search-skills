export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const BASE = "/job-search";
export const SCOPES = ["workspace:read", "workspace:write", "offline_access"];

export function token(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function hash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
export function cookie(request: Request, name: string): string | undefined {
  return request.headers.get("Cookie")?.split(";").map(x => x.trim()).find(x => x.startsWith(`${name}=`))?.slice(name.length + 1);
}
export function cookieHeader(name: string, value: string, maxAge: number, origin: string): string {
  return `${name}=${value}; HttpOnly; SameSite=Lax; Path=${name.startsWith("__Host-") ? "/" : BASE}; Max-Age=${maxAge}${origin.startsWith("https:") ? "; Secure" : ""}`;
}
export function sameOrigin(request: Request, origin: string): void {
  if (request.headers.get("Origin") !== origin || request.headers.get("Sec-Fetch-Site") === "cross-site") throw new HttpError(403, "A same-origin browser action is required.");
}
export async function boundedBody(request: Pick<Request, "body" | "headers">, max = 100_000): Promise<string> {
  if (Number(request.headers.get("Content-Length")) > max) throw new HttpError(413, "Request is too large.");
  const reader = request.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > max) { await reader.cancel(); throw new HttpError(413, "Request is too large."); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length); let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return new TextDecoder("utf-8", { fatal: true }).decode(result);
}
export async function jsonBody(request: Request, max = 100_000): Promise<unknown> {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) throw new HttpError(415, "Use application/json.");
  try { return JSON.parse(await boundedBody(request, max)); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, "Invalid JSON."); }
}
export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
export function contentSecurityPolicy(formRedirectOrigin = ""): string {
  return `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self' ${formRedirectOrigin}; frame-ancestors 'none'`;
}
export function secure(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  // Preserve same-origin form Origin checks, while suppressing referrers on external navigation.
  headers.set("Referrer-Policy", "same-origin");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), publickey-credentials-create=(self), publickey-credentials-get=(self)");
  if (!headers.has("Content-Security-Policy")) headers.set("Content-Security-Policy", contentSecurityPolicy());
  headers.set("X-Robots-Tag", "noindex, nofollow");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
export function publicJobUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpError(400, "A public HTTPS source URL is required."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !url.hostname.includes(".") || url.hostname.includes(":") || /^(\d+\.){3}\d+$/.test(url.hostname) || /(^|\.)(localhost|local|internal|test|invalid)$/.test(url.hostname)) throw new HttpError(400, "A public HTTPS source URL is required.");
  // These URLs are recorded, not fetched. The browser/harness must validate DNS and redirects.
  for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]) url.searchParams.delete(key);
  return url.href;
}
