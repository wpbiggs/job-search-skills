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

## Verified preflight milestone (2026-11-25 UTC)

- Initial implementation commit: `d9b5686`. Workspace version: `0911f549-40f2-4fb7-85f8-db5a4721a4fb`.
- Equivalent numeric/string option values are rejected by follow-up commit `759eada`; private executor version: `27cf1d12-2ed3-4003-8878-71441f4169ad`. All 15 provider-specific tests passed again before that deployment.
- Typechecks, 73 Node tests (15 Greenhouse-specific), 17 Python tests, both Worker bundles, the 11 owned HTTPS ATS browser scenarios and isolated workerd integration suite passed.
- The deployed phone-viewport preflight check passed initially at `2026-11-25T17:39:26.308Z` and again against the final private service at `2026-11-25T17:41:22.489Z` for an explicitly scoped public hosted opening. It verified eight question groups, three intervention entries, no applicant-data entry, no application intent/review/handoff, and fixture-account deletion. It is **not** an employer submission or receipt test.
- All 20 deployed browser/OAuth/MCP regression groups passed at `2026-11-25T17:41:09.118Z`. Post-run metadata checks found zero fictional accounts, executor intents/attempts and active browser leases; no candidate record bodies were accessed for cleanup.
- Public metadata inspection is now implemented. Exact-payload approval, rendered employer execution, interactive takeover, provider receipt verification and the real application pilot are not completed by this milestone.
- GitHub check-run `139391310126` reports an account billing lock; hosted CI is blocked, not passed.

## Unfinished execution work

1. Candidate-owned exact ordinary-field/document/skip package review and durable approval bound to job, profile, document and rendered-form revisions. A preflight digest alone authorizes nothing.
2. A rendered Greenhouse browser adapter with bounded egress, exact approved upload bytes, question/control parity and a tested candidate takeover path. Do not execute with unreviewed JavaScript/network destinations simply because the public API looked ordinary.
3. Secure interactive takeover for authentication, challenges and candidate-only legal/sensitive decisions; changed forms/destinations invalidate authority. Never automate attestations or bypass challenges.
4. Resolution of the current final-submission contract before enabling any autonomous employer commit. The existing flag alone does not enable an employer runner.
5. Employer-specific receipt verification and persisted possible-write/unknown-outcome reconciliation. A success-looking page, a filled form, a provider metadata GET or a synthetic fixture receipt is not an employer confirmation.
6. Only after those gates, an individually approved supervised real pilot and then bounded opt-in discovery/follow-up scheduling. Do not pad the pilot with unverified or unsuitable openings.
