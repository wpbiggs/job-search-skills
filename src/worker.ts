import { OAuthAuthorizationServer, OAuthResourceServer, OAuthError, AuthorizationError, insufficientScope } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { authRoute, requireUser, signedIn } from "./auth.ts";
import { createServer } from "./mcp.ts";
import { workflows } from "./workflows.ts";
import { BASE, boundedBody, contentSecurityPolicy, escapeHtml, hash, HttpError, jsonBody, sameOrigin, SCOPES, secure, token } from "./security.ts";
import { kindSchema, saveSchema, WorkspaceStore } from "./store.ts";

type Env = Cloudflare.Env;
const propsSchema = z.object({ userId: z.string().uuid(), epoch: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type Props = z.infer<typeof propsSchema>;

function authorization(env: Env): OAuthAuthorizationServer<Env> {
  return new OAuthAuthorizationServer<Env>({
    issuer: `${env.PUBLIC_ORIGIN}${BASE}`, resources: [`${env.PUBLIC_ORIGIN}${BASE}/mcp`],
    authorizeEndpoint: `${BASE}/oauth/authorize`, tokenEndpoint: `${BASE}/oauth/token`,
    clientRegistrationEndpoint: `${BASE}/oauth/register`, scopesSupported: SCOPES,
    clientIdMetadataDocumentEnabled: true, accessTokenTTL: 600, refreshTokenTTL: 30 * 86400,
    async tokenExchangeCallback({ props, scope, env: currentEnv }) {
      const parsed = propsSchema.safeParse(props);
      const row = parsed.success ? await currentEnv.DB.prepare("SELECT epoch FROM users WHERE id=?").bind(parsed.data.userId).first<{ epoch: string }>() : null;
      if (!parsed.success || row?.epoch !== parsed.data.epoch) throw new OAuthError("invalid_grant", { description: "Workspace connection revoked. Connect again from the website.", statusCode: 400 });
      return { accessTokenProps: parsed.data, newProps: parsed.data, refreshTokenTTL: scope.includes("offline_access") ? 30 * 86400 : 0 };
    },
    // Do not log OAuth URLs, tokens, or client-provided descriptions.
    onError() { return undefined; },
  });
}

async function authorize(request: Request, env: Env, server: OAuthAuthorizationServer<Env>): Promise<Response> {
  const oauth = server.getOAuthApi(env);
  if (request.method === "GET") {
    const authRequest = await oauth.parseAuthRequest(request);
    const user = await signedIn(request, env);
    if (!user) {
      const url = new URL(request.url);
      return Response.redirect(`${env.PUBLIC_ORIGIN}${BASE}/workspace?returnTo=${encodeURIComponent(url.pathname + url.search)}`, 302);
    }
    if ((await oauth.listUserGrants(user.id, { limit: 30 })).items.length >= 20) throw new HttpError(409, "Connection limit reached. Revoke old connections on the workspace website first.");
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    consent.headers.set("Content-Type", "text/html; charset=utf-8");
    // Some browsers apply form-action to the post-consent redirect too. Permit only the validated client's origin.
    consent.headers.set("Content-Security-Policy", contentSecurityPolicy(new URL(authRequest.redirectUri).origin));
    const selectedScope = authRequest.scope.length ? authRequest.scope.filter(value => SCOPES.includes(value)) : ["workspace:read"];
    if (!selectedScope.includes("workspace:read")) selectedScope.unshift("workspace:read");
    const scope = SCOPES;
    const labels: Record<string, string> = { "workspace:read": "Read your profile, sourced experience, jobs, drafts, interview notes, and activity. Your AI provider may process these private records.", "workspace:write": "Save and edit preparation records. Cannot approve drafts, mark submitted, delete data, or contact employers.", "offline_access": "Stay connected for up to 30 days, including harness-supported scheduled runs. You can revoke access at any time." };
    return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect your assistant — Job Search</title><link rel="stylesheet" href="${BASE}/workspace/style.css"></head><body><main class="consent"><a href="${BASE}/workspace">← My workspace</a><p class="eyebrow">Your assistant, your permission</p><h1>Connect ${escapeHtml(details.clientName)}?</h1><p>Signed in as <strong>${escapeHtml(user.name)}</strong>.</p><p>Authorization will return to <strong>${escapeHtml(details.redirectHost)}</strong>${details.redirectIsLoopback ? " (an app on your computer)" : ""}. ${details.clientDomain ? `Verified client metadata domain: ${escapeHtml(details.clientDomain)}.` : "Client names are self-reported, not endorsements."}</p><form method="post"><input type="hidden" name="handle" value="${escapeHtml(consent.handle)}">${scope.map(value => `<label class="check"><input type="checkbox" name="scope" value="${escapeHtml(value)}" ${value === "workspace:read" ? "checked required" : selectedScope.includes(value) ? "checked" : ""}><span><strong>${escapeHtml(value)}</strong><br>${escapeHtml(labels[value])}</span></label>`).join("")}<p>Enable workspace:write if you want your assistant to save preparation records. Offline access is optional; without it, reconnect after the 10-minute access token expires.</p><p>No AI API key is required. You control final submissions and disclosures. Grant only the access you want this client to have.</p><div class="actions"><button name="decision" value="approve">Allow selected access</button><button name="decision" value="deny" class="secondary" formnovalidate>Deny</button></div></form></main></body></html>`, { headers: consent.headers });
  }
  if (request.method !== "POST") throw new HttpError(405, "Use GET or POST.");
  sameOrigin(request, env.PUBLIC_ORIGIN);
  const user = await requireUser(request, env);
  if (!request.headers.get("Content-Type")?.startsWith("application/x-www-form-urlencoded")) throw new HttpError(415, "Use the consent form.");
  const form = new URLSearchParams(await boundedBody(request, 12000));
  const handle = form.get("handle") ?? "";
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const scope = form.getAll("scope");
  if (!scope.includes("workspace:read") || scope.some(value => !SCOPES.includes(value))) throw new HttpError(400, "Select valid scopes including workspace:read.");
  const approved = await oauth.approveConsent(request, handle, { scope });
  const { redirectTo } = await oauth.completeAuthorization({ request: approved.request, userId: user.id, metadata: { epoch: user.epoch }, scope, props: { userId: user.id, epoch: user.epoch } satisfies Props });
  approved.headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}

async function revokeAll(env: Env, server: OAuthAuthorizationServer<Env>, userId: string): Promise<void> {
  // The strongly consistent epoch check denies every old token even while KV revocation propagates.
  await env.DB.prepare("UPDATE users SET epoch=? WHERE id=?").bind(token(), userId).run();
  const oauth = server.getOAuthApi(env);
  let cursor: string | undefined;
  do {
    const grants = await oauth.listUserGrants(userId, { limit: 100, cursor });
    for (const grant of grants.items) await oauth.revokeGrant(grant.id, userId);
    cursor = grants.cursor;
  } while (cursor);
}

async function api(request: Request, env: Env, path: string, server: OAuthAuthorizationServer<Env>): Promise<Response> {
  if (request.method !== "GET") sameOrigin(request, env.PUBLIC_ORIGIN);
  if (path.startsWith("auth/")) return authRoute(request, env, path.slice(5));
  const user = await requireUser(request, env);
  const store = new WorkspaceStore(env.DB, user.id, "website");
  if ((path === "import/preview" || path === "import/confirm") && request.method === "POST") {
    const body = z.object({ snapshot: z.unknown(), confirmation: z.literal("IMPORT PREPARATION").optional(), expected_digest: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().parse(await jsonBody(request, 4 * 1024 * 1024));
    if (path === "import/preview") return Response.json({ preview: await store.previewImport(body.snapshot) });
    if (body.confirmation !== "IMPORT PREPARATION" || !body.expected_digest) throw new HttpError(400, "Validate the file and explicitly confirm preparation import first.");
    return Response.json({ imported: await store.importPreparation(body.snapshot, body.expected_digest) });
  }
  if (path === "state" && request.method === "GET") {
    const grants = await server.getOAuthApi(env).listUserGrants(user.id, { limit: 30 });
    return Response.json({ user: { name: user.name, created_at: user.created_at }, usage: await store.usage(), records: await store.list(), reviews: await store.reviews(), outcomes: await store.outcomes(), connections: grants.items.map(grant => ({ id: grant.id, clientId: grant.clientId, scope: grant.scope, createdAt: grant.createdAt, current: grant.metadata?.epoch === user.epoch })) });
  }
  if (path === "export" && request.method === "GET") return Response.json(await store.export(), { headers: { "Content-Disposition": 'attachment; filename="job-search-workspace.json"' } });
  if (path.startsWith("versions/") && request.method === "GET") return Response.json({ versions: await store.versions(z.string().uuid().parse(path.slice(9))) });
  if (path === "records" && request.method === "POST") return Response.json({ record: await store.save(saveSchema.parse(await jsonBody(request))) });
  if (path.startsWith("records/") && request.method === "DELETE") {
    const id = z.string().uuid().parse(path.slice(8));
    const body = z.object({ confirmation: z.literal("DELETE RECORD"), expected_revision: z.number().int().positive() }).strict().parse(await jsonBody(request, 1000));
    await store.removeRecord(id, body.expected_revision); return Response.json({ ok: true });
  }
  if (path === "review" && request.method === "POST") {
    const body = z.object({ job_id: z.string().uuid(), review: z.unknown() }).strict().parse(await jsonBody(request, 6000));
    await store.review(body.job_id, body.review); return Response.json({ ok: true });
  }
  if (path === "outcome" && request.method === "POST") {
    const body = z.object({ job_id: z.string().uuid(), outcome: z.unknown() }).strict().parse(await jsonBody(request, 6000));
    await store.outcome(body.job_id, body.outcome); return Response.json({ ok: true });
  }
  if (path === "connections/revoke" && request.method === "POST") {
    z.object({ confirmation: z.literal("REVOKE CONNECTIONS") }).strict().parse(await jsonBody(request, 1000));
    await revokeAll(env, server, user.id); await store.event("revoke_connections"); return Response.json({ ok: true });
  }
  if (path === "delete" && request.method === "POST") {
    z.object({ confirmation: z.literal("DELETE MY WORKSPACE") }).strict().parse(await jsonBody(request, 1000));
    await revokeAll(env, server, user.id);
    await env.DB.prepare("DELETE FROM users WHERE id=?").bind(user.id).run();
    return Response.json({ ok: true, message: "Active workspace records, passkeys, recovery code, sessions, and connections deleted. Hosting backups may persist for the provider's retention period; exports or copies held by your AI provider are not deleted by this action." });
  }
  if (path === "events" && request.method === "GET") return Response.json({ events: await store.events() });
  if (path === "records" && request.method === "GET") {
    const kind = new URL(request.url).searchParams.get("kind");
    return Response.json({ records: await store.list(kind ? kindSchema.parse(kind) : undefined) });
  }
  throw new HttpError(404, "Not found.");
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.origin !== env.PUBLIC_ORIGIN) throw new HttpError(403, "Unrecognized host.");
      if (request.method === "TRACE" || request.method === "CONNECT") throw new HttpError(405, "Method not allowed.");
      const server = authorization(env);
      let response: Response;
      if (url.pathname === `${BASE}/workspace` || url.pathname === `${BASE}/workspace/`) {
        if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "Use GET.");
        response = await env.ASSETS.fetch(new Request(`${env.PUBLIC_ORIGIN}${BASE}/workspace/index.html`, request));
      } else if ([`${BASE}/workspace/app.js`, `${BASE}/workspace/style.css`].includes(url.pathname)) {
        response = await env.ASSETS.fetch(request);
      } else {
        const isAuth = url.pathname.startsWith(`${BASE}/api/auth/`) || url.pathname === `${BASE}/oauth/register`;
        const ip = request.headers.get("CF-Connecting-IP") ?? "local";
        const limiter = isAuth ? env.AUTH_LIMIT : env.REQUEST_LIMIT;
        if (!(await limiter.limit({ key: await hash(`${ip}:${isAuth ? "auth" : "requests"}`) })).success) throw new HttpError(429, "Too many requests. Try again in a minute.");
        if (url.pathname === `${BASE}/oauth/authorize`) response = await authorize(request, env, server);
        else if (url.pathname.startsWith(`${BASE}/api/`)) response = await api(request, env, url.pathname.slice(`${BASE}/api/`.length), server);
        else if (url.pathname === `${BASE}/mcp` || url.pathname === `/.well-known/oauth-protected-resource${BASE}/mcp`) {
          const resource = new OAuthResourceServer<Env, Props>({
            resourceMetadata: { resource: `${env.PUBLIC_ORIGIN}${BASE}/mcp`, authorization_servers: [`${env.PUBLIC_ORIGIN}${BASE}`] },
            requiredScopes: ["workspace:read"],
            validateToken: () => async (resource, value) => {
              const verified = await server.validateToken<Props>(resource, value, env);
              const parsed = propsSchema.safeParse(verified?.props);
              if (!verified || !parsed.success) return null;
              const user = await env.DB.prepare("SELECT epoch FROM users WHERE id=?").bind(parsed.data.userId).first<{ epoch: string }>();
              return user?.epoch === parsed.data.epoch ? verified : null;
            },
            handler: { async fetch(req, currentEnv, context) {
              if (!context.auth.scope.includes("workspace:read")) return insufficientScope(context.auth, ["workspace:read"]);
              // Token-only access: browser cookies cannot authenticate MCP, nor can an MCP token authorize website actions.
              if (req.method === "POST") {
                const payload = await boundedBody(req);
                req = new Request(req, { body: payload });
              }
              return createMcpHandler(() => createServer(new WorkspaceStore(currentEnv.DB, context.props.userId, "assistant"), context.auth.scope, workflows), {
                route: `${BASE}/mcp`, authContext: { props: context.props }, responseMode: "json", corsOptions: false,
                allowedHostnames: [new URL(env.PUBLIC_ORIGIN).hostname], allowedOriginHostnames: [new URL(env.PUBLIC_ORIGIN).hostname, "chatgpt.com", "claude.ai"],
              })(req, currentEnv, context);
            } },
          });
          response = await resource.fetch(request, env, ctx);
        } else if (url.pathname.startsWith(`${BASE}/oauth/`) || url.pathname.startsWith(`/.well-known/oauth-authorization-server${BASE}`)) {
          if (request.method === "POST") {
            const payload = await boundedBody(request, 20000);
            request = new Request(request, { body: payload });
          }
          response = await server.fetch(request, env, ctx);
        } else throw new HttpError(404, "Not found.");
      }
      return secure(response);
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return secure(Response.redirect(error.redirectTo, 302));
      if (error instanceof HttpError) return secure(Response.json({ error: error.message }, { status: error.status }));
      if (error instanceof z.ZodError || error instanceof AuthorizationError) return secure(Response.json({ error: "Invalid request. Check the fields and try again." }, { status: 400 }));
      console.error(JSON.stringify({ event: "request_failed", category: "internal_error" }));
      return secure(Response.json({ error: "Service temporarily unavailable. Please try again." }, { status: 503 }));
    }
  },
} satisfies ExportedHandler<Env>;
