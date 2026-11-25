import { DurableObject } from "cloudflare:workers";
import { connect, launch, sessions, type Browser } from "@cloudflare/playwright";
import { claimInspectionBudget } from "../../src/executor-budget.ts";
import { TakeoverController, type TakeoverDriver, type TakeoverOwner, type TakeoverSession, type TakeoverState } from "../../src/takeover-controller.ts";
import { HttpError } from "../../src/security.ts";

const fixtureHtml = `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"><title>Fictional takeover practice</title><style>body{font:18px system-ui;max-width:620px;margin:40px auto;padding:20px}input{font:inherit;padding:10px}</style><h1>Fictional takeover practice</h1><p>No employer application is open. Use fictional values only. Do not enter credentials, personal information, legal answers or documents.</p><label for="practice">Practice code — enter FIXTURE only</label><p><input id="practice" autocomplete="off"></p><p>Return to your workspace to end this practice session. Ending it closes the browser; it never resumes automation or authorizes a submission.</p><button disabled>No application submission is available</button></html>`;

export class FixtureTakeoverDriver implements TakeoverDriver {
  private browsers = new Map<string, Browser>();
  constructor(readonly binding: BrowserRun) {}
  private async browser(id: string) {
    const cached = this.browsers.get(id);
    if (cached?.isConnected()) return cached;
    const browser = await connect(this.binding, id);
    this.browsers.set(id, browser); return browser;
  }
  async start(acquired: (session: TakeoverSession) => void): Promise<TakeoverSession> {
    const browser = await launch(this.binding, { guardrails: { allowedDomains: [] }, keep_alive: 60000, recording: false });
    const sessionId = browser.sessionId(); this.browsers.set(sessionId, browser);
    try {
      acquired({ session_id: sessionId, target_id: "" });
      const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block", acceptDownloads: false, permissions: [], viewport: { width: 1280, height: 900 } });
      await context.route("**/*", route => route.abort());
      await context.routeWebSocket("**/*", socket => socket.close());
      const page = await context.newPage(); await page.setContent(fixtureHtml);
      const cdp = await context.newCDPSession(page);
      try {
        const { targetInfo } = await cdp.send("Target.getTargetInfo");
        await cdp.send("Cloudflare.handoff", { targetId: targetInfo.targetId, instructions: "Fictional practice only: enter FIXTURE in Practice code. Do not enter personal data. Return to the owned workspace to end the session. This does not approve any employer action.", timeout: 120000 });
        return { session_id: sessionId, target_id: targetInfo.targetId };
      } finally { await cdp.detach(); }
    } catch {
      // No capability has been released; keep idle timeout as a secondary bound if the close fails.
      await browser.close().catch(() => {}); this.browsers.delete(sessionId);
      throw Error("Fictional takeover browser setup failed");
    }
  }
  async view(session: TakeoverSession, expiresInMs: number): Promise<string> {
    let stage = "connect";
    try {
      const browser = await this.browser(session.session_id);
      stage = "locate_target";
      const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url() === "about:blank");
      if (!page) throw Error("Practice target missing");
      const cdp = await page.context().newCDPSession(page);
      try {
        stage = "verify_target";
        const { targetInfo } = await cdp.send("Target.getTargetInfo");
        if (targetInfo.targetId !== session.target_id) throw Error("Practice target changed");
        stage = "verify_handoff";
        const handoff = await cdp.send("Cloudflare.getHandoffState", { targetId: session.target_id });
        if (!handoff.active) throw Error("Practice handoff is no longer active");
        stage = "mint_capability";
        const live = await cdp.send("Cloudflare.getLiveView", { targetId: session.target_id, mode: "tab", expiresInMs });
        return live.devtoolsFrontendUrl;
      } finally { await cdp.detach(); }
    } catch { throw new HttpError(503, `practice_view_${stage}_unavailable`); } // Fixed stage only; SDK errors may contain URLs.
  }
  async close(session: TakeoverSession): Promise<void> {
    try {
      const browser = await this.browser(session.session_id);
      await browser.close(); this.browsers.delete(session.session_id);
    } catch {
      // A reconnect error alone is not proof of revocation. Confirm absence before releasing the lease.
      if ((await sessions(this.binding)).some(item => item.sessionId === session.session_id)) throw Error("Browser close not confirmed");
      this.browsers.delete(session.session_id);
    }
  }
}

/** Private per-owner coordinator; no public fetch handler and no employer destination input. */
export class CandidateTakeover extends DurableObject<ExecutorBindings> {
  private controller: TakeoverController;
  constructor(ctx: DurableObjectState, env: ExecutorBindings) {
    super(ctx, env);
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS takeover_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), state TEXT NOT NULL)");
    this.controller = new TakeoverController({
      storage: {
        read: () => {
          const row = this.ctx.storage.sql.exec<{ state: string }>("SELECT state FROM takeover_state WHERE singleton=1").toArray()[0];
          return row ? JSON.parse(row.state) as TakeoverState : null;
        },
        write: state => { if (state) this.ctx.storage.sql.exec("INSERT INTO takeover_state(singleton,state) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET state=excluded.state", JSON.stringify(state)); else this.ctx.storage.sql.exec("DELETE FROM takeover_state"); },
        alarm: async at => { if (at === null) await this.ctx.storage.deleteAlarm(); else await this.ctx.storage.setAlarm(at); },
      },
      driver: this.createDriver(), now: () => this.clock(),
      allowed: owner => this.allowed(owner), reserve: (id, expiresAt) => this.reserve(id, expiresAt),
      release: async id => { await this.env.DB.prepare("DELETE FROM executor_browser_leases WHERE id=?").bind(id).run(); },
    });
  }
  protected clock(): number { return Date.now(); }
  protected createDriver(): TakeoverDriver { return new FixtureTakeoverDriver(this.env.BROWSER); }
  private async allowed(owner: TakeoverOwner) {
    if (String(this.env.EXECUTOR_DISABLED) === "true") return false;
    const row = await this.env.DB.prepare("SELECT epoch FROM users WHERE id=? AND NOT EXISTS(SELECT 1 FROM executor_controls WHERE user_id=? AND paused=1)").bind(owner.user_id, owner.user_id).first<{ epoch: string }>();
    return row?.epoch === owner.epoch;
  }
  private async reserve(id: string, _expiresAt: number) {
    const now = new Date(this.clock()).toISOString();
    await this.env.DB.prepare("DELETE FROM executor_browser_leases WHERE expires_at<=?").bind(now).run();
    // A takeover lease is not reaped merely because its authorization expired: an established
    // viewer may still be connected until close is confirmed. The durable alarm owns cleanup.
    const lease = await this.env.DB.prepare("INSERT INTO executor_browser_leases(id,expires_at) SELECT ?,? WHERE (SELECT count(*) FROM executor_browser_leases)<2 RETURNING id").bind(id, "9999-12-31T23:59:59.999Z").first();
    if (!lease) return false;
    if (await claimInspectionBudget(this.env.DB)) return true;
    await this.env.DB.prepare("DELETE FROM executor_browser_leases WHERE id=?").bind(id).run(); return false;
  }
  async command(owner: TakeoverOwner, action: "start_fixture" | "status" | "view" | "cancel" | "complete" | "revoke", id?: string) {
    if (this.ctx.id.name !== owner.user_id) throw Error("Takeover owner mismatch");
    if (action === "revoke") return { takeover: await this.controller.revokeOwner(owner.user_id) };
    if (action === "start_fixture") return { takeover: await this.controller.start(owner) };
    if (action === "status") return { takeover: await this.controller.status(owner) };
    if (!id) throw Error("Takeover identity required");
    if (action === "view") return this.controller.view(owner, id);
    return { takeover: await this.controller.end(owner, id, action === "cancel" ? "cancelled" : "completed") };
  }
  async alarm(): Promise<void> { await this.controller.alarm(); }
}
