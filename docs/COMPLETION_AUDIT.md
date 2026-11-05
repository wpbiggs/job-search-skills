# Full-goal audit — 2026-11-05

The first release is a working foundation, not evidence that the entire product goal has been achieved. This audit distinguishes implemented capabilities from real-user validation still needed.

## Verified foundation

- **Shared persistent workspace:** hosted browser and authenticated MCP use the same owner-scoped records. The live fictional-user suite exercises assistant-created profile/job/assessment/draft records, browser review, MCP-visible candidate outcomes, passkey reauthentication, and export after changes. Source: `src/worker.ts`, `src/store.ts`, `test/browser.mjs`.
- **Goals and truthful preparation:** seven accessible workflows plus profile, sourced evidence, preserved postings, fit assessments, drafts, and interview-preparation tools exist. Server checks referenced evidence IDs and verbatim posting quotes; it cannot establish truth or independently verify vacancies. Source: `skills/`, `src/mcp.ts`, `test/store.test.ts`.
- **Evidence candidates can understand:** assessment views now display cited claims, source descriptions, and candidate-confirmed/unconfirmed state, rather than IDs alone. They explicitly flag a changed profile; current evidence is labelled as current, not presented as the historical snapshot. Live browser assertions exercise these states.
- **Review and control:** only website candidate actions record evidence confirmation, draft approval, submissions and outcomes. Unsaved visible draft edits now disable approval/submission controls, with a second handler check before any review request. Existing draft/profile revision checks still reject stale approvals. MCP tokens cannot authorize browser APIs. Source: `src/web/app.ts`, `src/store.ts`, live protocol tests.
- **Privacy/export/deletion:** two-user isolation, export without credentials, passkey recovery/revocation, and account deletion pass live fixture checks. Storage is not end-to-end encrypted; operator access and backup retention remain disclosed limitations, not solved privacy guarantees.
- **Provider independence:** the service runs no model inference and has no mandatory SurrealSites runtime dependency. The local stdio/SQLite mode persists across processes and accepts read-only clients in automated tests. JSON export and candidate-reviewed preparation import are available for hosted/self-hosted/local destinations. Automatic synchronization and full historical/account restore are not implemented.
- **Public entry point:** the account-free instructions and downloads remain separate from optional passkey storage. Previous portfolio regression results are recorded in `VERIFICATION.md`; this increment changes only the private service assets, not portfolio routes or source.

## Not yet established

- **Anyone's chosen assistant:** modern SDK and legacy protocol fixtures are not commercial-client UI/plan compatibility tests. A candidate-controlled pilot must demonstrate account creation, consent, tool discovery, preparation, website review, and resuming a later conversation in an actual chosen client. The agent must not create the candidate's passkey or consent on their behalf.
- **Daily research and preparation:** the run-log protocol and scheduling instructions exist, but no real harness schedule with this connector has been verified. A user-authorized pilot must show a real task, timezone, agreed research scope, execution, and next-run continuity. Do not create schedules merely to satisfy an audit or equate an agent-written completion log with actual research.
- **Useful career outcomes:** fictional fixtures demonstrate plumbing, not better-fit jobs, less repetitive work, truthful model output, or more confident decisions. Validate these with voluntary candidate feedback and reviewed examples; do not infer success from record/application counts.
- **Remaining portability limits:** hosted candidates can inspect/delete any preparation record with its history, remove evidence from the current profile, and see quota usage. Current preparation can now be imported into an empty hosted/self-hosted/local workspace with explicit candidate authorization. This closes the basic preparation-portability gap, not full historical/account recovery. Original history/outcome assertions remain in the private export; no automatic sync or local browser review UI is provided.
- **Hosted CI:** previously blocked before any test steps by the GitHub account billing lock. Local and live test passes are not a hosted-CI pass. Billing changes require the account owner.

## This increment

Deployed private Worker version `5304f6b5-1f65-4bdf-a4fd-00334a2e2443` after typecheck, 13 Node tests, and the isolated workerd/browser suite passed. The expanded live suite then passed evidence display, unsaved-edit review protection, changed-profile warnings, and existing OAuth/privacy/recovery/deletion checks with fictional accounts only. No employer was contacted or real application submitted.

## Candidate data-management increment

Deployed private Worker version `b9196406-f1cc-4c5f-82c1-5453fb718f7f` adds current/history storage counts, type filtering, current/history inspection, deletion of any preparation record with its history, and removal of evidence from the current profile. Read-only MCP clients can inspect the same storage usage. Removing evidence from current content is explicitly distinguished from deleting history or copies in other records.

Deletion requires the displayed record revision and is scoped to the owner. Approvals now bind both profile identity and revision, including an atomic profile check during review. Deleting/recreating a profile cannot revive an old approval at a reused revision number; legacy linked records without profile identity are treated as stale when a profile exists until saved again. Historical content is not silently rewritten.

Verified typecheck, 15 Node tests, 17 Python tests, isolated workerd/browser tests, and the expanded live fictional-user suite, including history inspection, stale/cross-user deletion rejection, profile deletion reclaiming storage, evidence removal, and safe profile recreation. Aggregate live cleanup checks showed zero users, preparation/history records, sessions, passkeys, reviews and outcomes. Public downloads were refreshed in portfolio version `f7bce5fc-18c3-42f9-b80f-0714395be861`; live public-page checks and 36 portfolio route/viewport checks passed afterward.

## Preparation-portability increment

Private Worker `8ef2ee1b-c1f7-43d9-8198-b94c7b619790` adds candidate-reviewed preparation import into an empty hosted/self-hosted workspace. File selection is local-only; validation upload requires explicit consent and a separate reviewed confirmation is required to store preparation. A snapshot digest binds that confirmation to the validated input. Imported records get fresh IDs, remapped job links, revision 1, and unconfirmed evidence. Credentials, old confirmations/approvals, submission/outcome assertions, versions and activity are not restored. Dependent materials require fresh review/save before approval.

The separate candidate-run `src/import-local.ts` CLI uses the same validator and atomic insertion for a local SQLite destination. It is not registered as an MCP tool. Files and destinations require candidate authorization; it cannot be used to bypass hosted candidate-only permissions. See `PORTABILITY.md` for explicit exclusions and instructions. This is preparation migration, not a full restore.

Verified typechecks and 22 Node tests, including import rollback, concurrent/duplicate prevention, malformed/unsafe snapshots, size limits, fresh identity/authority, near-quota chunking and the local CLI. The isolated workerd/browser suite imported all 46 records near 2 MiB, exercising runtime-specific D1 limits rather than relying on Node SQLite alone. The deployed fictional-user suite verified local-only file selection, consent/preview without preparation writes, separate confirmation, read-only MCP visibility of new owned records, no restored authority/history, existing privacy controls and cleanup. No real candidate data or employer contact was involved.

Remaining work is workflow usability and a real chosen-client/harness-scheduling pilot. Full historical restore, automatic synchronization and a local review UI remain explicit nonfeatures rather than implied capabilities. There is still no measured evidence of real candidate outcomes, and no overall-completion claim is made.

Public preparation-portability instructions were added to the allowlisted guide/ZIP in portfolio version `a62e0138-0e35-4c25-8374-69ffcf44bdb3`; live public-page checks and 36 portfolio route/viewport checks passed. Cleanup aggregate counts were zero after the import fixtures. The documented GitHub account-level CI blocker has not been addressed by these changes; no hosted-CI pass is claimed.
