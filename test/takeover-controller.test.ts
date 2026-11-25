import test from "node:test";
import assert from "node:assert/strict";
import { TakeoverController, TAKEOVER_LINK_TTL, validLiveView, type TakeoverState, type TakeoverDependencies } from "../src/takeover-controller.ts";

function fixture() {
  let state: TakeoverState | null = null, alarm: number | null = null, now = 1000000, allowed = true, reserved = true, closes = 0, releases = 0, starts = 0;
  const owner = { user_id: crypto.randomUUID(), epoch: "a".repeat(64) };
  const deps: TakeoverDependencies = {
    storage: { read: () => state ? structuredClone(state) : null, write: next => { state = next ? structuredClone(next) : null; }, alarm: async at => { alarm = at; } },
    now: () => now, allowed: async () => allowed, reserve: async () => reserved, release: async () => { releases++; },
    driver: {
      start: async acquired => { starts++; const session = { session_id: "PRIVATE_SESSION", target_id: "PRIVATE_TARGET" }; acquired(session); return session; },
      view: async () => "https://live.browser.run/ui/inspector?wss=PRIVATE_BEARER",
      close: async () => { closes++; },
    },
  };
  const controller = new TakeoverController(deps);
  return { owner, deps, controller, state: () => state, alarm: () => alarm, starts: () => starts, closes: () => closes, releases: () => releases, advance: (ms: number) => { now += ms; }, deny: () => { allowed = false; }, exhaust: () => { reserved = false; } };
}
test("only exact HTTPS Live View UI origins can become candidate control links", () => {
  assert.equal(validLiveView("https://live.browser.run/ui/inspector?wss=token"), true);
  for (const value of ["http://live.browser.run/ui/inspector", "https://live.browser.run.evil/ui/inspector", "https://user@live.browser.run/ui/inspector", "https://live.browser.run/ui/inspector#token", "https://live.browser.run/other", "javascript:alert(1)"]) assert.equal(validLiveView(value), false);
});
test("owner-bound practice pauses, returns bearer only on view, and completion closes rather than resumes", async () => {
  const f = fixture(), started = await f.controller.start(f.owner);
  assert.equal(started.phase, "paused"); assert.equal(started.execution_enabled, false);
  assert.equal(JSON.stringify(started).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(f.state()).includes("PRIVATE_BEARER"), false);
  const view = await f.controller.view(f.owner, started.id);
  assert.ok(view.live_view_url); assert.equal(JSON.stringify(f.state()).includes("PRIVATE_BEARER"), false);
  const closed = await f.controller.end(f.owner, started.id, "completed");
  assert.equal(closed?.phase, "closed"); assert.equal(closed?.reason, "completed"); assert.equal(closed?.execution_enabled, false);
  assert.equal(f.closes(), 1); assert.equal(f.releases(), 1); assert.equal(f.state(), null); assert.equal(f.alarm(), null);
  await assert.rejects(f.controller.view(f.owner, started.id), /No current/);
});
test("foreign owner, old epoch and changed generation cannot view or cancel a takeover", async () => {
  const f = fixture(), started = await f.controller.start(f.owner);
  for (const owner of [{ ...f.owner, user_id: crypto.randomUUID() }, { ...f.owner, epoch: "b".repeat(64) }]) {
    await assert.rejects(f.controller.view(owner, started.id), /matching/);
    await assert.rejects(f.controller.end(owner, started.id, "cancelled"), /matching/);
  }
  await assert.rejects(f.controller.end(f.owner, crypto.randomUUID(), "cancelled"), /matching/);
  assert.equal(f.closes(), 0);
});
test("simultaneous starts have one durable claim and one browser acquisition", async () => {
  const f = fixture(); const results = await Promise.allSettled([f.controller.start(f.owner), f.controller.start(f.owner)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1); assert.equal(f.starts(), 1);
});
for (const cause of ["expiry", "revocation"] as const) test(`${cause} closes the browser without candidate polling; restored controller uses persisted identity`, async () => {
  const f = fixture(); await f.controller.start(f.owner);
  if (cause === "expiry") f.advance(120001); else f.deny();
  const restored = new TakeoverController(f.deps); await restored.alarm();
  assert.equal(f.closes(), 1); assert.equal(f.state(), null); assert.equal(f.alarm(), null);
});
test("close failures retain identity and alarm retry; no false closed/released result or new link", async () => {
  const f = fixture(), started = await f.controller.start(f.owner), close = f.deps.driver.close;
  f.deps.driver.close = async () => { throw Error("Disconnected control transport"); };
  const result = await f.controller.end(f.owner, started.id, "cancelled");
  assert.equal(result?.phase, "closing"); assert.equal(f.releases(), 0); assert.ok(f.state()?.session); assert.ok(f.alarm());
  await assert.rejects(f.controller.view(f.owner, started.id), /No current/);
  await assert.rejects(f.controller.start(f.owner), /already active/);
  f.deps.driver.close = close; await new TakeoverController(f.deps).alarm();
  assert.equal(f.state(), null); assert.equal(f.releases(), 1);
});
test("budget exhaustion and revoked ownership never acquire a browser", async () => {
  for (const reason of ["budget", "owner"]) {
    const f = fixture(); if (reason === "budget") f.exhaust(); else f.deny();
    await assert.rejects(f.controller.start(f.owner)); assert.equal(f.starts(), 0); assert.equal(f.state(), null); assert.equal(f.alarm(), null);
  }
});
test("cancellation during startup closes the later-acquired browser and never releases a control link", async () => {
  const f = fixture(); let finish!: () => void, acquired!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const entered = new Promise<void>(resolve => { acquired = resolve; });
  f.deps.driver.start = async record => { acquired(); await gate; const session = { session_id: "LATE_SESSION", target_id: "LATE_TARGET" }; record(session); return session; };
  const starting = f.controller.start(f.owner); await entered;
  const id = f.state()!.id; assert.equal((await f.controller.end(f.owner, id, "cancelled"))?.phase, "closing");
  finish(); const result = await starting;
  assert.equal(result.phase, "closed"); assert.equal(result.reason, "cancelled"); assert.equal(f.closes(), 1); assert.equal(f.state(), null);
});
test("revocation while a bearer is being minted discards the link and closes the session", async () => {
  const f = fixture(), started = await f.controller.start(f.owner);
  f.deps.driver.view = async () => { await f.controller.end(f.owner, started.id, "cancelled"); return "https://live.browser.run/ui/inspector?wss=REVOKED"; };
  await assert.rejects(f.controller.view(f.owner, started.id), /changed/); assert.equal(f.state(), null); assert.equal(f.closes(), 1);
});
test("unsafe provider links are never returned and revoke the practice session", async () => {
  const f = fixture(), started = await f.controller.start(f.owner);
  f.deps.driver.view = async () => "https://untrusted.example/steal";
  await assert.rejects(f.controller.view(f.owner, started.id), /changed/); assert.equal(f.state(), null);
});
test("an abandoned pre-identity start is erased after its startup/idle grace, without reviving an old generation", async () => {
  const f = fixture(); f.deps.storage.write({ ...f.owner, id: crypto.randomUUID(), phase: "starting", expires_at: 1000001, session: null, reason: null });
  f.advance(180000); await f.controller.alarm(); assert.equal(f.state(), null); assert.equal(f.releases(), 1);
});
test("a reservation failure after lease insertion still cleans the generated lease identity", async () => {
  const f = fixture(); f.deps.reserve = async () => { throw Error("Budget DB interrupted after lease insert"); };
  await assert.rejects(f.controller.start(f.owner), /interrupted/);
  assert.equal(f.releases(), 1); assert.equal(f.state(), null); assert.equal(f.alarm(), null);
});
test("owner-check outages retain a future alarm instead of exhausting cleanup after finite platform retries", async () => {
  const f = fixture(); await f.controller.start(f.owner); const first = f.alarm();
  f.advance(5000); f.deps.allowed = async () => { throw Error("Owner DB unavailable"); };
  await assert.rejects(f.controller.alarm(), /unavailable/);
  assert.ok(f.alarm()! > first!); assert.ok(f.state()?.session); assert.equal(f.releases(), 0);
});
test("late duplicate close completion cannot erase a newer generation", async () => {
  const f = fixture(), started = await f.controller.start(f.owner);
  let finish!: () => void, entered!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { finish = resolve; }), entering = new Promise<void>(resolve => { entered = resolve; });
  f.deps.driver.close = async () => { if (++calls === 1) { entered(); await gate; } };
  const firstClose = f.controller.end(f.owner, started.id, "cancelled"); await entering;
  await f.controller.end(f.owner, started.id, "cancelled");
  const next = await f.controller.start(f.owner); finish(); await firstClose;
  assert.equal(f.state()?.id, next.id); assert.equal(f.state()?.phase, "paused"); assert.ok(f.alarm());
});
test("trusted owner revocation closes the old epoch without granting the replacement epoch access to its link", async () => {
  const f = fixture(), started = await f.controller.start(f.owner);
  await assert.rejects(f.controller.view({ ...f.owner, epoch: "c".repeat(64) }, started.id), /matching/);
  await assert.rejects(f.controller.revokeOwner(crypto.randomUUID()), /mismatch/);
  assert.equal((await f.controller.revokeOwner(f.owner.user_id))?.phase, "closed"); assert.equal(f.state(), null);
});
test("Live View honors the documented provider minimum without extending the absolute authorization deadline", async () => {
  const f = fixture(), started = await f.controller.start(f.owner); let calls = 0;
  f.deps.driver.view = async (_session, ttl) => { calls++; assert.equal(ttl, 60000); assert.equal(ttl, TAKEOVER_LINK_TTL); return "https://live.browser.run/ui/view?mode=tab&wss=FICTIONAL"; };
  await f.controller.view(f.owner, started.id); assert.equal(calls, 1);
  f.advance(60001); await assert.rejects(f.controller.view(f.owner, started.id), /Too little authorized time/);
  assert.equal(calls, 1); assert.equal(f.state()?.expires_at, Date.parse(started.expires_at));
});
test("a slow provider mint cannot push the connection window past the original deadline", async () => {
  const f = fixture(), started = await f.controller.start(f.owner); f.advance(59000);
  f.deps.driver.view = async () => { f.advance(2000); return "https://live.browser.run/ui/view?mode=tab&wss=LATE"; };
  await assert.rejects(f.controller.view(f.owner, started.id), /changed/); assert.equal(f.closes(), 1); assert.equal(f.state(), null);
});
