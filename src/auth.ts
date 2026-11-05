import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
  type RegistrationResponseJSON, type AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { z } from "zod";
import { cookie, cookieHeader, hash, HttpError, jsonBody, token } from "./security.ts";
import type { SqlDatabase } from "./store.ts";

type AuthEnv = { DB: SqlDatabase; PUBLIC_ORIGIN: string; RP_ID: string };
export type User = { id: string; name: string; epoch: string; created_at: string };
const seconds = () => Math.floor(Date.now() / 1000);
const cookieName = (env: AuthEnv, kind: string) => `${env.PUBLIC_ORIGIN.startsWith("https:") ? "__Host-" : ""}jobsearch-${kind}`;

export async function signedIn(request: Request, env: AuthEnv): Promise<User | null> {
  const value = cookie(request, cookieName(env, "session"));
  if (!value || !/^[a-f0-9]{64}$/.test(value)) return null;
  return env.DB.prepare("SELECT users.id,users.name,users.epoch,users.created_at FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires>?").bind(await hash(value), seconds()).first<User>();
}
export async function requireUser(request: Request, env: AuthEnv): Promise<User> {
  const user = await signedIn(request, env);
  if (!user) throw new HttpError(401, "Sign in with your passkey to continue.");
  return user;
}
async function sessionResponse(env: AuthEnv, userId: string, data: Record<string, unknown>, status = 200): Promise<Response> {
  const value = token();
  await env.DB.prepare("INSERT INTO sessions(token_hash,user_id,expires) VALUES(?,?,?)").bind(await hash(value), userId, seconds() + 7 * 86400).run();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires<?").bind(seconds()),
    env.DB.prepare("DELETE FROM challenges WHERE expires<?").bind(seconds()),
    env.DB.prepare("DELETE FROM sessions WHERE user_id=? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY expires DESC LIMIT 10)").bind(userId, userId),
  ]);
  return Response.json(data, { status, headers: { "Set-Cookie": cookieHeader(cookieName(env, "session"), value, 7 * 86400, env.PUBLIC_ORIGIN) } });
}
async function challenge(env: AuthEnv, kind: string, payload: Record<string, unknown>): Promise<Response> {
  const value = token();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM challenges WHERE expires<?").bind(seconds()),
    env.DB.prepare("INSERT INTO challenges(id,kind,payload,expires) VALUES(?,?,?,?)").bind(await hash(value), kind, JSON.stringify(payload), seconds() + 300),
  ]);
  return Response.json({ options: payload.options }, { headers: { "Set-Cookie": cookieHeader(cookieName(env, "challenge"), value, 300, env.PUBLIC_ORIGIN) } });
}
async function consumeChallenge(request: Request, env: AuthEnv, kind: string): Promise<Record<string, unknown>> {
  const value = cookie(request, cookieName(env, "challenge"));
  if (!value) throw new HttpError(400, "Start a new passkey request in this browser.");
  const row = await env.DB.prepare("DELETE FROM challenges WHERE id=? AND kind=? AND expires>? RETURNING payload").bind(await hash(value), kind, seconds()).first<{ payload: string }>();
  if (!row) throw new HttpError(400, "This passkey request expired or was already used. Start again.");
  return JSON.parse(row.payload);
}

export async function authRoute(request: Request, env: AuthEnv, action: string): Promise<Response> {
  if (request.method !== "POST") throw new HttpError(405, "Use POST.");
  if (action === "register/options") {
    const body = z.object({ name: z.string().trim().min(1).max(80), consent: z.literal(true) }).strict().parse(await jsonBody(request, 2000));
    const existing = await signedIn(request, env);
    const userId = existing?.id ?? crypto.randomUUID();
    const credentials = existing ? (await env.DB.prepare("SELECT id FROM credentials WHERE user_id=?").bind(userId).all<{ id: string }>()).results : [];
    if (credentials.length >= 5) throw new HttpError(409, "This workspace already has five passkeys.");
    const options = await generateRegistrationOptions({
      rpName: "Job Search Workspace", rpID: env.RP_ID, userID: new TextEncoder().encode(userId), userName: existing?.name ?? body.name,
      attestationType: "none", supportedAlgorithmIDs: [-7, -257],
      excludeCredentials: credentials.map(x => ({ id: x.id })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    return challenge(env, "register", { options, userId, name: existing?.name ?? body.name, existing: Boolean(existing) });
  }
  if (action === "register/verify") {
    const body = z.object({ response: z.unknown() }).strict().parse(await jsonBody(request, 30000));
    const stored = await consumeChallenge(request, env, "register");
    const userId = stored.userId as string;
    if (stored.existing && (await requireUser(request, env)).id !== userId) throw new HttpError(403, "Passkey belongs to another workspace.");
    let result;
    try {
      result = await verifyRegistrationResponse({ response: body.response as RegistrationResponseJSON, expectedChallenge: (stored.options as { challenge: string }).challenge, expectedOrigin: env.PUBLIC_ORIGIN, expectedRPID: env.RP_ID, requireUserVerification: true });
    } catch { throw new HttpError(400, "Passkey verification failed. Try again."); }
    if (!result.verified || !result.registrationInfo) throw new HttpError(400, "Passkey verification failed.");
    const recoveryCode = stored.existing ? undefined : token();
    const { credential } = result.registrationInfo;
    const insert = env.DB.prepare("INSERT INTO credentials(id,user_id,public_key,counter,transports) VALUES(?,?,?,?,?)").bind(credential.id, userId, JSON.stringify(Array.from(credential.publicKey)), credential.counter, JSON.stringify(credential.transports ?? []));
    await env.DB.batch(recoveryCode ? [
      env.DB.prepare("INSERT INTO users(id,name,epoch,recovery_hash) VALUES(?,?,?,?)").bind(userId, stored.name, token(), await hash(recoveryCode)), insert,
    ] : [insert]);
    return sessionResponse(env, userId, { ok: true, recovery_code: recoveryCode, message: recoveryCode ? "Save your recovery code offline. It is shown only once; there is no email recovery." : "Additional passkey saved." }, 201);
  }
  if (action === "login/options") {
    await jsonBody(request, 1000);
    const options = await generateAuthenticationOptions({ rpID: env.RP_ID, userVerification: "required" });
    return challenge(env, "login", { options });
  }
  if (action === "login/verify") {
    const body = z.object({ response: z.unknown() }).strict().parse(await jsonBody(request, 30000));
    const stored = await consumeChallenge(request, env, "login");
    const response = body.response as AuthenticationResponseJSON;
    const credential = await env.DB.prepare("SELECT id,user_id,public_key,counter,transports FROM credentials WHERE id=?").bind(response?.id ?? "").first<{ id: string; user_id: string; public_key: string; counter: number; transports: string }>();
    if (!credential) throw new HttpError(400, "Passkey verification failed.");
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response, expectedChallenge: (stored.options as { challenge: string }).challenge, expectedOrigin: env.PUBLIC_ORIGIN, expectedRPID: env.RP_ID, requireUserVerification: true,
        credential: { id: credential.id, publicKey: new Uint8Array(JSON.parse(credential.public_key)), counter: credential.counter, transports: JSON.parse(credential.transports) as string[] },
      });
    } catch { throw new HttpError(400, "Passkey verification failed."); }
    if (!result.verified) throw new HttpError(400, "Passkey verification failed.");
    await env.DB.prepare("UPDATE credentials SET counter=? WHERE id=? AND counter=?").bind(result.authenticationInfo.newCounter, credential.id, credential.counter).run();
    return sessionResponse(env, credential.user_id, { ok: true });
  }
  if (action === "recover") {
    const body = z.object({ recovery_code: z.string().regex(/^[a-f0-9]{64}$/), consent: z.literal(true) }).strict().parse(await jsonBody(request, 2000));
    const replacement = token();
    const user = await env.DB.prepare("UPDATE users SET recovery_hash=?,epoch=? WHERE recovery_hash=? RETURNING id").bind(await hash(replacement), token(), await hash(body.recovery_code)).first<{ id: string }>();
    if (!user) throw new HttpError(400, "Invalid or previously used recovery code.");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(user.id),
      env.DB.prepare("DELETE FROM credentials WHERE user_id=?").bind(user.id),
    ]);
    return sessionResponse(env, user.id, { ok: true, recovery_code: replacement, message: "Old code, passkeys, sessions, and assistant connections revoked. Save the replacement, then add a new passkey on this device." });
  }
  if (action === "logout") {
    const value = cookie(request, cookieName(env, "session"));
    if (value) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await hash(value)).run();
    return Response.json({ ok: true }, { headers: { "Set-Cookie": cookieHeader(cookieName(env, "session"), "", 0, env.PUBLIC_ORIGIN) } });
  }
  throw new HttpError(404, "Not found.");
}
