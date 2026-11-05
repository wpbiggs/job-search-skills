import { openSync, fstatSync, readSync, closeSync } from "node:fs";
import { parseArgs } from "node:util";
import { openLocalWorkspace } from "./local-workspace.ts";
import { WorkspaceStore } from "./store.ts";

// Candidate-run CLI, intentionally NOT an MCP tool. Never execute without the candidate's file/destination approval.
const { values } = parseArgs({ options: { workspace: { type: "string" }, file: { type: "string" }, "confirm-digest": { type: "string" } } });
if (!values.workspace || !values.file) throw new Error("Usage: node --import tsx src/import-local.ts --workspace /private/directory --file /private/export.json [--confirm-digest PREVIEW_DIGEST]");
const fd = openSync(values.file, "r");
let snapshot: unknown;
try {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("Choose a regular JSON export file at most 4 MiB.");
  const buffer = Buffer.alloc(4 * 1024 * 1024 + 1); let length = 0;
  while (length < buffer.length) {
    const count = readSync(fd, buffer, length, buffer.length - length, null);
    if (!count) break;
    length += count;
  }
  if (length === buffer.length) throw new Error("Export grew beyond the 4 MiB limit. No preparation imported.");
  try { snapshot = JSON.parse(buffer.subarray(0, length).toString("utf8")); }
  catch { throw new Error("Invalid JSON export. No preparation imported."); }
} finally { closeSync(fd); }
const { database, userId } = await openLocalWorkspace(values.workspace);
try {
  // The caller controls the local filesystem. Hosted tokens and MCP tools cannot invoke this authority.
  const store = new WorkspaceStore(database, userId, "website");
  const preview = await store.previewImport(snapshot);
  if (values["confirm-digest"]) {
    await store.importPreparation(snapshot, values["confirm-digest"]);
    console.log(JSON.stringify({ imported: preview.record_count, message: "Preparation only imported. Evidence unconfirmed; no prior history, authority, credentials or outcomes restored." }));
  } else {
    console.log(JSON.stringify({ preview, instructions: "Review this summary. To import into this empty local workspace, rerun with --confirm-digest and this exact preview digest. No preparation has been stored." }, null, 2));
  }
} finally { database.close(); }
