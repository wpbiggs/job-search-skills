import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { mkdirSync, chmodSync, readFileSync, realpathSync, existsSync, writeFileSync, lstatSync } from "node:fs";
import { resolve, relative, dirname, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createServer, WORKFLOWS, type WorkflowText } from "./mcp.ts";
import { LocalDatabase } from "./sqlite.ts";
import { token, hash } from "./security.ts";
import { WorkspaceStore } from "./store.ts";

const { values } = parseArgs({ options: { workspace: { type: "string" }, "read-only": { type: "boolean", default: false } } });
if (!values.workspace) throw new Error("Usage: npm run mcp:local -- --workspace /private/directory [--read-only]");
const repository = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(values.workspace);
const pathFromRepo = relative(repository, directory);
const isOutside = (path: string) => path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
if (!isOutside(pathFromRepo)) throw new Error("Keep private data outside the public repository.");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const canonical = realpathSync(directory), canonicalRepo = realpathSync(repository), relativeCanonical = relative(canonicalRepo, canonical);
if (!isOutside(relativeCanonical)) throw new Error("A symlink points the workspace into the public repository.");
chmodSync(directory, 0o700);
if (!existsSync(resolve(directory, ".gitignore"))) writeFileSync(resolve(directory, ".gitignore"), "*\n!.gitignore\n", { flag: "wx", mode: 0o600 });
const filename = resolve(directory, "workspace.sqlite");
if (existsSync(filename) && lstatSync(filename).isSymbolicLink()) throw new Error("Refusing a symlinked database.");
const database = new LocalDatabase(filename);
chmodSync(filename, 0o600);
let user = await database.prepare("SELECT id FROM users LIMIT 1").first<{ id: string }>();
if (!user) {
  user = { id: crypto.randomUUID() };
  await database.prepare("INSERT INTO users(id,name,epoch,recovery_hash) VALUES(?,?,?,?)").bind(user.id, "Local job search", token(), await hash(token())).run();
}
const workflows = Object.fromEntries(WORKFLOWS.map(name => [name, readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), `../skills/${name}/SKILL.md`), "utf8")])) as WorkflowText;
const server = createServer(new WorkspaceStore(database, user.id, "assistant"), values["read-only"] ? ["workspace:read"] : ["workspace:read", "workspace:write"], workflows);
// Standard output belongs exclusively to MCP JSON-RPC, never diagnostics or private data.
await server.connect(new StdioServerTransport());
process.on("SIGINT", () => { database.close(); process.exit(0); });
process.on("SIGTERM", () => { database.close(); process.exit(0); });
