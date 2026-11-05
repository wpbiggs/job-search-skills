# Verification record — 2026-11-05

Latest private-service increment: `5304f6b5-1f65-4bdf-a4fd-00334a2e2443`. Candidate-visible evidence/source/confirmation details and changed-profile assessment warnings were added; unsaved draft edits cannot be approved or marked submitted. Typecheck, 13 Node tests, isolated workerd/browser tests, and the expanded live fictional-user suite passed. See [the full-goal audit](COMPLETION_AUDIT.md) for unresolved requirements; the original release below is not a claim of complete product validation.

This is an implementation/protocol test record, not an independent security audit or proof that an AI's research is accurate.

## Automated checks

- 17 Python tests cover the original local CLI, privacy/path boundaries, and allowlisted reproducible public downloads.
- 13 Node tests cover shared SQLite storage, two-owner isolation, evidence confirmation, duplicate requisitions, stale edits, quoted requirements, candidate-only review and outcomes, draft/profile approval invalidation, preserved history, export, deletion, body/URL limits, quotas, bounded activity, and real local stdio MCP persistence/read-only connections.
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

## Released deployment

- Private Worker version: `062435c8-851a-4243-974a-796fcae9839f`.
- Portfolio/public-page Worker version: `542d2b07-a938-430a-a404-d48fce97cf0e`.
- After both deployments, the live MCP/browser suite, public prompt-copy/download suite, and 36 original portfolio route/viewport checks passed. Portfolio typecheck, lint, build artifact validation, and its 42 unit tests also passed.
- Source is published in this repository. The public page links to the private workspace, connection documentation, and refreshed allowlisted downloads. No SurrealSites or existing Supabase data was changed.
