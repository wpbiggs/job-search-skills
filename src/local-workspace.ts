import { mkdirSync, chmodSync, realpathSync, existsSync, writeFileSync, lstatSync } from "node:fs";
import { resolve, relative, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalDatabase } from "./sqlite.ts";
import { token, hash } from "./security.ts";

/** Local filesystem ownership, not hosted OAuth, is the trust boundary for these commands. */
export async function openLocalWorkspace(path: string) {
  const repository = fileURLToPath(new URL("../", import.meta.url));
  const directory = resolve(path);
  const isOutside = (path: string) => path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
  if (!isOutside(relative(repository, directory))) throw new Error("Keep private data outside the public repository.");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!isOutside(relative(realpathSync(repository), realpathSync(directory)))) throw new Error("A symlink points the workspace into the public repository.");
  chmodSync(directory, 0o700);
  if (!existsSync(resolve(directory, ".gitignore"))) writeFileSync(resolve(directory, ".gitignore"), "*\n!.gitignore\n", { flag: "wx", mode: 0o600 });
  const filename = resolve(directory, "workspace.sqlite");
  if (existsSync(filename) && lstatSync(filename).isSymbolicLink()) throw new Error("Refusing a symlinked database.");
  const database = new LocalDatabase(filename);
  try {
    chmodSync(filename, 0o600);
    let user = await database.prepare("SELECT id FROM users LIMIT 1").first<{ id: string }>();
    if (!user) {
      user = { id: crypto.randomUUID() };
      await database.prepare("INSERT INTO users(id,name,epoch,recovery_hash) VALUES(?,?,?,?)").bind(user.id, "Local job search", token(), await hash(token())).run();
    }
    return { database, userId: user.id };
  } catch (error) { database.close(); throw error; }
}
