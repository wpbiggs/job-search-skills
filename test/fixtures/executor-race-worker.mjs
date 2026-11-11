import { parentPort, workerData } from "node:worker_threads";
import { register } from "tsx/esm/api";
register();
const { LocalDatabase } = await import("../../src/sqlite.ts");
const { WorkspaceStore } = await import("../../src/store.ts");
const { ExecutorStore } = await import("../../src/executor-store.ts");
const db = new LocalDatabase(workerData.filename);
const service = { async fetch() { return Response.json({ status: "needs_user", reason: "Synthetic concurrency test only" }); } };
const store = new ExecutorStore(new WorkspaceStore(db, workerData.userId, "website"), service, ["example.com"], "https://example.com");
parentPort.postMessage("ready");
Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
try { await store.run(workerData.id); parentPort.postMessage({ success: true }); }
catch { parentPort.postMessage({ success: false }); }
finally { db.close(); }
