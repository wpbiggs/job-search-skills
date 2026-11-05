# Move preparation without moving authority

You can move current preparation records between hosted/self-hosted workspaces and the optional local SQLite mode using a version-1 JSON export. This is **not** a complete account or historical restore, and it is not synchronization.

## What transfers

- Current profile goals/preferences/constraints and evidence, saved jobs and original postings, fit assessments, drafts, interview preparation and agent-reported run logs.
- New record IDs and revision 1 are assigned; job links are remapped within the snapshot. Posting checked dates and run dates remain reported source dates, not new verification.
- All evidence becomes **unconfirmed**. Imported dependent materials must be reassessed/rechecked and saved against the current profile before candidate approval. Copying an export never grants permission to disclose or submit anything.

## What does not transfer

- Authentication credentials, passkeys, recovery codes, sessions, OAuth connections, account ownership or workspace name.
- Candidate approvals, evidence confirmations, submission/outcome assertions, old record versions and activity events. These remain available in the original export for private reference, but are not reinstated as current authority or verified facts. Re-enter actual outcomes yourself if needed.

Keep the original export privately. An import is not a reason to destroy your source workspace or only copy. Never put exports in a public repository or paste them into an assistant unless you authorize that provider to process them.

## Hosted or self-hosted destination

1. On the source website, choose **Activity & privacy → Export my workspace**. Local MCP users can explicitly request `export_workspace` and privately save its JSON output; doing so brings those records into their assistant context. A client may wrap the JSON in a tool-result envelope—save the actual export object, not the envelope or a Markdown code block.
2. Open an **empty** destination workspace, signing in with your own passkey. Import never merges with or overwrites existing records. Use an independent destination for migration; do not delete useful data merely to test import.
3. Under **Activity & privacy → Import preparation from an export**, select the JSON file. Selection reads it in your browser only; nothing is uploaded automatically.
4. Read the destination/storage disclosure, check the authorization box, then choose **Validate file in my workspace**. This uploads the complete selected export to that workspace service for validation. The application stores no preparation during preview; normal hosting request metadata can still be processed under its privacy policy.
5. Review the counts, storage size, evidence requiring confirmation, and sections that will not be restored. Only then choose **Import reviewed preparation** and confirm. If you select a different file, validate again. The server checks that the confirmed snapshot matches the preview digest.
6. Review your profile evidence on the destination website. Ask your assistant to reassess jobs and recheck/save materials before you approve any destination-specific use. Connecting an assistant and setting up a schedule are separate permissions, not import side effects.

The same website flow works on a self-hosted deployment. Imports require the candidate's browser session and same-origin action. MCP tokens cannot import, even with write access, and there is no MCP import tool.

## Candidate-run local destination

Node 24+ and an installed clone are required. Use a private directory outside the public repository. Run these commands yourself, or explicitly authorize the exact file and local destination if asking an agent to assist. The importer is a separate candidate CLI, never an assistant's MCP tool or a way to bypass hosted review controls.

```sh
node --import tsx src/import-local.ts \
  --workspace /absolute/path/to/private-local-workspace \
  --file /absolute/path/to/private-export.json
```

This initializes local workspace metadata if necessary and prints a validation summary/digest, but stores no preparation records. It does not send data to a network service. Review the summary and the exclusions above, then rerun with the **exact digest printed for that file**:

```sh
node --import tsx src/import-local.ts \
  --workspace /absolute/path/to/private-local-workspace \
  --file /absolute/path/to/private-export.json \
  --confirm-digest DIGEST_FROM_YOUR_PREVIEW
```

Do not use the literal placeholder digest. A changed file, incorrect digest or nonempty destination is rejected without merging. The same local stdio MCP server can then read the imported records. Local filesystem/process access is the trust boundary; no local browser review UI is bundled, and a local import does not create candidate approval/submission tools.

## Validation and limits

- Only `format: "job-search-workspace"`, `version: 1` snapshots with 1–250 supported current records are accepted. Maximum uploaded/read file: 4 MiB; imported content: 2 MiB total, 64 KiB per record.
- Duplicate IDs, duplicate normalized job/run fingerprints, multiple profiles, unsupported fields/formats, unsafe source URLs, invalid job links, missing evidence references and assessment quotes absent from their posting are rejected. URLs are stored, not fetched.
- An export may legitimately contain old material that cites evidence you later removed. That snapshot needs review before import. Keep the original, make a private working copy, and correct or omit stale preparation records; do not invent evidence to satisfy validation. The importer does not silently discard individual records.
- All preparation inserts are a single atomic database statement. Concurrent writes/imports cannot convert the empty-workspace requirement into a merge, and a database failure cannot leave half the snapshot imported. JSON parameters are chunked below D1's [string-size limit](https://developers.cloudflare.com/d1/platform/limits/), without splitting the transaction.
- Revisions reset on import; original history and activity do not populate the destination. Existing deletion and export controls apply to the imported records just as to newly prepared ones.
- No AI provider, SurrealSites account, server-side model or paid data-migration service is required by the importer.
