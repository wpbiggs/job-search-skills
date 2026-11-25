import type { SqlDatabase } from "./store.ts";

/** Atomic shared budget: a rendered inspection reserves metadata + browser units together. */
export async function claimInspectionBudget(db: Pick<SqlDatabase, "prepare">, units: 1 | 2 = 1, now = Date.now()): Promise<boolean> {
  if (units !== 1 && units !== 2) throw Error("Invalid inspection budget units");
  const quota = await db.prepare("INSERT INTO executor_budget(day,used) VALUES(?,?) ON CONFLICT(day) DO UPDATE SET used=used+excluded.used WHERE used+excluded.used<=10 RETURNING used")
    .bind(new Date(now).toISOString().slice(0, 10), units).first();
  await db.prepare("DELETE FROM executor_budget WHERE day<?").bind(new Date(now - 90 * 86400000).toISOString().slice(0, 10)).run();
  return Boolean(quota);
}
