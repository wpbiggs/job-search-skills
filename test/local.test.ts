import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("local stdio MCP initializes, persists across processes, and supports read-only connections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "job-search-mcp-fixture-"));
  const connect = async (readonly = false) => {
    const client = new Client({ name: "local-protocol-fixture", version: "1.0.0" });
    const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/local.ts", "--workspace", directory, ...(readonly ? ["--read-only"] : [])], cwd: process.cwd(), stderr: "pipe" });
    await client.connect(transport);
    return client;
  };
  try {
    const first = await connect();
    try {
      const tools = await first.listTools();
      assert.ok(tools.tools.some(tool => tool.name === "capture_job"));
      const result = await first.callTool({ name: "record_run", arguments: { expected_revision: 0, data: { run_key: "2026-11-05-0900-fixture", status: "completed", summary: "Fixture protocol run only; no research performed", source_urls: [], started_at: new Date().toISOString(), finished_at: new Date().toISOString() } } });
      assert.equal(result.isError, undefined);
    } finally { await first.close(); }
    const second = await connect(true);
    try {
      const tools = (await second.listTools()).tools.map(tool => tool.name);
      assert.ok(!tools.includes("capture_job"));
      const result = await second.callTool({ name: "list_records", arguments: { kind: "run" } });
      assert.equal(JSON.parse((result.content as { text: string }[])[0].text).records.length, 1);
    } finally { await second.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
