# Issue #2: constrained browser infrastructure and pilot gates

## Honest release scope

This increment is **not completion of issue #2**. It adds a separate private Browser Run Worker, exact-payload authorization/attempt storage, a native-form safety adapter, read-only employer-form inspection and a fictional ATS test. **Live employer final submission remains locked in code**, consistent with the current `AGENTS.md` and browser-assistance contract. The implementation does not silently revise that contract. There is no production Greenhouse/Lever/Ashby submission adapter, employer receipt verifier, interactive remote handoff or scheduler in this increment.

Do not report `fixture_verified` as an application, employer contact, or delivery receipt. No state in the new executor schema represents a real submission. The existing candidate-operated manual handoffs are unchanged.

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
```

The explicit remote-smoke option creates only fictional users and runs one controlled ATS check through the actual private service binding and Cloudflare browser. It consumes one of the ten daily browser slots. The normal local suite does not launch a remote browser. Verify authentication, OAuth/MCP, existing portfolio routing, owner isolation and fixture cleanup. Do not erase or query real candidate bodies for a cleanup check.

An additive migration does not require rewriting existing preparation records. Rolling back Worker code can leave these unused tables safely in place; do not restore the entire database and revive deleted records/grants. Per-account pause stops new work and denies a pre-commit final gate. Operator `EXECUTOR_DISABLED=true` disables new private service calls; existing bounded invocations cannot be recalled after an irreversible commit. Scheduling remains absent and independently disabled.

## Remaining gates before a real five-application pilot

1. Deliberately review/revise the current final-action project contract, without allowing an assistant to approve its own payloads or attest to legal/sensitive matters.
2. Implement and test specific employer ATS adapters, including supported documents, rendered form fingerprints, provider receipt semantics, bounded permitted network resources and interactive candidate handoff. Native-form fixture success proves none of these for Greenhouse/Lever/Ashby.
3. Candidate reviews current career facts from the chosen résumé source and confirms contact payload, travel/location/pay constraints and individual destinations/documents on the website. Public résumé data does not answer sponsorship, demographic or legal questions.
4. Reconfirm five live suitable openings, no prior duplicate applications, and any terms restricting automation. Do not pad a pilot with unsuitable or stale vacancies.
5. Only then perform the authorized actions, hand all protected questions to the candidate, and report actual provider receipts separately from preparation, inspection, fictional tests and unknown outcomes. Prioritize interview responses and individually approved employer conversations over application volume.

**Issue #2 remains open until those gates have evidence.**
