import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createServer, WORKFLOWS, type WorkflowText } from "./mcp.ts";
import { openLocalWorkspace } from "./local-workspace.ts";
import { WorkspaceStore } from "./store.ts";

const { values } = parseArgs({ options: { workspace: { type: "string" }, "read-only": { type: "boolean", default: false } } });
if (!values.workspace) throw new Error("Usage: npm run mcp:local -- --workspace /private/directory [--read-only]");
const { database, userId } = await openLocalWorkspace(values.workspace);
const workflows = Object.fromEntries(WORKFLOWS.map(name => [name, readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), `../skills/${name}/SKILL.md`), "utf8")])) as WorkflowText;
const server = createServer(new WorkspaceStore(database, userId, "assistant"), values["read-only"] ? ["workspace:read"] : ["workspace:read", "workspace:write"], workflows);
// Standard output belongs exclusively to MCP JSON-RPC, never diagnostics or private data.
await server.connect(new StdioServerTransport());
process.on("SIGINT", () => { database.close(); process.exit(0); });
process.on("SIGTERM", () => { database.close(); process.exit(0); });
