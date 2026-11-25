import assert from "node:assert/strict";
import { build } from "esbuild";
import { unstable_dev } from "wrangler";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Test-only subclass replaces only the cloud browser transport, not controller/storage/owner/quota logic.
const source = `import {CandidateTakeover} from './services/application-executor/takeover.ts';
export class TestTakeover extends CandidateTakeover {
  createDriver(){return {
    start: async record=>{const s={session_id:crypto.randomUUID(),target_id:'fictional-target'};record(s);return s;},
    view: async()=> 'https://live.browser.run/ui/inspector?wss=TEST_ONLY_BEARER',
    close: async()=> {if(this.ctx.storage.sql.exec('SELECT state FROM takeover_state').toArray()[0]?.state.includes('force-close-failure'))throw Error('mock close failure');}
  };}
  async inspect(){return {rows:this.ctx.storage.sql.exec('SELECT state FROM takeover_state').toArray(),alarm:await this.ctx.storage.getAlarm()};}
  async expire(){const row=this.ctx.storage.sql.exec('SELECT state FROM takeover_state').toArray()[0];const s=JSON.parse(row.state);s.expires_at=Date.now()-1;this.ctx.storage.sql.exec('UPDATE takeover_state SET state=?',JSON.stringify(s));await this.alarm();}
}
export default {async fetch(request,env){try{const {owner,action,id,name,sql,values}=await request.json();if(action==='sql')return Response.json(await env.DB.prepare(sql).bind(...values).all());const stub=env.TAKEOVERS.getByName(name??owner.user_id);if(action==='inspect')return Response.json(await stub.inspect());if(action==='expire'){await stub.expire();return Response.json({ok:true});}return Response.json(await stub.command(owner,action,id));}catch{return Response.json({error:'rejected'},{status:409});}}};`;
const bundled = await build({ stdin: { contents: source, loader: "js", resolveDir: process.cwd() }, bundle: true, write: false, platform: "node", format: "esm", target: "es2022", external: ["cloudflare:*"] });
const dir = await mkdtemp(join(tmpdir(), "takeover-runtime-"));
const scriptPath = join(dir, "worker.mjs"), configPath = join(dir, "wrangler.json");
await writeFile(scriptPath, bundled.outputFiles[0].text);
await writeFile(configPath, JSON.stringify({ name: "takeover-runtime-test", main: scriptPath, compatibility_date: "2026-11-10", compatibility_flags: ["nodejs_compat"], durable_objects: { bindings: [{ name: "TAKEOVERS", class_name: "TestTakeover" }] }, migrations: [{ tag: "v1", new_sqlite_classes: ["TestTakeover"] }], d1_databases: [{ binding: "DB", database_name: "fixture", database_id: "11111111-1111-1111-1111-111111111111", migrations_dir: join(process.cwd(), "migrations") }], vars: { EXECUTOR_DISABLED: "false" } }));
execFileSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "d1", "migrations", "apply", "DB", "--local", "--config", configPath, "--persist-to", join(dir, "persist")], { stdio: "pipe" });
const options = { config: configPath, persistTo: join(dir, "persist"), port: 0, local: true, logLevel: "error", experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false, showInteractiveDevSession: false } };
let mf = await unstable_dev(scriptPath, options);
const owner = { user_id: crypto.randomUUID(), epoch: "a".repeat(64) }, other = { user_id: crypto.randomUUID(), epoch: "b".repeat(64) };
const command = async (action, target = owner, extra = {}) => { const response = await mf.fetch("/", { method: "POST", body: JSON.stringify({ owner: target, action, ...extra }) }); return { status: response.status, body: await response.json() }; };
const db = { prepare: sql => { let values=[]; const statement = { bind: (...items) => { values=items; return statement; }, run: async () => { const result=await command('sql', owner, {sql,values}); assert.equal(result.status,200); return result.body; }, first: async () => (await statement.run()).results[0] }; return statement; } };
try {
  for (const user of [owner, other]) await db.prepare("INSERT INTO users(id,name,epoch,recovery_hash) VALUES(?,?,?,?)").bind(user.user_id, "Fictional runtime", user.epoch, crypto.randomUUID()).run();
  const first = await command("start_fixture"); assert.equal(first.status, 200); assert.equal(first.body.takeover.phase, "paused");
  const id = first.body.takeover.id;
  assert.equal((await command("start_fixture")).status, 409);
  assert.equal((await command("view", other, { id, name: owner.user_id })).status, 409);
  const view = await command("view", owner, { id }); assert.equal(view.status, 200); assert.ok(view.body.live_view_url);
  const inspected = (await command("inspect")).body;
  assert.equal(inspected.rows.length, 1); assert.ok(inspected.alarm); assert.equal(JSON.stringify(inspected).includes("BEARER"), false);
  const otherStart = await command("start_fixture", other); assert.equal(otherStart.status, 200);
  await mf.stop(); mf = await unstable_dev(scriptPath, options);
  assert.equal((await command("status")).body.takeover.id, id, "SQLite state survives a complete workerd restart");
  const closed = await command("complete", owner, { id }); assert.equal(closed.body.takeover.phase, "closed"); assert.equal(closed.body.takeover.execution_enabled, false);
  assert.deepEqual((await command("inspect")).body, { rows: [], alarm: null });
  assert.equal((await command("status", other)).body.takeover.id, otherStart.body.takeover.id);
  await command("expire", other); assert.deepEqual((await command("inspect", other)).body, { rows: [], alarm: null });
  assert.equal((await db.prepare("SELECT count(*) AS n FROM executor_browser_leases").first()).n, 0);
  const paused = await command("start_fixture"); assert.equal(paused.status, 200);
  await db.prepare("UPDATE users SET epoch=? WHERE id=?").bind("c".repeat(64), owner.user_id).run();
  const revoked = await command("status"); assert.equal(revoked.body.takeover.phase, "closed"); assert.equal(revoked.body.takeover.reason, "revoked");
  console.log("Passed: actual workerd RPC/SQLite persistence across restart, per-owner isolation, alarm expiry, epoch revocation, closure erasure, no stored bearer URL and lease cleanup. Browser transport is mocked; no cloud sessions or employers contacted.");
} finally { await mf.stop(); await rm(dir, { recursive: true, force: true }); }
