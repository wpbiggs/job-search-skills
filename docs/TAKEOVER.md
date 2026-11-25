# Candidate takeover controller — fictional transport only

This is execution infrastructure, **not a production employer takeover or an application submission capability**. `CandidateTakeover` is a private SQLite-backed Durable Object per workspace owner, invoked through the existing private executor service. The only start operation opens a built-in fictional practice page in `about:blank`. No employer URL, candidate profile, ordinary package, document, authentication secret or screening answer is accepted. Browser guardrails deny all HTTP/HTTPS hosts; context routing denies network and sockets. Recording, JavaScript, service workers, downloads and permissions are disabled.

## Ownership and authorization

- Website route: `POST executor/takeover`. A passkey browser session and same-origin check are required. `start_fixture` and `view` each require explicit fictional-scope confirmation. Extra fields/destinations are rejected. There is no MCP takeover tool and no general run/resume operation.
- The website supplies the authenticated owner ID and current epoch to the private service, never values from applicant data. The Durable Object name must equal that owner. Status/view/end check the active generation and original epoch; a different account, epoch or generation cannot obtain its capability.
- Each start claims persistent state **before** external I/O. It reserves one unit from the unchanged global ten-unit metadata/browser budget and one of two shared browser leases. Simultaneous starts do not acquire duplicate browsers. Ambiguous start outcomes require status reconciliation, not an automatic retry.
- Browser/session identity is persisted immediately after acquisition, before page setup and before any Live View URL is minted. Browser transport is reconnectable from stored identity following a runtime restart. No control URL is stored in SQLite, D1, audit events, exports or MCP results.

## Capability release and closure

- `Cloudflare.handoff` marks a structured pause. Only an explicit website `view` request mints a tab-scoped Live View capability, limited to 30 seconds for new connections and never beyond the original two-minute authorization deadline. Ownership/state/expiry are rechecked **after** asynchronous minting. Unexpected control origins are rejected. The browser-only link uses `noopener noreferrer` and no-referrer; it must never be shared, saved, logged, traced or screenshotted.
- Token expiry only limits new connections. It does not revoke an established viewer. The controller therefore closes the browser on cancellation, end, revocation or expiry. Successful end means **close**, never resume, legal clearance, execution approval, submission or employer confirmation.
- Durable alarms recheck owner epoch, account existence, pause and operator disable state at ten-second intervals and at the deadline. Pause, connection revocation and workspace deletion also request immediate best-effort closure through the private service. Alarm delivery/transport availability are not real-time guarantees. Errors preserve a future cleanup alarm rather than relying only on the platform's finite automatic retries.
- Closing state revokes new link issuance before external work. Close failures preserve session identity and return `closing`, not `closed`; alarms retry. A reconnect failure is not proof of closure: the driver confirms absence from active Browser Run sessions before releasing a lease. Completed cleanup deletes the per-owner state and alarm. An older concurrent close cannot erase a newer generation.
- Takeover leases are not expired/reaped simply because authorization expired: connected viewers may still exist until closure is confirmed. The Durable Object owns lease deletion. A pre-identity abandoned start, which could never issue a capability, can clear its claim after the startup/idle grace period. An outage may temporarily retain a lease and block further acquisitions; never resolve this by blindly deleting active lease rows.
- The UI keeps diagnostics lazy, clears displayed links on end/check/expiry or when its details close, and exposes no resume action. A controller does not depend on UI polling to perform cleanup.

## Tests and deployment

`test/takeover-controller.test.ts` tests state/race/ownership/expiry/cleanup behavior with mocked dependencies. `npm run test:takeover` uses actual workerd RPC, SQLite and D1 with only the browser transport mocked; it restarts the whole runtime to prove persistent recovery and verifies owner isolation, expiry, epoch revocation, state erasure and lease cleanup. Test-only subclass/debug methods exist only in the isolated generated test Worker, not the deployed class. The regular browser suite checks token/CSRF boundaries and extra destination/payload rejection without consuming cloud-browser budget.

The additive Durable Object migration is `v1-takeovers` in the executor Wrangler configuration. No D1 migration or existing ordinary-package approval change is required. Deploy the executor before the workspace. This migration creates a new SQLite namespace; do not remove the class/migration or revert resource state when rolling back unrelated Worker code.

Optional actual Cloudflare transport check:

```sh
WORKSPACE_ORIGIN=https://william.biggers.family \
CHECK_FICTIONAL_TAKEOVER=1 npm run check:takeover:deployed
```

This uses one browser unit, a disposable fictional account and the built-in network-denied practice page. It keeps the capability only in memory, attempts an actual viewer socket connection, cancels the generation, verifies established-viewer closure, stale-generation denial and export exclusion, then deletes the fixture account. It saves only non-secret verification booleans. Do not enable traces/screenshots or print bearer-bearing errors. A failed transport check is not a reason to bypass the daily quota.

Official references: [Browser Run structured handoff](https://developers.cloudflare.com/browser-run/features/human-in-the-loop/), [Live View](https://developers.cloudflare.com/browser-run/features/live-view/), [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), [DO rules/concurrency](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/). Installed runtime/library types remain authoritative for API signatures.

## Still required for employer use

The fictional transport proves none of the following: permitted real-employer disclosure, approved ordinary-package/rendered-form binding, browser-level egress enforcement across eviction/reconnect, safe handling of legal/sensitive questions in an employer form, verified session resumption, an autonomous final-action grant, receipt capture or real outcomes. Context routing is not a durable security boundary after controller eviction or a disconnected driver; employer execution needs an independently enforced egress policy and exact grants. Never silently substitute ordinary preparation approval for these missing permissions. Existing governing instructions still reserve final submission to the candidate.
