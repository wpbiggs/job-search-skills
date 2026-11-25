import test from "node:test";
import assert from "node:assert/strict";
import { greenhouseTarget, inspectGreenhouse, type GreenhouseInspection } from "../src/employer-greenhouse.ts";
import { greenhouseReview } from "../src/web/employer-review.ts";

const destination = "https://job-boards.greenhouse.io/fictionaltestcompany/jobs/123456";
const now = Date.parse("2026-11-25T20:00:00Z");
const question = (label: string, name: string, type = "input_text", required = true) => ({ label, required, description: null, fields: [{ name, type, values: [] }] });
function job() {
  return { id: 123456, internal_job_id: 987, absolute_url: destination, title: "Fictional implementation role", company_name: "Owned test company", location: { name: "Remote" }, content: "Fictional posting only", updated_at: "2026-11-25T12:00:00Z", application_deadline: null as string | null,
    questions: [question("First Name", "first_name"), question("Last Name", "last_name"), question("Email", "email"), question("Phone", "phone"),
      { label: "Resume/CV", required: true, description: null, fields: [{ name: "resume", type: "input_file", values: [] }, { name: "resume_text", type: "textarea", values: [] }] },
      question("Website", "question_123", "input_text", false)],
    location_questions: [], compliance: null, demographic_questions: null,
    data_compliance: [{ type: "gdpr", requires_consent: false, requires_processing_consent: false, requires_retention_consent: false, retention_period: null, demographic_data_consent_applies: false }],
  };
}
function fetcher(value: unknown, status = 200) {
  const calls: { input: string; init: RequestInit | undefined }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => { calls.push({ input: String(input), init }); return Response.json(value, { status }); };
  return { fetch, calls };
}
async function inspect(value: unknown): Promise<GreenhouseInspection> {
  const result = await inspectGreenhouse(destination, fetcher(value).fetch, now);
  assert.ok("inspection" in result, JSON.stringify(result)); return result.inspection;
}

test("Greenhouse identity parser accepts only exact public hosted requisitions and bounded source tokens", () => {
  assert.deepEqual(greenhouseTarget(destination), { board: "fictionaltestcompany", job: "123456", api: "https://boards-api.greenhouse.io/v1/boards/fictionaltestcompany/jobs/123456?questions=true" });
  assert.equal(greenhouseTarget(destination.replace("job-boards", "boards"))?.job, "123456");
  assert.equal(greenhouseTarget(`${destination}?gh_src=abc-123`)?.job, "123456");
  assert.equal(greenhouseTarget("https://job-boards.greenhouse.io.attacker.invalid/test/jobs/123456"), null);
  for (const url of [destination.replace("https:", "http:"), destination.replace("https://", "https://user:secret@"), `${destination}#application`, `${destination}?callback=anything`, `${destination}?gh_src=a&gh_src=b`, destination.replace("/jobs/123456", "/jobs/%31%32%33"), destination.replace(".io/", ".io:444/"), "https://boards.greenhouse.io/embed/job_app?for=test&token=123456"])
    assert.throws(() => greenhouseTarget(url), /Unsupported Greenhouse/);
});
test("official inspection is exactly one anonymous GET, never a provider POST or credential request", async () => {
  const f = fetcher(job()), result = await inspectGreenhouse(destination, f.fetch, now);
  assert.ok("inspection" in result);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].input, greenhouseTarget(destination)!.api);
  assert.equal(f.calls[0].init?.method, "GET"); assert.equal(f.calls[0].init?.redirect, "manual");
  assert.equal(f.calls[0].init?.credentials, "omit"); assert.equal(f.calls[0].init?.body, undefined);
  assert.deepEqual(f.calls[0].init?.headers, { Accept: "application/json" });
  assert.equal(result.inspection.applicant_data_entered, false);
  assert.equal(result.inspection.execution_supported, false);
  assert.equal(result.inspection.live_submission_enabled, false);
});
test("question groups preserve required flags, alternatives and exact custom IDs without guessing answers", async () => {
  const form = await inspect(job());
  assert.equal(form.questions[0].handling, "ordinary");
  assert.equal(form.questions[4].handling, "document");
  assert.deepEqual(form.questions[4].alternatives.map(field => field.name), ["resume", "resume_text"]);
  assert.equal(form.questions[5].handling, "candidate");
  assert.equal(form.questions[5].required, false);
  assert.equal(form.questions[5].alternatives[0].name, "question_123");
  assert.ok(form.interventions.some(item => item.code === "rendered_form_review"));
  assert.ok(!form.interventions.some(item => item.code === "legal_consent"));
});
test("work eligibility, protected categories, consent and unknown questions always require candidate intervention", async () => {
  for (const label of ["Work authorization", "Sponsorship", "Citizenship", "Veteran status", "Disability", "Criminal history", "Compensation history", "I certify these statements", "I agree to terms", "Optional diversity question"]) {
    const input = job(); input.questions.push(question(label, "question_999", "multi_value_single_select", false));
    const form = await inspect(input); assert.equal(form.questions.at(-1)?.handling, "candidate", label);
    assert.ok(form.interventions.some(item => item.question_id === form.questions.at(-1)?.id));
  }
});
test("field-name or label spoofing and unfamiliar field types do not produce ordinary fields", async () => {
  for (const [name, label, type] of [["first_name", "Work authorization", "input_text"], ["question_1234", "First Name", "input_text"], ["__proto__", "First Name", "input_text"], ["first_name", "First Name", "new_provider_control"]]) {
    const input = job(); input.questions = [question(label, name, type)];
    assert.notEqual((await inspect(input)).questions[0].handling, "ordinary");
  }
});
test("provider identity changes, closed roles and prospect posts cannot be approved as the saved opening", async () => {
  for (const input of [{ ...job(), id: 777 }, { ...job(), absolute_url: destination.replace("123456", "555") }, { ...job(), absolute_url: "https://example.com/external-application" }, { ...job(), internal_job_id: null }, { ...job(), application_deadline: "2026-11-24T00:00:00Z" }]) {
    const result = await inspectGreenhouse(destination, fetcher(input).fetch, now); assert.equal("inspection" in result, false);
  }
});
test("new/oversized question or consent schema fails closed instead of silently dropping information", async () => {
  for (const input of [{ ...job(), new_legal_section: "Must consent" }, { ...job(), questions: undefined }, { ...job(), questions: [{ ...question("First Name", "first_name"), new_consent: true }] }, { ...job(), data_compliance: [{ ...job().data_compliance[0], new_processing_consent: true }] }, { ...job(), questions: [question("X".repeat(1001), "first_name")] }]) {
    const result = await inspectGreenhouse(destination, fetcher(input).fetch, now);
    assert.ok("code" in result); assert.equal(result.code, "provider_schema_changed");
    assert.doesNotMatch(JSON.stringify(result), /Must consent|new_processing_consent/);
  }
});
test("API redirects, authentication, rate limits and unavailable roles never redirect or retry", async () => {
  for (const [status, code] of [[302, "provider_unavailable"], [401, "authentication_required"], [403, "authentication_required"], [404, "opening_unavailable"], [410, "opening_unavailable"], [429, "rate_limited"], [500, "provider_unavailable"]] as const) {
    const f = fetcher({ secret: "must not leak" }, status), result = await inspectGreenhouse(destination, f.fetch, now);
    assert.equal(f.calls.length, 1); assert.ok("code" in result); assert.equal(result.code, code); assert.doesNotMatch(JSON.stringify(result), /must not leak/);
  }
});
test("HTML challenges, malformed JSON, network errors and oversized streams are bounded safe stops", async () => {
  for (const fetch of [async () => new Response("Challenge", { headers: { "Content-Type": "text/html" } }), async () => new Response("{", { headers: { "Content-Type": "application/json" } }), async () => { throw Error("Private upstream exception"); }, async () => new Response("x".repeat(200001), { headers: { "Content-Type": "application/json" } })] as (typeof globalThis.fetch)[]) {
    const result = await inspectGreenhouse(destination, fetch, now);
    assert.ok("code" in result); assert.equal(result.applicant_data_entered, false); assert.doesNotMatch(JSON.stringify(result), /Private upstream exception|Challenge/);
  }
});
test("digest is independent of inspection time and object-key order but binds posting, questions and notices", async () => {
  const input = job(), first = await inspect(input);
  const second = await inspectGreenhouse(destination, fetcher(Object.fromEntries(Object.entries(input).reverse())).fetch, now + 1000);
  assert.ok("inspection" in second); assert.equal(first.fingerprint, second.inspection.fingerprint);
  assert.notEqual(first.checked_at, second.inspection.checked_at);
  for (const changed of [{ ...input, content: "Changed job requirements" }, { ...input, questions: [...input.questions, question("New question", "question_456")] }, { ...input, ai_disclaimer: "New notice" }]) assert.notEqual((await inspect(changed)).fingerprint, first.fingerprint);
});
test("duplicate provider field names stop before creating an ambiguous review", async () => {
  const input = job(); input.questions.push(question("Other Name", "first_name"));
  const result = await inspectGreenhouse(destination, fetcher(input).fetch, now);
  assert.ok("code" in result); assert.equal(result.code, "ambiguous_fields");
});
test("duplicate provider options and demographic identities stop rather than becoming ambiguous answers", async () => {
  const input = job();
  const option = { value: 1, label: "Yes" };
  const duplicate = { ...input, questions: [{ ...question("Custom question", "question_777"), fields: [{ name: "question_777", type: "multi_value_single_select", values: [option, option] }] }] };
  const result = await inspectGreenhouse(destination, fetcher(duplicate).fetch, now);
  assert.ok("code" in result); assert.equal(result.code, "ambiguous_fields");
  const mixedTypes = { ...input, questions: [{ ...question("Custom question", "question_777"), fields: [{ name: "question_777", type: "multi_value_single_select", values: [option, { value: "1", label: "Different label, same form value" }] }] }] };
  const mixedResult = await inspectGreenhouse(destination, fetcher(mixedTypes).fetch, now);
  assert.ok("code" in mixedResult); assert.equal(mixedResult.code, "ambiguous_fields");
  const demographic = { id: 1, label: "Optional", type: "multi_value_single_select", required: false, answer_options: [] };
  const demographics = await inspectGreenhouse(destination, fetcher({ ...input, demographic_questions: { header: "Optional", description: "", questions: [demographic, demographic] } }).fetch, now);
  assert.ok("code" in demographics); assert.equal(demographics.code, "ambiguous_fields");
});
test("missing consent information and a response from any different endpoint cannot silently pass", async () => {
  const input = job();
  const { data_compliance, ...withoutConsent } = input;
  assert.ok((await inspect(withoutConsent)).interventions.some(item => item.code === "legal_consent"));
  const response = Response.json(input);
  Object.defineProperty(response, "url", { value: "https://example.com/changed" });
  const result = await inspectGreenhouse(destination, async () => response, now);
  assert.ok("code" in result); assert.equal(result.code, "destination_changed");
});
test("legal notices, location questions and demographic opt-outs remain interventions, never answers", async () => {
  const input = { ...job(), location_questions: [question("Location", "location"), question("Latitude", "latitude", "input_hidden")],
    data_compliance: [{ ...job().data_compliance[0], requires_processing_consent: true }], ai_disclaimer: "<p>We use AI</p>",
    demographic_questions: { header: "Optional disclosure", description: "<p>Demographics</p>", questions: [{ id: 7, label: "Disability", required: false, type: "multi_value_single_select", answer_options: [{ id: 9, label: "Prefer not to say", free_form: false }] }] } };
  const form = await inspect(input);
  assert.ok(form.interventions.some(item => item.code === "legal_consent"));
  assert.ok(form.interventions.some(item => item.code === "ai_notice"));
  assert.equal(form.questions.find(item => item.section === "location")?.handling, "candidate");
  assert.equal(form.questions.find(item => item.section === "demographic")?.handling, "candidate");
  assert.ok(form.questions.every(item => item.alternatives.every(field => !("value" in field))));
});
test("rendered review escapes all provider text and cannot contact external pages or submit", async () => {
  const input = job(); input.questions[0].label = '<img src="https://example.com/leak">';
  const form = await inspect(input), html = greenhouseReview(form);
  assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img|<script|href=|<input|<form|<button/);
  assert.match(html, /not approval or submission/); assert.match(html, /Live execution remains disabled/);
});
