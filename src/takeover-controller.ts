import { HttpError } from "./security.ts";

export type TakeoverOwner = { user_id: string; epoch: string };
export type TakeoverSession = { session_id: string; target_id: string };
export type TakeoverState = TakeoverOwner & {
  id: string; phase: "starting" | "paused" | "closing"; expires_at: number;
  session: TakeoverSession | null; reason: "cancelled" | "expired" | "completed" | "revoked" | "failed" | null;
};
export type TakeoverSummary = { id: string; phase: TakeoverState["phase"] | "closed"; expires_at: string; reason: TakeoverState["reason"]; scope: "fictional-takeover-only"; execution_enabled: false };
export interface TakeoverStorage {
  read(): TakeoverState | null;
  write(state: TakeoverState | null): void;
  alarm(at: number | null): Promise<void>;
}
export interface TakeoverDriver {
  start(acquired: (session: TakeoverSession) => void): Promise<TakeoverSession>;
  view(session: TakeoverSession, expiresInMs: number): Promise<string>;
  close(session: TakeoverSession): Promise<void>;
}
export interface TakeoverDependencies {
  storage: TakeoverStorage; driver: TakeoverDriver; now(): number;
  allowed(owner: TakeoverOwner): Promise<boolean>;
  reserve(id: string, expiresAt: number): Promise<boolean>;
  release(id: string): Promise<void>;
}
const duration = 120000;
export function validLiveView(value: string): boolean {
  try {
    const url = new URL(value);
    return value.length <= 20000 && url.protocol === "https:" && url.hostname === "live.browser.run" && !url.port && !url.username && !url.password && !url.hash && url.pathname.startsWith("/ui/");
  } catch { return false; }
}
function summary(state: TakeoverState, phase: TakeoverSummary["phase"] = state.phase): TakeoverSummary {
  return { id: state.id, phase, expires_at: new Date(state.expires_at).toISOString(), reason: state.reason, scope: "fictional-takeover-only", execution_enabled: false };
}

/** One controller per owner. No personal payload, resume action, or employer destination is accepted. */
export class TakeoverController {
  constructor(readonly deps: TakeoverDependencies) {}
  private owned(owner: TakeoverOwner, id?: string): TakeoverState | null {
    const state = this.deps.storage.read();
    if (state && (state.user_id !== owner.user_id || state.epoch !== owner.epoch || (id && state.id !== id))) throw new HttpError(409, "No matching active takeover.");
    return state;
  }
  private async schedule(state: TakeoverState) { await this.deps.storage.alarm(Math.min(state.expires_at, this.deps.now() + 10000)); }
  private async close(state: TakeoverState): Promise<TakeoverSummary> {
    // Revoke link issuance durably before attempting any external close. Failed closes retain identity for alarm retry.
    const current = this.deps.storage.read();
    if (!current || current.id !== state.id) return summary(state, "closed");
    state = { ...current, phase: "closing", reason: current.reason ?? state.reason ?? "failed" };
    this.deps.storage.write(state);
    await this.deps.storage.alarm(this.deps.now() + 10000);
    if (!state.session) return summary(state); // A concurrent start must persist/close its acquired session first.
    try {
      await this.deps.driver.close(state.session);
      await this.deps.release(state.id);
      if (this.deps.storage.read()?.id === state.id) {
        this.deps.storage.write(null);
        await this.deps.storage.alarm(null);
      }
      return summary(state, "closed");
    } catch { return summary(state); }
  }
  async start(owner: TakeoverOwner): Promise<TakeoverSummary> {
    if (this.deps.storage.read()) throw new HttpError(409, "A takeover is already active or still closing. Do not retry a pending start.");
    let state: TakeoverState = { ...owner, id: crypto.randomUUID(), phase: "starting", expires_at: this.deps.now() + duration, session: null, reason: null };
    this.deps.storage.write(state); // Claim before any external I/O; prevents simultaneous starts.
    await this.schedule(state);
    let reserved = false;
    try {
      if (!await this.deps.allowed(owner)) throw new HttpError(409, "Takeover unavailable or paused.");
      reserved = await this.deps.reserve(state.id, state.expires_at);
      if (!reserved) throw new HttpError(429, "Browser budget or concurrent-session limit reached; no automatic retry.");
      if (this.deps.storage.read()?.phase !== "starting") throw new HttpError(409, "Takeover start revoked.");
      const session = await this.deps.driver.start(acquired => {
        const current = this.deps.storage.read();
        if (!current || current.id !== state.id) throw Error("Takeover start superseded");
        this.deps.storage.write({ ...current, session: acquired });
      });
      const current = this.deps.storage.read();
      if (!current || current.id !== state.id) { await this.deps.driver.close(session); throw new HttpError(409, "Takeover start superseded."); }
      state = { ...state, ...current, session };
      this.deps.storage.write(state); // Persist acquired identity before issuing any control capability.
      if (state.phase !== "starting" || this.deps.now() >= state.expires_at || !await this.deps.allowed(owner)) {
        return this.close({ ...state, reason: state.reason ?? "revoked" });
      }
      // Recheck after allowed() external I/O: cancel/expiry may have won while it was pending.
      const checked = this.deps.storage.read();
      if (!checked || checked.phase !== "starting" || this.deps.now() >= checked.expires_at) return this.close({ ...state, reason: "revoked" });
      state = { ...checked, phase: "paused" };
      this.deps.storage.write(state); await this.schedule(state);
      return summary(state);
    } catch (error) {
      const current = this.deps.storage.read();
      if (current?.id === state.id && current.session) await this.close({ ...current, reason: "failed" });
      else if (current?.id === state.id) {
        // reserve() can fail after inserting a lease, before reporting success.
        // Delete this generated identity idempotently; if cleanup fails, retain state/alarm.
        await this.deps.release(state.id);
        this.deps.storage.write(null); await this.deps.storage.alarm(null);
      }
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, "Takeover start interrupted. Check status; do not retry automatically.");
    }
  }
  async status(owner: TakeoverOwner): Promise<TakeoverSummary | null> {
    const state = this.owned(owner);
    if (!state) return null;
    if (state.phase === "closing") return this.close(state);
    if (this.deps.now() >= state.expires_at || !await this.deps.allowed(owner)) return this.close({ ...state, reason: this.deps.now() >= state.expires_at ? "expired" : "revoked" });
    const current = this.owned(owner);
    return current ? summary(current) : null;
  }
  async view(owner: TakeoverOwner, id: string): Promise<{ takeover: TakeoverSummary; live_view_url: string }> {
    this.owned(owner, id);
    const report = await this.status(owner), state = this.owned(owner, id);
    if (!report || !state?.session || state.phase !== "paused") throw new HttpError(409, "No current paused takeover.");
    const url = await this.deps.driver.view(state.session, Math.min(30000, state.expires_at - this.deps.now()));
    const current = this.owned(owner, id);
    if (!validLiveView(url) || !current || current.phase !== "paused" || this.deps.now() >= current.expires_at || !await this.deps.allowed(owner)) {
      if (current) await this.close({ ...current, reason: "revoked" });
      throw new HttpError(409, "Takeover changed. No control link released.");
    }
    const final = this.owned(owner, id);
    if (!final || final.phase !== "paused" || this.deps.now() >= final.expires_at) throw new HttpError(409, "Takeover changed. No control link released.");
    // Never persist or include this bearer URL in status, audit events, exports or MCP.
    return { takeover: summary(final), live_view_url: url };
  }
  async end(owner: TakeoverOwner, id: string, reason: "cancelled" | "completed"): Promise<TakeoverSummary | null> {
    const state = this.owned(owner, id);
    return state ? this.close({ ...state, reason }) : null;
  }
  async revokeOwner(userId: string): Promise<TakeoverSummary | null> {
    const state = this.deps.storage.read();
    if (!state) return null;
    if (state.user_id !== userId) throw new HttpError(409, "Takeover owner mismatch.");
    return this.close({ ...state, reason: "revoked" });
  }
  async alarm(): Promise<void> {
    const state = this.deps.storage.read();
    if (!state) return;
    // Preserve another cleanup attempt even if owner/DB checks fail beyond the platform's
    // finite automatic alarm retries. Closure never depends on candidate polling.
    await this.deps.storage.alarm(this.deps.now() + 10000);
    // A crash before session identity persistence never released a Live View link.
    // After the startup deadline plus idle-session grace, clear only that abandoned generation.
    if (!state.session && this.deps.now() >= state.expires_at + 60000) {
      await this.deps.release(state.id);
      if (this.deps.storage.read()?.id === state.id) { this.deps.storage.write(null); await this.deps.storage.alarm(null); }
      return;
    }
    if (state.phase === "closing" || this.deps.now() >= state.expires_at || !await this.deps.allowed(state)) {
      await this.close({ ...state, reason: state.reason ?? (this.deps.now() >= state.expires_at ? "expired" : "revoked") });
    } else await this.schedule(state);
  }
}
