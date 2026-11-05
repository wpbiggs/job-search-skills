# Hosted workspace: architecture, privacy, and self-hosting

## Product and boundary

The public instructions page remains at `https://william.biggers.family/job-search`.
The optional private application is at `/job-search/workspace`; MCP is at `/job-search/mcp`.
Both private interfaces use the same owner-scoped records. The public page never receives a resume upload; the private workspace accepts text only after a passkey account and storage disclosure.

This is **bring your own AI**. There is no model endpoint, inference billing, job-board credential store, automatic application loop, or employer-contact action. A compatible assistant brings its own reasoning, research, and scheduler. Hosting/storage can still incur costs for the operator; the absence of model costs does not make operation cost-free.

## Architecture

- One separately deployed Cloudflare Worker hosts the private web app, scoped API, OAuth authorization server, and MCP resource endpoint.
- Dedicated D1 tables hold users, passkey public keys, hashed recovery/session tokens, short-lived challenges, preparation records, historical versions, candidate reviews/outcomes, and minimal activity.
- A dedicated Workers KV namespace holds OAuth registrations, grants, hashes, and encrypted props. No AI-provider tokens or upstream employer credentials are stored.
- Routes cover only the new workspace, API, OAuth, MCP, and path-aware discovery endpoints. The portfolio Worker and public downloads remain independent.
- The portable core uses parameterized SQLite statements and also runs as a local stdio MCP server under Node. JSON exports and skill files are independent of Cloudflare and any AI provider.
- SurrealSites is not a runtime dependency. Its reviewed workflow concepts informed this design; its unfinished Express routes, database service keys, auth identities, and application data are not imported. The existing JobSearch Supabase project is left untouched.

## Authentication and consent

Use a discoverable passkey with required user verification. The website never receives your biometric information or passkey private key. Registration and login use single-use, five-minute, browser-bound challenges and validate both the origin and RP ID.

Store the one-time recovery code offline or in your password manager, never in your assistant. Recovery rotates the code, revokes old passkeys, sessions, and assistant permissions, then lets you add a replacement passkey. There is no email address, password, support override, or email-based recovery in this version. Losing all passkeys and the recovery code permanently loses access. Adding a second passkey before losing access is recommended.

Browser sessions are opaque, hashed server-side, HttpOnly, host-only, Secure on HTTPS, SameSite=Lax, and expire after seven days. Cross-site writes are denied. OAuth uses a library-maintained consent flow with a browser-bound single-use handle, escaped client metadata, explicit scopes and return destination, and resource-bound tokens. Read/write tool visibility and database ownership are checked independently. Read the [MCP guide](MCP.md) before granting a client access.

Candidate-only website actions include evidence confirmation, draft/destination approval, recording actual submission or outcomes, deleting data, and revoking connections. The service records **candidate assertions**, not verified employer receipts. It never submits, accepts an offer, or sends a message as a side effect.

## Storage and retention

- This is **not end-to-end encrypted** storage. The operator and hosting administrators can access records. Do not store government IDs, passwords, payment information, browser cookies, or employer-confidential material.
- The production D1 database was created with US jurisdiction; OAuth metadata and normal edge request processing follow Cloudflare's service configuration. This is not a promise of globally localized processing or legal compliance.
- Limit: 250 current preparation records, 64 KiB each, and 2 MiB total across current content plus preserved versions. Review/outcome notes and auth metadata have separate bounded fields. Past versions persist until their record/workspace is deleted, so editing does not erase a claim you previously approved.
- Activity retains up to 200 metadata events, without profile/posting/draft bodies. There are no added advertising or analytics scripts. Platform request logs/traces may retain normal request metadata; URL query strings are redacted and application code does not log request bodies, credentials, or private tool results. Rate limits are abuse controls, not a billing guarantee.
- Challenges expire after five minutes; expired challenges and sessions are cleaned during authentication. Expired records are rejected immediately even before cleanup. OAuth tokens/grants have provider TTLs. Unused OAuth clients can remain registered for their configured registration TTL; their names are not verified endorsements.
- Records remain until the candidate deletes them. Website export includes profile, jobs, assessments, drafts, interview notes, runs, versions, reviews, outcomes, and recent activity. It excludes passkeys, tokens, recovery codes, and sessions.
- Under **Activity & privacy → Storage & all records**, candidates can see current/history byte usage and record counts, filter by type, inspect saved content and previous versions, and delete any preparation record with its history. Deletions require the displayed revision; refresh after a concurrent edit rather than deleting unseen changes. Storage usage is also available through MCP `workspace_info`.
- Profile evidence can be removed from the current profile before saving. Saving preserves earlier versions; it is not erasure. To erase a profile record and its history, delete that record. Drafts, assessments, interview notes or external copies may independently quote the same information and need separate review/deletion. Recreating a profile does not restore approvals: both profile identity and revision are checked.
- Deleting a job deletes its related preparation records/history and review/outcome. Deleting a workspace removes its active owned records, credentials, sessions, and recovery hash and revokes OAuth access. Copies already held in exports, an assistant, or its provider are outside this deletion boundary.
- Cloudflare D1 point-in-time backups can preserve deleted data for up to **30 days** depending on plan. See [Time Travel and backups](https://developers.cloudflare.com/d1/reference/time-travel/). Do not claim immediate erasure of backups. Before restoring a production backup, account for deletion requests and revoked credentials; a restore must not silently re-enable deleted accounts or old grants.

## Portable export format

Exports are JSON with `format: "job-search-workspace"`, `version: 1`, `exported_at`, `account`, `records`, `versions`, `reviews`, `outcomes`, and `events`. Each current record has `id`, `kind`, `job_id`, `data`, `revision`, and timestamps. Evidence has explicit source and confirmation flags. Job records retain source URL, original posting, and the reported checked date. New draft/assessment/interview writes carry both the profile ID and revision used. Older records without a profile ID need a refreshed version before approval against an existing profile; their old history remains readable. No schema migration or rewriting historical content is required for this additive field.

Record and owner IDs are not credentials. Never import an old export's approval or submission assertions as new authorization. There is no automatic import/sync in this release; the format and SQLite adapter allow a candidate or developer to migrate content with explicit review. Authentication credentials are deliberately nonportable; create new passkeys on a new deployment.

## Self-host

Prerequisites: Node 24+, npm, and an authorized Cloudflare account with Workers, D1, KV, and route permissions. No SurrealSites account, Supabase project, model API key, or paid AI subscription is required by this server. Your chosen assistant may have its own requirements.

1. Clone and run `npm ci`. Review the code and dependency lockfile.
2. Replace the deployment-specific account, database, namespace, domain routes, `PUBLIC_ORIGIN`, and `RP_ID` in `wrangler.jsonc`. Create **your own** dedicated D1 database and KV namespace. Never bind production candidate data to an untrusted development environment.
3. Apply migrations locally: `npx wrangler d1 migrations apply DB --local`.
4. Run `npx wrangler types`, `npm run typecheck`, `npm test`, and the existing Python tests.
5. For local browser testing, run:

   ```sh
   npx wrangler dev --port 8791 --ip localhost --var PUBLIC_ORIGIN:http://localhost:8791 --var RP_ID:localhost --infer-origin-from-routes=false
   npm run test:browser
   ```

6. Tests use virtual passkeys and fictional candidates; no production bypass or test login endpoint exists. Apply remote migrations only to the explicitly selected empty/dedicated database: `npx wrangler d1 migrations apply DB --remote`.
7. Run `npm run build` for a dry run, review the route/resource list, then `npm run deploy`. Route Workers take precedence over a same-host Custom Domain Worker; keep patterns narrow to avoid intercepting unrelated site paths.
8. Check OAuth discovery, unauthenticated challenges, real passkey sign-in, two-user isolation, MCP/web shared records, scope restrictions, revocation, export/deletion, and the original website. Use `WORKSPACE_ORIGIN=https://your-host npm run test:browser` only when you authorize fixture-account creation/deletion on that deployment.

The browser test verifies the public protocol and website using the MCP SDK, not a particular commercial client's subscription, connector UI, or scheduler. Test those separately before advertising named compatibility. No job is actually researched or applied to by the fixture suite.

## Operator responsibilities

Protect Cloudflare account access, review dependency/security updates, set account budget/usage alerts, monitor failures without logging private content, honor deletion requests, and publish accurate retention and contact details. The initial implementation is a public preview, not an independently audited employment service, hiring prediction system, or compliance certification. Follow website terms and local employment/privacy laws when adding integrations.
