# Verification record

## Reviewed manual-handoff release — 2026-11-06

- Worker: `job-search-workspace`, version `0678aa1c-2a63-46b0-9344-68dddbafbf53`; runtime source commit `eefaf64`, PR #1. Prior production version: `8ef2ee1b-c1f7-43d9-8198-b94c7b619790`.
- Production migration `0004_submission_handoffs.sql` applied to the existing dedicated D1 database. It only adds tables/indexes/triggers; existing preparation records were not rewritten. The previous Worker remains code-compatible with this additive schema. Do not restore a whole database casually: that can undo deletions/revocations and later candidate edits.
- `npm ci` reported zero known dependency vulnerabilities. Generated Wrangler types, both typechecks, **38 Node tests**, **17 Python tests**, dry-run packaging and the **20-group isolated workerd/browser suite** passed. The synthetic ATS was intercepted locally; no real employer was contacted.
- The new tests cover candidate-only writes, owner isolation, exact content/revision binding, profile/job/draft changes and deletion, a racing profile write during approval, expiry, bounded history, double/concurrent opening, uncertain-outcome retry blocking, candidate receipt confirmation, MCP/export sharing, non-restoration on preparation import and cascading deletion.
- Postdeployment **19-group browser/MCP suite passed** on `https://william.biggers.family` with fictional candidates and virtual passkeys. It exercised the new review controls, unsaved-edit rejection, concurrent HTTP/D1 claims, synthetic ATS manual final click, receipt confirmation, owner/token/CSRF boundaries, read-only MCP sharing, export/import, recovery and deletion. Near-quota import remains local-only (the 20th isolated group).
- Live smoke: `/`, `/contributions`, `/job-search`, `/job-search/workspace` and its new JS return 200; unauthenticated `/job-search/api/handoffs` returns 401. Existing route/resource bindings are unchanged. The unchanged portfolio suite also passed **36 route/viewport checks** plus navigation, PDF download, assets and configuration checks; live inference was not invoked.
- Read-only post-test cleanup check: zero fixture-named accounts, handoff intents, handoff attempts and orphan records. No existing candidate records were imported or edited, and no real applications were submitted. Test OAuth client registrations may remain until their provider TTL, without usable revoked grants.
- GitHub Actions could not start jobs because the account is locked for a billing issue (verified check annotations). No hosted-CI pass or merge-gate bypass is claimed.
- Release scope: review a saved document, approve a 15-minute one-use manual handoff, perform employer actions yourself, then record a candidate-reported receipt. **No automated browser executor, employer uploads/submissions, opt-in schedule or real-candidate pilot is enabled or claimed.** Future work remains in `REVIEWED_SUBMISSION_DEPLOYMENT.md`.

## Historical release — 2026-11-05

Previous private Worker: `8ef2ee1b-c1f7-43d9-8198-b94c7b619790`. Candidate-reviewed **preparation import**, not full restore, supports empty hosted/self-hosted destinations and a separate candidate-run local CLI. Typechecks, 22 Node tests, 17 Python tests, dependency audit, dry-run packaging, isolated workerd/browser tests and the expanded deployed fictional-user suite passed. Near-quota 46-record import was exercised locally in workerd, not by repeatedly filling production. Website tests verify file selection does not upload, consented validation stores no preparation, confirmation imports fresh owned IDs visible through MCP, and no approvals/submissions/outcomes/history/credentials are restored. The full-goal audit still records real-client/scheduler and real-candidate validation gaps.

Earlier record-management increment: `b9196406-f1cc-4c5f-82c1-5453fb718f7f`. Candidates can inspect/delete any preparation record and its history, remove evidence from the current profile, and see storage usage. Approvals track profile identity as well as revision so deleting/recreating a profile cannot revive old approval. Deletion rejects stale revisions. Typecheck, 15 Node tests, 17 Python tests, isolated workerd/browser tests and the expanded live fictional-user suite passed. Cleanup aggregate counts were zero. Public downloads were refreshed in portfolio version `f7bce5fc-18c3-42f9-b80f-0714395be861`, followed by passing public-page and 36 portfolio route/viewport checks. See [the full-goal audit](COMPLETION_AUDIT.md) for unresolved requirements; the original release below is not a claim of complete product validation.

Previous increment `5304f6b5-1f65-4bdf-a4fd-00334a2e2443` added candidate-visible evidence/source/confirmation details, changed-profile assessment warnings, and protection against approving or marking submitted with unsaved draft edits. These checks remain in the live suite.

This is an implementation/protocol test record, not an independent security audit or proof that an AI's research is accurate.

## Automated checks

- 17 Python tests cover the original local CLI, privacy/path boundaries, and allowlisted reproducible public downloads.
- 22 Node tests cover shared SQLite storage, two-owner isolation, evidence confirmation, duplicate requisitions, stale edits, quoted requirements, candidate-only review/outcomes, draft/profile identity/revision safety, preserved history, export, deletion/quota recovery, body/URL limits, bounded activity, local stdio persistence/read-only connections, and reviewed preparation import validation, authority reset, rollback/concurrency, near-quota chunking and the local candidate CLI.
- `npm run typecheck` checks both Worker/Node and browser code against their own environments.
- `npm run build` packages the actual Worker, and `npm audit` reports no known dependency vulnerabilities at the time checked. This is not a guarantee of security.
- `npm run test:worker` provisions disposable **local-only** storage, runs the Worker in workerd, and exercises the real browser/MCP protocol. It does not share remote bindings.

GitHub Actions is configured for Python, type checking, Node tests, dependency audit, packaging, and the isolated workerd/browser suite. The initial hosted CI run could not start its jobs because of an account-level runner restriction, before any test steps executed. **No hosted-CI pass is claimed**; the checks above were run locally and against the deployed service.

## Deployed end-to-end checks

`WORKSPACE_ORIGIN=https://william.biggers.family npm run test:browser` passed using **two fictional users and virtual authenticators**, not a production authentication bypass:

- Passkey registration with required user verification, passkey reauthentication, and persisted records.
- Unauthenticated 401 challenge and path-aware authorization/protected-resource discovery.
- OAuth Allow and Deny, real cross-origin callback navigation, authorization-code/S256 PKCE exchange, resource-bound access, and refresh-token rotation.
- Modern MCP SDK connection plus legacy `2025-06-18` Streamable HTTP initialization.
- Read-only versus read/write tool visibility; assistant record writes visible in the website, candidate review/outcomes visible through MCP.
- Cross-user reads denied; MCP tokens cannot authorize the cookie-only website API; browser cookies cannot authorize MCP; CSRF and untrusted browser Origins are rejected.
- Candidate approval of an exact draft/destination, stale approval after editing, preserved earlier draft versions, and explicit candidate-reported submission/interview fixtures. No employer was contacted and no real application was submitted.
- Desktop/mobile layout checks and credential-free portable export.
- Single-use rotating recovery code, immediate denial of old access and refresh tokens, deletion ending sessions and removing owned data.

After the live test, a read-only aggregate database query confirmed **zero users, records, historical versions, sessions, passkeys, reviews, and outcomes** remained. No real candidate data was imported. The fixture client registrations can remain until their provider TTL; they contain no candidate records or usable revoked grants.

## Explicit limits

Specific commercial client UIs, subscription/administrator restrictions, and unattended connector scheduling are not established by generic SDK tests. No actual employer browsing, browser form filling, model inference, factual resume validation, notifications, or daily task execution is performed by the server or this test suite. Real users must create their own passkey and authorize their own assistant. The site and docs state these limits.

The original portfolio and instructions/download page have a separate regression suite in the existing portfolio source. They are not bundled into this standalone service. See `docs/HOSTED_WORKSPACE.md` for hosting, retention, self-hosting, and operator responsibilities.

The preparation-import release refreshed the allowlisted public guide/ZIP (including `PORTABILITY.md`) in portfolio Worker `a62e0138-0e35-4c25-8374-69ffcf44bdb3`. The build/artifact check, live public-page checks, and 36 portfolio route/viewport checks passed. Live fixture cleanup again showed zero users, records/history, sessions, passkeys, reviews and outcomes. Release IDs below describe the original deployment, not the current versions.

## Released deployment

- Private Worker version: `062435c8-851a-4243-974a-796fcae9839f`.
- Portfolio/public-page Worker version: `542d2b07-a938-430a-a404-d48fce97cf0e`.
- After both deployments, the live MCP/browser suite, public prompt-copy/download suite, and 36 original portfolio route/viewport checks passed. Portfolio typecheck, lint, build artifact validation, and its 42 unit tests also passed.
- Source is published in this repository. The public page links to the private workspace, connection documentation, and refreshed allowlisted downloads. No SurrealSites or existing Supabase data was changed.
