# Employer adapters: execution boundary and verified capabilities

## Target

Discover suitable live roles, prepare truthful materials, obtain candidate approval of an exact destination/document/answer package, execute only the approved ordinary actions, pause for candidate-only steps, and capture independently supported outcomes without blind retries. Generic browser access or a fictional receipt does not establish any employer integration.

The current project contract still reserves final employer submission for the candidate. This increment does not modify that contract or enable live writes. A candidate-operated fallback is not completion of the delegated executor.

## Greenhouse public preflight

`src/employer-greenhouse.ts` implements **metadata inspection only**, identified as `greenhouse-public-v1`. It is wired through the existing private service binding and website-only inspection endpoint. `execution_supported`, `live_submission_enabled` and `applicant_data_entered` are all explicitly false. The UI identifies it as preflight, never approval or application.

- Accept only exact HTTPS hosted requisitions on `job-boards.greenhouse.io` or `boards.greenhouse.io`, with one bounded optional `gh_src` token. Embedded forms, arbitrary query parameters, credentials, alternate ports, encoded paths and different hosts are unsupported.
- Construct one official `GET https://boards-api.greenhouse.io/v1/boards/{board}/jobs/{job}?questions=true`. No cookies, credentials, API key, applicant fields, attachment URLs or POST are accepted. No redirects or automatic retries. A ten-second deadline and 200,000-byte streaming limit bound the provider response.
- Verify the provider's returned job ID and hosted destination agree with the saved board/requisition. Stop for unavailable posts, expired deadlines, prospect posts, authentication, rate limits, malformed/changed schema, duplicate field/option identities or oversized reviews.
- Preserve each question's required status and alternative fields (for example, résumé upload **or** résumé text, not two separately required answers). Preserve custom field IDs/options verbatim as inert text. No answer, optional opt-out or location coordinate is inferred.
- Separate ordinary contact fields, document alternatives, candidate-only questions and unsupported controls. Legal consent, demographic questions, hidden geolocation and AI notices remain explicit interventions. Missing consent metadata is not treated as consent-free.
- Bind the complete bounded provider response and exact original destination to a deterministic SHA-256 digest, independent of retrieval time and JSON object-key order. A change to posting content, question labels/options, notices, required flags or identity changes the digest. This is a metadata binding, **not** a rendered-form or payload approval.
- Render provider data only as escaped text. Do not follow embedded links or interpret posting instructions. The review contract is capped below the existing private service response limit.
- Every preflight consumes one slot from the existing global ten-per-day combined inspection/browser budget. It does not acquire a Browser Run session. Existing candidate pause, account/CSRF boundaries and operator disable control still apply.

Source: [Greenhouse Job Board API](https://developers.greenhouse.io/job-board.html#retrieve-a-job). Public metadata GETs do not require authentication. The documented application POST requires an **employer-owned Job Board API key**. Never solicit that key from a candidate, scrape it, expose one in client code or describe a candidate login as equivalent authorization. A future browser adapter must use a permitted rendered employer workflow and honor authentication/challenge/terms boundaries, not bypass them through undocumented endpoints.

## Verification

```sh
npm run typecheck
npm test
npm run build:executor
npm run build
npm run test:executor
npm run test:packages
npm run test:worker
```

`test/employer-greenhouse.test.ts` uses fictional provider responses. It checks exact identity, anonymous GET-only traffic, document alternatives, sensitive/unknown question escalation, changed/closed roles, schema/size bounds, redirects/rate limits/auth stops, deterministic digest invalidation, duplicate identities, missing consent and inert escaped review rendering.

An explicitly scoped deployed read-only check creates a fictional workspace, stores one routing fixture, invokes the website UI/private service against a specified **public** hosted opening, verifies preflight rendering on a phone viewport, asserts that no intent/review/handoff was created, then deletes the fixture account:

```sh
WORKSPACE_ORIGIN=https://william.biggers.family \
GREENHOUSE_JOB_URL='<exact public hosted requisition URL>' \
npm run check:greenhouse:deployed
```

This consumes one metadata-read slot and contacts the specified public job API. It never uploads applicant materials or submits to an employer. Evidence is written to ignored `test-results/greenhouse-deployed.json`. The normal regression suite does not contact real employers.

## Exact ordinary-data/document package

`src/application-package.ts`, `src/application-package-store.ts` and `migrations/0006_application_packages.sql` implement the candidate-owned ordinary-package foundation. **It does not authorize execution, certify sensitive answers or grant final-submission permission.** Every package and summary exposes `approval_scope: ordinary-data-and-documents-only` and `execution_enabled: false`. The queue labels an approved package as **execution pending**, never submitted or independently receipt-verified.

- The server rebuilds previews from owned saved documents and a fresh provider inspection. It does not accept client-supplied document contents, a fabricated inspection, an execution flag or a ready-made package. Approval repeats the provider/document check and requires the exact displayed SHA-256 digest.
- Every provider question needs exactly one explicit decision: supported ordinary answer, a compatible saved document alternative, an optional skip or a deferred candidate step. Required questions cannot be silently skipped. Exactly one current, evidence-checked résumé is required; one compatible cover letter is optional. All document bytes and revisions are included in review.
- Supported ordinary answers are exact standard contact values and explicitly reviewed custom Website/LinkedIn URL fields. Unknown, protected, legal and sensitive answers are not accepted as ordinary package fields. Deferred questions preserve their labels, not inferred answers; protected optional skips are explicit candidate choices, not an inferred "prefer not to say" answer.
- The UI states that preview sends values to the private workspace for validation, and approval stores the exact package there. It shows the employer/destination, answers, document bytes/hashes, explicit skips, deferred steps and pending execution gates before candidate confirmation. Unsaved document edits, input changes and delayed stale preview responses cannot reuse an older review.
- Candidate-only website routes: `POST packages/preview`, `POST packages/approve`, `GET packages`, `GET packages/{id}`, `POST packages/revalidate` and `DELETE packages/{id}` (cancellation). Same-origin/passkey-session checks apply. MCP tokens cannot approve; authorized assistants see preparation-approval summaries through `list_records`, not execution authority. There is no package run/submit endpoint.
- One transactional insert checks job, profile and every document revision, account pause and prior outcomes/attempts. Only one active package per owned job can exist. Local edits synchronously mark approval stale; deleting any linked job/profile/document or the account erases exact package data and its document links. Prior opened/uncertain manual or executor attempts block new package approval rather than encouraging duplicate applications.
- `revalidate` rechecks provider metadata and document bindings without transmitting applicant data. Changed sources mark the package stale; cancellation/expiry is never revived. A current metadata/document snapshot is **not** rendered-form parity, takeover clearance, a submission grant or an employer receipt. The future runner still needs an independent final pre-disclosure/execution gate.
- Limits: 64 KiB UTF-8 per exact package, 50 retained packages and 1 MiB/account, separate from preparation usage. Cancellation retains private history. Exports include exact package bodies and metadata; preparation import reports and discards these approvals. No credentials or execution tokens are introduced.
- Apply additive migration `0006_application_packages.sql` before deploying workspace code that queries these tables. Record a D1 Time Travel bookmark first. Do not restore the entire database to roll back Worker code or silently revive deleted records/grants.

The current global ten-per-day metadata/browser quota is unchanged. The initial inspection, fresh preview and fresh approval each consume a metadata slot; explicit revalidation consumes another. Before a multi-application autonomous pilot, revisit separate bounded metadata/browser budgets instead of silently widening limits or disabling checks.

The optional deployed package test creates only fictional source evidence, documents and contact values in its own temporary workspace, exercises the actual preview/approval UI, asserts that no employer execution/intent/receipt exists, checks synchronous profile-change invalidation, and deletes the fixture account. **Employer contact is GET-only public metadata; fictional ordinary values are sent only to the owned workspace, never to the employer.**

```sh
WORKSPACE_ORIGIN=https://william.biggers.family \
GREENHOUSE_JOB_URL='<exact public hosted requisition URL>' \
CHECK_PACKAGE_FIXTURE=1 npm run check:greenhouse:deployed
```

This mode consumes three public metadata slots. `test/application-package.test.ts` covers exact bindings, ownership, sensitive-field denial, revision races, prior-attempt reconciliation, cancellation/expiry/pause, revalidation, byte/count quotas, exports/imports and cascading erasure. `npm run test:packages` uses an intercepted fictional workspace and real Chromium to test the review/consent UI, unsaved edits, stale asynchronous responses, phone layouts and zero employer requests.

## Verified preflight milestone (2026-11-25 UTC)

- Initial implementation commit: `d9b5686`. Workspace version: `0911f549-40f2-4fb7-85f8-db5a4721a4fb`.
- Equivalent numeric/string option values are rejected by follow-up commit `759eada`; private executor version: `27cf1d12-2ed3-4003-8878-71441f4169ad`. All 15 provider-specific tests passed again before that deployment.
- Typechecks, 73 Node tests (15 Greenhouse-specific), 17 Python tests, both Worker bundles, the 11 owned HTTPS ATS browser scenarios and isolated workerd integration suite passed.
- The deployed phone-viewport preflight check passed initially at `2026-11-25T17:39:26.308Z` and again against the final private service at `2026-11-25T17:41:22.489Z` for an explicitly scoped public hosted opening. It verified eight question groups, three intervention entries, no applicant-data entry, no application intent/review/handoff, and fixture-account deletion. It is **not** an employer submission or receipt test.
- All 20 deployed browser/OAuth/MCP regression groups passed at `2026-11-25T17:41:09.118Z`. Post-run metadata checks found zero fictional accounts, executor intents/attempts and active browser leases; no candidate record bodies were accessed for cleanup.
- Public metadata inspection is now implemented. Exact-payload approval, rendered employer execution, interactive takeover, provider receipt verification and the real application pilot are not completed by this milestone.
- GitHub check-run `139391310126` reports an account billing lock; hosted CI is blocked, not passed.

## Verified exact-package milestone (2026-11-25 UTC)

- Runtime commit `5d7badd`; production migration `0006_application_packages.sql` applied after recording a D1 Time Travel bookmark. Workspace version: `412828ad-8a4b-4bb2-9d97-8c4ab43fc24f`. Private preflight service remains unchanged.
- Typechecks, 98 Node tests (24 package-specific), 17 Python tests, both Worker dry-runs, four real Chromium package-review scenarios and the isolated workerd integration suite passed. A supplemental assertion confirms that a package ID cannot authorize the existing browser executor.
- All 20 deployed browser/OAuth/MCP regression groups passed at `2026-11-25T18:09:32.888Z`, including package endpoint token/CSRF boundaries. The deployed JavaScript matches the local build (SHA-256 `762dad0118f478ee03f24b1828e519247221642a343c7ce67cf43004015adb1d`).
- The optional deployed package fixture passed at `2026-11-25T20:02:04.323Z`: real private-service public metadata, exact fictional contact/document preview, explicit website confirmation, persistent D1 package, execution-pending queue state and synchronous profile-change invalidation. Fictional account deletion succeeded. No employer data entry, application intent, submission or receipt occurred.
- Post-run read-only metadata checks found zero fictional fixture accounts, exact packages, package-document links, browser intents/attempts and active leases. No actual candidate record bodies were queried for cleanup. Portfolio/workspace/assets returned HTTP 200; unauthenticated packages/state/executor/MCP returned HTTP 401.
- GitHub check-run `139408178289` still reports an account billing lock. Local/deployed verification is separate evidence, not a hosted-CI pass.
- This proves the ordinary package storage/review binding, **not the complete goal**: suitable-role discovery, real tailored candidate materials, rendered-form execution grants, a production employer runner, secure candidate takeover and real employer receipt/response verification still need end-to-end evidence. No real pilot outcome is claimed.

## Rendered inspection (inspection only)

`src/employer-rendered.ts` and `src/employer-rendered-browser.ts` add an owner-scoped website operation, `POST executor/render` with an owned `job_id`. It passes no applicant answers or documents to the private browser service. It reserves two units atomically from the existing ten-unit daily combined budget, fetches fresh public metadata, then opens a fresh JavaScript-enabled context. Recording, service workers, downloads and permissions are disabled. The existing two-browser lease and 45-second browser deadline remain in force.

Only the exact initial hosted document and query-free hashed Greenhouse CDN `/assets/` scripts/styles may load (at most 100 requests). Writes, subsequent navigation, redirects, unknown GETs, popups and sockets are denied. Guardrails restrict the browser to the exact job host and Greenhouse asset host. Asset paths are recorded, not claimed to be cryptographic content hashes. There is no employer filling, upload, final click or retained Live View URL.

DOM extraction runs through CDP `Page.createIsolatedWorld` and `Runtime.callFunctionOn`, with universal access disabled and literal JavaScript to avoid transpiler callback helpers. It validates the resulting bounded structure server-side. Input/textarea/contenteditable values and selected options are not read; public page text hashing first removes editable content, scripts and styles. Select option definitions are structural metadata, not selected answers. Two consecutive structural snapshots detect observed changes but cannot guarantee future page stability.

Review binds metadata fingerprint, control IDs/names/types/labels/requiredness/options/constraints, role headings, legal-notice hints, sanitized public-text digest, asset paths and viewport to a rendered fingerprint. Missing, extra, anonymous, reused or changed controls are interventions, as are JavaScript-managed default-GET forms, authentication, challenges, legal text and incomplete restricted rendering. A question-structure match is not overall form readiness, execution authority, legal clearance or receipt evidence. Legal keyword detection is conservative and not an exhaustive legal classifier.

`npm run test:rendered` runs real Chromium against intercepted fictional pages. It verifies isolated-world resistance to page global/prototype overrides, rejected writes/unknown GETs/sockets/popups, no form-value collection, value-independent structural/text fingerprints and legal notices outside the form. Fourteen unit tests cover mismatch rejection, binding changes, bounded schemas, owner/pause boundaries and two-unit budget reservation. The ordinary-package approval scope is unchanged. Secure persistent takeover, execution-grant binding and employer receipt capture remain unimplemented.

Optional scoped deployed check (one metadata preflight plus a two-unit rendered inspection; no applicant profile or documents):

```sh
WORKSPACE_ORIGIN=https://william.biggers.family \
GREENHOUSE_JOB_URL='<exact public hosted requisition URL>' \
CHECK_RENDERED_FIXTURE=1 npm run check:greenhouse:deployed
```

Run separately from `CHECK_PACKAGE_FIXTURE=1`; do not widen the daily budget to run both. The temporary owned workspace is erased on completion or failure. Cloudflare guardrail and recording behavior follows the installed `@cloudflare/playwright` 1.4.0 types and [guardrail documentation](https://developers.cloudflare.com/browser-run/features/guardrails/).

### Deployed rendered verification (2026-11-25 UTC)

- Runtime commit `172dfbb`, workspace version `3cc128e7-750a-499c-8b6f-2379fb7b0f45`, private executor version `d9beab63-e329-4c82-9e6e-a2da2c9ea2de`. No schema migration or existing approval-scope change.
- Passed typechecks, 112 Node tests, 17 Python tests, both dry-run bundles, Chromium package/isolated-world tests and the isolated workerd browser/OAuth/MCP suite. Redirect targets, wrong content types and multiple forms are rejected in intercepted Chromium tests.
- All 20 deployed browser/OAuth/MCP regression groups passed after this deployment, including rendered-route MCP-token and cross-origin denial. These fictional-account tests do not consume employer-inspection budget or establish a real employer outcome.
- Actual Cloudflare rendered fixture passed at `2026-11-25T20:24:14.281Z` against the explicitly scoped public Greenhouse URL above. Eight public question groups versus ten rendered controls: country and an anonymous control were unreviewed; the script-managed default-GET form and two blocked active resources prevented readiness. Seven allowed assets loaded without asset load failures; two consecutive observations were stable. **This is a verified safe stop, not successful execution parity.**
- Public rendered fingerprint: `5a4d195624836735cb71005cae73ea16dc6f91b0903e12adb3f89b717eaafea8`. No applicant fields/documents were supplied, no values collected, no employer writes observed, no submission/receipt created and no interactive session retained. The temporary account was deleted.
- Read-only cleanup metadata confirmed zero rendered-fixture accounts, exact packages, package links, executor intents/attempts and browser leases. Budget increased from six to nine; another two-unit render is not permitted today. Do not bypass or widen the budget for a retry.
- Public smoke checks passed and the deployed application asset matched the build (SHA-256 `6151eecc65491e10a71091acb74e9d8f5339104eacf35e88f36538e170cef4e2`). Real employer applications submitted: zero. The end-to-end objective remains incomplete.
- Fresh hosted check-run `139488564152` could not start due to the GitHub account billing lock. The local/runtime checks above do not establish a hosted-CI pass.

## Unfinished execution work

The separate [fictional takeover controller](TAKEOVER.md) now implements owner-bound persistent pause/control/close infrastructure. It cannot open employer pages or consume preparation packages; it does not close the real-employer takeover gap below.

1. Bind the implemented ordinary package to a verified rendered-form revision and a separately permitted execution grant. Current approval binds job, profile, documents and public question metadata; it does not waive pending takeover, rendered-form or final-action policy gates.
2. A rendered Greenhouse browser adapter with bounded egress, exact approved upload bytes, question/control parity and a tested candidate takeover path. Do not execute with unreviewed JavaScript/network destinations simply because the public API looked ordinary.
3. Secure interactive takeover for authentication, challenges and candidate-only legal/sensitive decisions; changed forms/destinations invalidate authority. Never automate attestations or bypass challenges.
4. Resolution of the current final-submission contract before enabling any autonomous employer commit. The existing flag alone does not enable an employer runner.
5. Employer-specific receipt verification and persisted possible-write/unknown-outcome reconciliation. A success-looking page, a filled form, a provider metadata GET or a synthetic fixture receipt is not an employer confirmation.
6. Only after those gates, an individually approved supervised real pilot and then bounded opt-in discovery/follow-up scheduling. Do not pad the pilot with unverified or unsuitable openings.
