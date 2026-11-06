# Reviewed submission deployment on william.biggers.family

## Deployment decision

**Use this repository as the canonical application.** The existing private site at `/job-search/workspace` has passkey identity, owner-bound Cloudflare D1 storage, reviewed versions, portable exports, and MCP. The Supabase JobSearch table and Surreal Sites PR #169 are separate prototypes and **must not be implicitly synced or made authorities**. Do not route the personal portfolio root to a replacement app.

The current Worker intentionally does not contact employers. The separate `src/submission-policy.ts` is a pure policy foundation and **not a deployed submission capability**.

## Architecture

1. Scheduled discovery and drafting operates through an explicitly connected research harness or a scoped separate worker; it saves candidates and draft revisions through the existing MCP with `workspace:write`. No application disclosure through MCP.
2. Candidate signs into `/job-search/workspace` with a passkey and reviews a snapshot containing job source, destination URL, exact résumé hash, screening answers, declared facts, terms, and disclosure notice.
3. Server creates immutable one-time candidate authorization bound to user, job, draft version, profile revision, exact destination, content digest, and short expiry. Do not reuse the current human-reviewed draft approval record as a browser permission grant.
4. A dedicated browser worker obtains only a scoped one-use job, not the candidate's website session, OAuth grant, unrestricted credentials, or general workspace export. It can operate only on an approved employer/ATS destination and allowed form fields. Redirects or changed form contents invalidate authorization.
5. Login, CAPTCHA, EEO, criminal-history, work authorization, attestations, terms, unexpected questions or changed destination are sent back to the candidate. Do not bypass protected interactions.
6. On an employer system where delegated submission is allowed and the exact reviewed application/consent can be honored, final action is separately authorized and audited; where not, return an interactive browser session for candidate final click.
7. Mark `submitted` only on an actual employer confirmation/receipt; store timestamp, source, and sanitized evidence with immutable attempt ID. Avoid duplicate retries when outcome is unknown.

## Required implementation before a live rollout

- D1 migration for `submission_intents`, `submission_attempts`, and minimal sanitized receipt evidence, with ownership checks and atomic `approved -> claimed` transitions. Reject repeat claims.
- Server-side approval handler restricted to passkey-authenticated website sessions with same-origin checks, CSRF protections, current revisions, candidate confirmation, and bounded approvals.
- Browser execution service with domain allowlist, network egress protections, forbidden operations, timeouts, per-user quotas, concurrency caps and cancellation.
- Prefer native approved ATS APIs when available. For graphical browser work, use an isolated browser session without importing the user's main browser cookies.
- Worker-to-worker service authentication and secret rotation; no service credentials in JavaScript bundles, public repository, browser logs, or D1 records.
- Opt-in daily scheduler and tenant-safe queues with idempotency, account-level pause, and explicit cost/usage limits.
- Dashboard views for draft review, approval, queued, running, needs-intervention, submitted, failed, and cancel; accessible from a mobile browser.
- Unit tests for policy, state machine, stale revisions, user isolation, redirect refusal and duplicate attempts; integration tests on an owned fixture ATS; then a supervised five-application real-world pilot.

## Existing environment

Cloudflare Worker `job-search-workspace` routes `william.biggers.family/job-search/workspace*`, `/job-search/api/*`, `/job-search/mcp*`, and OAuth paths. Existing data store is Cloudflare D1 `job-search-workspace`, not Supabase. Existing `wrangler.jsonc` already configures the domain, D1, KV and security rate limits. Keep these bindings intact.

## Release and verification gate

- Run `npm ci && npm run typecheck && npm test && npm run build` and any existing Python tests, plus browser tests against a local isolated D1 database.
- Review migration and use `npx wrangler d1 migrations apply DB --local` first. Production migration and `npm run deploy` require verified Cloudflare authorization and a deliberate release.
- After deployment verify `/job-search/workspace` sign-in, MCP OAuth, original portfolio routing, owner-isolation and job-search state transitions. **Do not enable employer submissions** until the test-site and live pilot gates pass.

## Status of this branch

Source policy and synthetic policy tests only. No Cloudflare deployment action has been invoked and no employer application submitted.
