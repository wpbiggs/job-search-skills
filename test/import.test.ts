import test from "node:test";
import assert from "node:assert/strict";
import { LocalDatabase } from "../src/sqlite.ts";
import { WorkspaceStore, prepareImport } from "../src/store.ts";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

async function fixture() {
  const db = new LocalDatabase(":memory:");
  const owners = [crypto.randomUUID(), crypto.randomUUID()];
  for (const id of owners) await db.prepare("INSERT INTO users(id,name,epoch,recovery_hash) VALUES(?,?,?,?)").bind(id, "Fictional import fixture", crypto.randomUUID(), crypto.randomUUID()).run();
  const source = new WorkspaceStore(db, owners[0], "website"), destination = new WorkspaceStore(db, owners[1], "website");
  const profile = await source.save({ kind: "profile", expected_revision: 0, data: { goals: "Operations", preferences: "Remote", constraints: "Clarify salary", evidence: [{ id: "writing", claim: "Wrote documentation", source: "Fictional project", confirmed: true }] } });
  const job = await source.save({ kind: "job", expected_revision: 0, data: { company: "Fictional Cooperative", title: "Analyst", source_url: "https://example.com/jobs/import-fixture", location: "Unknown", compensation: "Unknown", posting: "Required: writing", checked_at: new Date().toISOString(), requisition_id: "fixture", stage: "drafting" } });
  const draft = await source.save({ kind: "draft", job_id: job.id, expected_revision: 0, data: { type: "resume", content: "Wrote documentation", evidence_ids: ["writing"], unresolved_claims: "Review" } });
  await source.review(job.id, { action: "approved", draft_id: draft.id, draft_revision: 1, destination: job.data.source_url, confirmation: "Fixture checked only" });
  await source.outcome(job.id, { status: "interviewing", note: "Fictional assertion only", next_action_at: null });
  await source.save({ kind: "profile", id: profile.id, expected_revision: 1, data: { ...profile.data, goals: "Updated goals" } });
  return { db, source, destination, snapshot: await source.export(), profile, job, draft };
}

test("import preview is read-only; preparation gets fresh IDs, links and unconfirmed evidence, never prior authority", async () => {
  const f = await fixture();
  try {
    const preview = await f.destination.previewImport(f.snapshot);
    assert.equal((await f.destination.list()).length, 0);
    assert.equal(preview.record_count, 3);
    assert.equal(preview.not_restored.reviews, 1);
    assert.equal(preview.not_restored.outcomes, 1);
    assert.equal(preview.not_restored.versions, 1);
    await f.destination.importPreparation(f.snapshot, preview.digest);
    const records = await f.destination.list();
    assert.equal(records.length, 3);
    assert.equal(records.some(record => [f.profile.id, f.job.id, f.draft.id].includes(record.id)), false);
    const profile = records.find(record => record.kind === "profile")!;
    const job = records.find(record => record.kind === "job")!;
    const draft = records.find(record => record.kind === "draft")!;
    assert.equal((profile.data.evidence as { confirmed: boolean }[])[0].confirmed, false);
    assert.equal(draft.job_id, job.id);
    assert.equal(draft.revision, 1);
    assert.equal((await f.destination.reviews()).length, 0);
    assert.equal((await f.destination.outcomes()).length, 0);
    assert.equal((await f.destination.usage()).historical_versions, 0);
    await assert.rejects(f.destination.review(job.id, { action: "approved", draft_id: draft.id, draft_revision: 1, destination: job.data.source_url, confirmation: "Cannot reuse approval" }), /profile changed/);
    assert.equal((await f.source.list()).length, 3);
  } finally { f.db.close(); }
});

test("imports cannot be invoked by an assistant, merge into existing data, or use a different preview digest", async () => {
  const f = await fixture();
  try {
    const assistant = new WorkspaceStore(f.db, f.destination.userId, "assistant");
    const preview = await f.destination.previewImport(f.snapshot);
    await assert.rejects(assistant.previewImport(f.snapshot), /candidate/);
    await assert.rejects(assistant.importPreparation(f.snapshot, preview.digest), /candidate/);
    await assert.rejects(f.destination.importPreparation(f.snapshot, "0".repeat(64)), /file changed/);
    await f.destination.importPreparation(f.snapshot, preview.digest);
    await assert.rejects(f.destination.previewImport(f.snapshot), /empty workspace/);
    await assert.rejects(f.destination.importPreparation(f.snapshot, preview.digest), /empty workspace/);
    assert.equal((await f.destination.list()).length, 3);
  } finally { f.db.close(); }
});

test("unsupported formats, duplicate IDs, unsafe URLs, missing links/evidence and extra credential fields are rejected without writes", async () => {
  const f = await fixture();
  try {
    const original = f.snapshot as { records: { id: string; kind: string; job_id: string | null; data: Record<string, unknown> }[] };
    const variants: unknown[] = [
      { ...f.snapshot, version: 99 }, { ...f.snapshot, credentials: [{ secret: "never restore" }] },
      { ...f.snapshot, records: [...original.records, original.records[0]] },
      ...["job", "profile"].map(kind => ({ ...f.snapshot, records: original.records.filter(record => record.kind !== kind) })),
      { ...f.snapshot, records: original.records.map(record => record.kind === "job" ? { ...record, data: { ...record.data, source_url: "https://127.0.0.1/collect" } } : record) },
    ];
    for (const input of variants) await assert.rejects(f.destination.previewImport(input));
    assert.equal((await f.destination.list()).length, 0);
  } finally { f.db.close(); }
});

test("an atomic insert rolls back the entire snapshot on database failure and concurrent import cannot duplicate it", async () => {
  const f = await fixture();
  try {
    const preview = await f.destination.previewImport(f.snapshot);
    f.db.connection.exec("CREATE TRIGGER fixture_abort_import BEFORE INSERT ON records WHEN NEW.kind='draft' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
    await assert.rejects(f.destination.importPreparation(f.snapshot, preview.digest), /fixture failure/);
    assert.equal((await f.destination.list()).length, 0);
    f.db.connection.exec("DROP TRIGGER fixture_abort_import;");
    const results = await Promise.allSettled([f.destination.importPreparation(f.snapshot, preview.digest), f.destination.importPreparation(f.snapshot, preview.digest)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal((await f.destination.list()).length, 3);
  } finally { f.db.close(); }
});

test("import size limits are checked before writes", async () => {
  const f = await fixture();
  try {
    const record = (f.snapshot.records as { kind: string; data: Record<string, unknown> }[]).find(record => record.kind === "job")!;
    const snapshot = { ...f.snapshot, records: [{ ...record, id: crypto.randomUUID(), job_id: null, revision: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), data: { ...record.data, posting: "😀".repeat(20000) } }] };
    await assert.rejects(prepareImport(snapshot), /64 KiB/);
    assert.equal((await f.destination.list()).length, 0);
  } finally { f.db.close(); }
});

test("near-quota snapshots use bounded JSON bindings and still insert all chunks atomically", async () => {
  const f = await fixture();
  try {
    const job = (f.snapshot.records as { kind: string; data: Record<string, unknown> }[]).find(record => record.kind === "job")!;
    const records = Array.from({ length: 46 }, (_, index) => ({ ...job, id: crypto.randomUUID(), data: { ...job.data, source_url: `https://example.com/jobs/bulk-${index}`, posting: "x".repeat(45000) } }));
    const snapshot = { ...f.snapshot, records };
    const preview = await f.destination.previewImport(snapshot);
    assert.ok(preview.bytes > 2_000_000 && preview.bytes < 2_097_152);
    const prepare = f.db.prepare.bind(f.db);
    f.db.prepare = query => {
      const statement = prepare(query), bind = statement.bind.bind(statement);
      statement.bind = (...values) => {
        if (query.startsWith("WITH chunks")) {
          assert.ok(values.length > 3, "Large imports should be chunked into multiple bindings");
          for (const value of values) if (typeof value === "string") assert.ok(Buffer.byteLength(value) <= 256 * 1024);
        }
        return bind(...values);
      };
      return statement;
    };
    await f.destination.importPreparation(snapshot, preview.digest);
    assert.equal((await f.destination.list()).length, 46);
    assert.equal((await f.destination.usage()).current_bytes, preview.bytes);
  } finally { f.db.close(); }
});

test("candidate local CLI previews without preparation writes, then imports the same export into portable SQLite", async () => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), "job-search-import-fixture-"));
  try {
    const file = join(directory, "fictional-export.json"), workspace = join(directory, "local");
    await writeFile(file, JSON.stringify(f.snapshot), { mode: 0o600 });
    const args = ["--import", "tsx", "src/import-local.ts", "--workspace", workspace, "--file", file];
    const preview = JSON.parse((await promisify(execFile)(process.execPath, args)).stdout).preview;
    const before = new LocalDatabase(join(workspace, "workspace.sqlite"));
    assert.equal((await before.prepare("SELECT count(*) AS n FROM records").first<{ n: number }>())!.n, 0);
    before.close();
    await assert.rejects(promisify(execFile)(process.execPath, [...args, "--confirm-digest", "0".repeat(64)]));
    const confirmed = JSON.parse((await promisify(execFile)(process.execPath, [...args, "--confirm-digest", preview.digest])).stdout);
    assert.equal(confirmed.imported, 3);
    const after = new LocalDatabase(join(workspace, "workspace.sqlite"));
    const user = await after.prepare("SELECT id FROM users LIMIT 1").first<{ id: string }>();
    const exported = await new WorkspaceStore(after, user!.id, "assistant").export();
    assert.equal((exported.records as unknown[]).length, 3);
    assert.deepEqual(exported.reviews, []);
    after.close();
    await writeFile(file, '{"secret":"PRIVATE_FIXTURE_MARKER",broken');
    await assert.rejects(promisify(execFile)(process.execPath, args), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Invalid JSON export/);
      assert.doesNotMatch(error.message, /PRIVATE_FIXTURE_MARKER/);
      return true;
    });
  } finally { f.db.close(); await rm(directory, { recursive: true, force: true }); }
});
