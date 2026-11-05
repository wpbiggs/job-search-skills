import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const directory = await mkdtemp(join(tmpdir(), "job-search-workerd-fixture-"));
const probe = createServer();
await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const origin = `http://localhost:${port}`;
const wrangler = "node_modules/wrangler/bin/wrangler.js";
const run = (file, args, env = process.env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [file, ...args], { env, stdio: "inherit" });
  child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Fixture command failed (${code})`)));
});
let worker;
try {
  await run(wrangler, ["d1", "migrations", "apply", "DB", "--local", "--persist-to", directory]);
  worker = spawn(process.execPath, [wrangler, "dev", "--port", String(port), "--ip", "localhost", "--persist-to", directory, "--var", `PUBLIC_ORIGIN:${origin}`, "--var", "RP_ID:localhost", "--infer-origin-from-routes=false", "--show-interactive-dev-session=false"], { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Fixture Worker did not become ready")), 60000);
    const accept = chunk => { if (chunk.toString().includes("Ready on")) { clearTimeout(timeout); resolve(); } };
    worker.stdout.on("data", accept);
    worker.stderr.on("data", chunk => { if (/ERROR/.test(chunk.toString())) process.stderr.write(chunk); accept(chunk); });
    worker.once("exit", code => { clearTimeout(timeout); reject(new Error(`Fixture Worker exited early (${code})`)); });
    worker.once("error", error => { clearTimeout(timeout); reject(error); });
  });
  await run("test/browser.mjs", [], { ...process.env, WORKSPACE_ORIGIN: origin });
} finally {
  if (worker?.pid) {
    try { if (process.platform !== "win32") process.kill(-worker.pid, "SIGTERM"); else worker.kill("SIGTERM"); } catch {}
  }
  await rm(directory, { recursive: true, force: true });
}
