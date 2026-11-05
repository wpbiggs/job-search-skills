import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import type { SqlDatabase, Statement } from "./store.ts";

/** Node SQLite adapter for the same parameterized statements used by D1. */
export class LocalDatabase implements SqlDatabase {
  readonly connection: DatabaseSync;
  constructor(filename: string) {
    this.connection = new DatabaseSync(filename);
    this.connection.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const version = this.connection.prepare("PRAGMA user_version").get() as { user_version: number };
    const migrations = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(migrations).filter(name => /^\d+_.*\.sql$/.test(name)).sort()) {
      const number = Number(name.split("_")[0]);
      if (number > version.user_version) {
        this.connection.exec("BEGIN IMMEDIATE");
        try { this.connection.exec(readFileSync(new URL(name, migrations), "utf8")); this.connection.exec(`PRAGMA user_version=${number}`); this.connection.exec("COMMIT"); }
        catch (error) { this.connection.exec("ROLLBACK"); throw error; }
      }
    }
  }
  prepare(query: string): Statement {
    const database = this.connection;
    let values: SQLInputValue[] = [];
    const statement: Statement = {
      bind(...input) { values = input as SQLInputValue[]; return statement; },
      async first<T>() { return (database.prepare(query).get(...values) ?? null) as T | null; },
      async all<T>() { return { results: database.prepare(query).all(...values) as T[] }; },
      async run() { return { meta: { changes: Number(database.prepare(query).run(...values).changes) } }; },
    };
    return statement;
  }
  async batch(statements: Statement[]): Promise<unknown[]> {
    this.connection.exec("BEGIN IMMEDIATE");
    try { const results = []; for (const statement of statements) results.push(await statement.run()); this.connection.exec("COMMIT"); return results; }
    catch (error) { this.connection.exec("ROLLBACK"); throw error; }
  }
  close() { this.connection.close(); }
}
