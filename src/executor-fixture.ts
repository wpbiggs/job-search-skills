import { boundedBody, hash } from "./security.ts";
import { EXECUTOR_FIXTURE_DOCUMENT } from "./executor-contract.ts";

/** Owned fictional ATS. Reject real-looking applicant data and never persist submissions. */
export async function executorFixture(request: Request): Promise<Response> {
  if (request.method === "GET") return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Owned fictional ATS — infrastructure test</title></head><body><h1>Fictional application only</h1><p>No employer receives anything. Only the fixed fictional name/email and test document are accepted.</p><form method="post" enctype="multipart/form-data"><label>Name<input name="name" required></label><label>Email<input type="email" name="email" required></label><label>Résumé<input type="file" name="resume" accept=".txt" required></label><button type="submit">Submit fictional fixture</button></form></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  if (request.method !== "POST" || Number(request.headers.get("Content-Length")) > 100000) return new Response(null, { status: 400 });
  const bytes = await boundedBody(request, 100000);
  const form = await new Request(request, { body: bytes }).formData();
  const resume = form.get("resume");
  const content = resume instanceof File ? await resume.text() : "";
  if (Array.from(form.keys()).length !== 3 || form.get("name") !== "Fictional Candidate" || form.get("email") !== "fixture@example.invalid" || content !== EXECUTOR_FIXTURE_DOCUMENT) return Response.json({ error: "Fictional test payload only. No record stored." }, { status: 400 });
  return Response.json({ synthetic: true, receipt: `fixture-${await hash(crypto.randomUUID() + content)}`, document_digest: await hash(content) });
}
