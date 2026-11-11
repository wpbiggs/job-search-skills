import { launch } from "@cloudflare/playwright";
import { z } from "zod";
import { employerUrl, formSchema, payloadSchema, EXECUTOR_FIXTURE_DOCUMENT } from "../../src/executor-contract.ts";
import { inspectBrowser, runBrowser } from "../../src/executor-browser.ts";
import { hash, jsonBody } from "../../src/security.ts";

const command = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("inspect"), destination: z.string().max(2048) }).strict(),
  z.object({ operation: z.literal("fixture") }).strict(),
  z.object({ operation: z.literal("run"), id: z.string().uuid(), user_id: z.string().uuid(), nonce: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);

// No routes, workers.dev or preview URL. The only caller is an account-scoped private service binding.
export default {
  async fetch(request: Request, env: ExecutorBindings): Promise<Response> {
    if (request.method !== "POST" || request.url !== "https://executor.internal/run") return new Response(null, { status: 404 });
    if (String(env.EXECUTOR_DISABLED) === "true") return Response.json({ status: "needs_user", reason: "Executor disabled by operator." }, { status: 503 });
    let browser: Awaited<ReturnType<typeof launch>> | undefined;
    let leaseId: string | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let deadlineClose: Promise<void> | undefined;
    try {
      const input = command.parse(await jsonBody(request, 2000));
      const hosts = env.ALLOWED_HOSTS.split(",");
      let row: { destination: string; form: string; payload: string } | null = null;
      if (input.operation === "run") {
        row = await env.DB.prepare("SELECT destination,form,payload FROM delegated_intents WHERE id=? AND user_id=? AND nonce_hash=? AND status='running' AND expires_at>?").bind(input.id, input.user_id, await hash(input.nonce), new Date().toISOString()).first();
        if (!row) return Response.json({ status: "needs_user", reason: "No current one-use claim." });
        if (new URL(row.destination).origin !== env.FIXTURE_ORIGIN) return Response.json({ status: "needs_user", reason: "Live final submission is disabled by the candidate-control contract and pending employer-adapter validation." });
      }
      const destination = employerUrl(input.operation === "fixture" ? `${env.FIXTURE_ORIGIN}/job-search/workspace/executor-fixture` : input.operation === "inspect" ? input.destination : row!.destination, hosts);
      const now = new Date().toISOString();
      await env.DB.prepare("DELETE FROM executor_browser_leases WHERE expires_at<=?").bind(now).run();
      const lease = crypto.randomUUID();
      const acquired = await env.DB.prepare("INSERT INTO executor_browser_leases(id,expires_at) SELECT ?,? WHERE (SELECT count(*) FROM executor_browser_leases)<2 RETURNING id").bind(lease, new Date(Date.now() + 120000).toISOString()).first();
      if (!acquired) return Response.json({ status: "needs_user", reason: "Two isolated browser sessions are already running; no automatic retry." }, { status: 429 });
      leaseId = lease;
      const quota = await env.DB.prepare("INSERT INTO executor_budget(day,used) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET used=used+1 WHERE used<10 RETURNING used").bind(new Date().toISOString().slice(0, 10)).first();
      await env.DB.prepare("DELETE FROM executor_budget WHERE day<?").bind(new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)).run();
      if (!quota) return Response.json({ status: "needs_user", reason: "Global browser budget reached (10 sessions/day); no automatic retries." }, { status: 429 });
      browser = await launch(env.BROWSER, { guardrails: { allowedDomains: [new URL(destination).hostname] }, keep_alive: 60000 });
      deadline = setTimeout(() => { deadlineClose = browser!.close().catch(() => {}); }, 45000);
      const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block", acceptDownloads: false });
      context.setDefaultTimeout(10000);
      if (input.operation === "inspect") {
        try { return Response.json({ form: await inspectBrowser(context, destination), live_submission_enabled: false }); }
        catch { return Response.json({ status: "needs_user", reason: "This opening has an authentication, challenge, redirect, sensitive question, unsupported form or untested ATS adapter. No applicant data was entered." }); }
      }
      if (input.operation === "fixture") {
        const form = await inspectBrowser(context, destination);
        const execution = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block", acceptDownloads: false });
        const content = EXECUTOR_FIXTURE_DOCUMENT;
        return Response.json(await runBrowser(execution, form, { fields: [{ name: "name", value: "Fictional Candidate" }, { name: "email", value: "fixture@example.invalid" }], document: { name: "resume.txt", content, digest: await hash(content) } }, async () => true, env.FIXTURE_ORIGIN));
      }
      const id = input.id, userId = input.user_id, nonceHash = await hash(input.nonce);
      const result = await runBrowser(context, formSchema.parse(JSON.parse(row!.form)), payloadSchema.parse(JSON.parse(row!.payload)), async () => {
        const claimed = await env.DB.prepare(`UPDATE delegated_intents SET status='committing',updated_at=? WHERE id=? AND user_id=? AND nonce_hash=? AND status='running' AND expires_at>?
          AND NOT EXISTS(SELECT 1 FROM executor_controls WHERE user_id=? AND paused=1) RETURNING id`).bind(new Date().toISOString(), id, userId, nonceHash, new Date().toISOString(), userId).first();
        return Boolean(claimed);
      }, env.FIXTURE_ORIGIN);
      return Response.json(result);
    } catch {
      return Response.json({ status: "uncertain", reason: "Browser service interrupted. Check the attempt; do not retry automatically." }, { status: 503 });
    } finally {
      clearTimeout(deadline);
      await deadlineClose;
      await browser?.close().catch(() => {});
      if (leaseId) await env.DB.prepare("DELETE FROM executor_browser_leases WHERE id=?").bind(leaseId).run().catch(() => {});
    }
  },
} satisfies ExportedHandler<ExecutorBindings>;
