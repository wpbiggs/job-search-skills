# Private workspace implementation

## Steps
- [x] Inspect the existing site, skills, SurrealSites foundation, and dedicated database without changing unrelated resources.
- [x] Build an independent private workspace service with passkey authentication, recovery, scoped storage, export, deletion, and browser-only approval controls.
- [x] Add authenticated MCP tools, portable local support, evidence-backed records, and harness scheduling guidance.
- [x] Build the website workspace and connection flow while preserving the public instructions/downloads.
- [x] Verify real browser authentication, MCP/web shared records, isolation, permissions, export/deletion, and existing site behavior.
- [ ] Publish the open-source implementation, deploy isolated resources, and verify the live experience.

## Constraints

The product lives at william.biggers.family/job-search. The candidate chooses and pays for their own AI provider; this service performs no inference, job-board login, employer contact, final submission, or autonomous browser operation. Harness-supported scheduling triggers the user's assistant, not an implied server-side search service.

Private records must be isolated by authenticated owner. No account IDs supplied by tools may select another owner's data. Assistants may prepare records and drafts but may not approve disclosures, certify facts, mark an application submitted, delete a workspace, or grant themselves additional scopes. Those actions belong to the authenticated website, with explicit confirmation. Browser-only controls are a permission boundary against an MCP token, not a guarantee against an unrelated agent that already controls the user's browser.

Use passkeys with required user verification and single-use browser-bound challenges. Offer a high-entropy, rotating recovery code; do not imply email recovery exists. Sessions and connection grants are revocable. No government IDs, credentials, browser cookies, or payment details belong in workspace records. Disclose hosting/storage and external AI processing separately. Minimize logs, bound requests and workspace quotas, and export a documented portable JSON format.

The existing portfolio and public assets remain available. Use a separate Worker, database, and OAuth namespace; route only the workspace and MCP/auth endpoints. The inspected Supabase project and SurrealSites PR are not prerequisites and are not changed. Reuse reviewed workflow concepts, not unfinished privileged code.

Keep source open and dependencies pinned with a lockfile. Provide local stdio MCP support and vendor-independent records/skills, alongside the hosted deployment. Publish exact compatibility and verification limits instead of claiming all clients or all sites work.
