# Issue #2: constrained browser infrastructure and pilot gates

## Honest release scope

This increment is **not completion of issue #2**. It adds a separate private Browser Run Worker, exact-payload authorization/attempt storage, a native-form safety adapter, read-only employer-form inspection and a fictional ATS test. **Live employer final submission remains locked in code**, consistent with the current `AGENTS.md` and browser-assistance contract. The implementation does not silently revise that contract. There is no production Greenhouse/Lever/Ashby submission adapter, employer receipt verifier, interactive remote handoff or scheduler in this increment.

Do not report `fixture_verified` as an application, employer contact, or delivery receipt. No state in the new executor schema represents a real submission. The existing candidate-operated manual handoffs are unchanged.

## Start applying with candidate-operated handoffs

The **Applications** tab is the usable submission path while live cloud execution remains locked. It is not an ATS adapter or a claim that issue #2 is complete.

1. Sign in at `/job-search/workspace` using your existing passkey. Confirm your own evidence under **My profile**; an assistant cannot confirm it for you.
2. Choose **Start an application** / **Applications**. The queue distinguishes missing drafts, unconfirmed evidence, profile changes, approved handoffs, opened/uncertain handoffs and candidate-reported submissions/outcomes. Readiness only means materials can be reviewed, not that a vacancy is live or the role suits you.
3. Open the job's next steps and recheck its employer posting. Dates older than seven days, future dates and invalid dates receive a recheck warning. A recent recorded date is not independent verification either.
4. Review the exact saved document and destination, then use **Download reviewed text (.txt)** if useful. The local download contains that snapshot, never unsaved editor contents. It is not a PDF or an approval; an employer may require a different format. Nothing is uploaded to an employer by downloading.
5. Approve the 15-minute manual handoff and open its one-use employer link. You perform the uploads, answers, authentication, legal consents and final submission on the employer's site. Stop and recheck if the role or destination changes.
6. Return to **Jobs & drafts**, refresh records and record the confirmation only after personally submitting and seeing the employer confirmation. If a handoff was opened but the result is unknown, reconcile it before trying again. Candidate reports are labeled as such, never independently verified provider receipts.

Shared ChatGPT reports and schedules are not synchronized by reading a shared URL. Their assistant must actually connect to this workspace's MCP with the candidate's OAuth grant and save records; connecting does not start a schedule or authorize submissions. Do not import guessed evidence or approve records on the candidate's behalf to make a queue appear ready.

## Components and enforcement

- `services/application-executor/`: `job-application-executor`, with Browser Run and the existing dedicated D1 binding; **no routes, workers.dev or version preview URLs**. Its only channel is a Cloudflare account-scoped service binding from `job-search-workspace`. No new bearer secrets are needed or exposed in frontend code.
- `src/executor-contract.ts`: exact ordinary-field/document contracts, SHA-256 document binding and exact public-HTTPS host allowlist. Arbitrary actions, selectors, credentials, sensitive questions, new answers and dynamic code are not accepted.
- `src/executor-browser.ts`: fresh context, JavaScript disabled, service workers blocked, downloads refused, exact document navigation and one approved POST only. Browser Run session-scoped domain guardrails are also applied at acquisition. Redirects, iframes, unknown questions, hidden tokens, legal text, checkboxes/radio/select controls and changed forms stop before filling. These conservative restrictions intentionally make many modern ATS forms unsupported.
- `migrations/0005_executor.sql`: separate owner-bound intents/attempts and pause controls; conditional one-use claim, per-user concurrency cap and five claims/day; synchronous record/profile invalidation; at most 50 intents and 1 MiB of exact payloads per account. A final conditional `running -> committing` gate checks cancellation/pause/expiry. After a possible write, a missing receipt means `uncertain`, never an automatic retry.
- Shared D1 daily browser budget: at most ten acquisitions/day across inspection, fictional checks and claimed runs, plus at most two concurrent browser leases (with two-minute crash expiry). Browser budget entries older than 90 days are removed. This is an application cap, not a Cloudflare account billing guarantee.
- `src/executor-fixture.ts`: owned native multipart form at `/job-search/workspace/executor-fixture`. It accepts only a fixed fictional name, `fixture@example.invalid`, and the exact fictional document constant. It stores nothing. Each accepted request returns a unique synthetic receipt bound to that document digest. Real-looking payloads are rejected.
- Candidate-only website inspection, fictional test, pause, cancel and gated approval/run endpoints preserve same-origin and passkey-session boundaries; MCP tokens cannot authorize them. Private exports include owned form/payload/attempt history but exclude lease nonces/hashes. Preparation import never restores executor authority or history. Linked record/workspace deletion cascades executor records.

## Verification and release procedure

```sh
npm ci
npm run types
npm run typecheck
npm test
npm run test:executor
python3 -m unittest discover -s tests
npm run build
npm run build:executor
npm run test:worker
```

The executor browser test is a real Chromium workflow against a disposable owned HTTPS ATS, not mocked employer submission. It covers filling/upload, final network gate, receipt, unanticipated question/legal escalation, altered page, redirects/off-domain action, cancellation, script/egress denial and uncertain outcomes. Independent SQLite worker-thread connections race for one lease. The integrated workerd suite uses isolated local databases and virtual passkeys. No candidate artifacts belong in the repository.

After verifying account/Worker/bindings and recording a D1 Time Travel bookmark, apply `0005_executor.sql` remotely. Deploy the private Worker **before** the workspace that binds it:

```sh
npx wrangler d1 migrations apply DB --remote
npm run deploy:executor
npm run deploy
EXECUTOR_REMOTE_SMOKE=1 WORKSPACE_ORIGIN=https://william.biggers.family npm run test:browser
WORKSPACE_ORIGIN=https://william.biggers.family npm run check:executor:deployed
```

The explicit remote-smoke option creates only fictional users and runs one controlled ATS check through the actual private service binding and Cloudflare browser. The focused deployed check verifies just that Cloudflare path and fixture-account cleanup without depending on the broader OAuth/MCP test sequence. Each consumes one of the ten daily browser slots; use one as appropriate, not both by default. The normal local suite does not launch a remote browser. Verify authentication, OAuth/MCP, existing portfolio routing, owner isolation and fixture cleanup. Do not erase or query real candidate bodies for a cleanup check.

An additive migration does not require rewriting existing preparation records. Rolling back Worker code can leave these unused tables safely in place; do not restore the entire database and revive deleted records/grants. Per-account pause stops new work and denies a pre-commit final gate. Operator `EXECUTOR_DISABLED=true` disables new private service calls; existing bounded invocations cannot be recalled after an irreversible commit. Scheduling remains absent and independently disabled.

## Verified deployment evidence (2026-11-11 UTC)

- Production migration `0005_executor.sql` applied. Private executor version: `104bb5ae-c041-41fa-8eba-2e1f80e0342e`; workspace version: `fed31e44-4b57-4b2b-a3c3-d3563a1cd5e7` (async review controls fixed in commit `5e298e6`).
- Local verification passed: 53 Node tests, 17 Python tests, typechecks, both dry-run bundles, 11 real Chromium/owned HTTPS ATS scenarios and the isolated multi-worker workerd suite.
- Full deployed browser/OAuth/MCP regression passed all 20 groups at `2026-11-11T01:44:24.147Z`, using fictional accounts only. This supersedes the earlier timeout failures; a delayed-response regression covers the review-button handler-readiness bug.
- The focused actual Cloudflare-browser check independently verified the owned ATS upload and synthetic receipt at `2026-11-11T01:38:13.362Z`. Receipt: `fixture-8e5a22c39d7ff2d24f29870e5c4d42017ce753f039c245e8c7542e1f347b98f3`; response SHA-256: `069fc844172b484e3f81cf458bdd3904db2ce511feedd534d0058581b74ba5db`. **Not an employer receipt.**
- Post-regression read-only metadata check found zero fictional fixture accounts, executor intents, executor attempts and active browser leases. No candidate record bodies were read or modified for cleanup.
- Public smoke checks returned HTTP 200 for the portfolio, workspace, fictional fixture and OAuth discovery; unauthenticated executor/state/MCP requests returned HTTP 401.
- GitHub-hosted CI is blocked, not passed: check-run `130262124897` reports that the account is locked due to a billing issue. Local and deployed checks do not replace a hosted-CI result.
- [Draft PR #3](https://github.com/wpbiggs/job-search-skills/pull/3) remains draft and [issue #2](https://github.com/wpbiggs/job-search-skills/issues/2) remains open. Real pilot outcome: **0/5 employer applications, zero employer receipts, zero employer messages and zero interviews claimed.**

## Candidate-operated workflow release (2026-11-25 UTC)

- Commit `4b7a5f6` adds an Applications queue and exact saved-version plain-text downloads to the existing candidate-operated handoffs. No schema or authorization changes; no live employer adapter enabled.
- Deployed workspace version: `ae19ef13-6b5d-4760-9aae-8b52c4276d2f`. The private executor version is unchanged. The deployed JavaScript matches the local build (SHA-256 `12a86a9d4ac347d66dc5dbf88696e57709b22d20d4ca95dcf07acf46e422e05e`).
- Typechecks, 58 Node tests, 17 Python tests, workspace dry-run and the integrated local workerd/browser suite passed. The browser flow checks queue-to-job navigation, downloaded snapshot bytes, the existing candidate receipt flow and the submitted queue state.
- All 20 deployed browser/OAuth/MCP regression groups passed at `2026-11-25T17:18:53.346Z`, including the queue and download assertions. Post-run read-only metadata checks found zero fictional fixture accounts, executor intents/attempts and browser leases. Candidate record bodies were not queried or modified for cleanup.
- The focused actual Cloudflare-browser test passed again at `2026-11-25T17:16:19.825Z` with a synthetic-only receipt; its fictional account was deleted. It does not establish a live employer integration.
- Public routing/auth smoke passed. Fresh GitHub check-run `139377764119` still reports an account billing lock; hosted CI is not passed.
- Candidate-operated applications can proceed after individual review. Delegated employer execution and the real five-application pilot remain unfinished; no actual employer application or interview is claimed from this release.

## Remaining gates before a real five-application pilot

1. Deliberately review/revise the current final-action project contract, without allowing an assistant to approve its own payloads or attest to legal/sensitive matters.
2. Implement and test specific employer ATS adapters, including supported documents, rendered form fingerprints, provider receipt semantics, bounded permitted network resources and interactive candidate handoff. Native-form fixture success proves none of these for Greenhouse/Lever/Ashby.
3. Candidate reviews current career facts from the chosen résumé source and confirms contact payload, travel/location/pay constraints and individual destinations/documents on the website. Public résumé data does not answer sponsorship, demographic or legal questions.
4. Reconfirm five live suitable openings, no prior duplicate applications, and any terms restricting automation. Do not pad a pilot with unsuitable or stale vacancies.
5. Only then perform the authorized actions, hand all protected questions to the candidate, and report actual provider receipts separately from preparation, inspection, fictional tests and unknown outcomes. Prioritize interview responses and individually approved employer conversations over application volume.

**Issue #2 remains open until those gates have evidence.**
