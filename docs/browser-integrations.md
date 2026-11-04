# Optional browser integrations

Reviewed against upstream READMEs on 2026-11-04. APIs and setup may change; follow upstream documentation. This toolkit ships **task briefs and skills**, not an installed browser runtime or a technically enforced action firewall.

## Recommended paths

### Alibaba Page Agent: in-page assistance

- Repository: https://github.com/alibaba/page-agent
- Docs: https://alibaba.github.io/page-agent/docs/introduction/overview
- License: MIT.
- Best suited to natural-language assistance inside a page you control. Upstream also provides an optional Chrome extension for multi-page tasks and a beta MCP server.
- Follow upstream installation for the library, extension, or MCP route. Connect it to your chosen model, then make `skills/browser-assistance/SKILL.md` available to the supervising assistant.
- Use the toolkit's `browser-task` output for **read-only research**, not a general “apply for me” task. Configure tool-level action restrictions where available; instructions alone do not enforce safety.
- Do not inject scripts into third-party sites without authorization or violate their terms. For arbitrary job portals, prefer the supported extension route or a browser tool already available to your assistant.
- Do not use the public demo LLM with real candidate data. Upstream marks its demo for technical evaluation, with separate service terms. In-page API keys are visible to the page environment: never embed a long-lived secret in a public app. Use an appropriately secured provider setup.

### Browser Use: multi-page research

- Repository: https://github.com/browser-use/browser-use
- Docs: https://docs.browser-use.com
- Related CLI: https://github.com/browser-use/browser-harness
- Open-source library license: MIT; hosted services and model inference have separate costs and terms.
- Best suited to browser research across job pages and employer sites, or connecting browser tools to an existing assistant.
- Install upstream's CLI/skill for your client, or use the Python library following its current quickstart. No Browser Use package is required by this toolkit's CLI.
- Supply `skills/browser-assistance/SKILL.md` plus a generated read-only task. Use a dedicated browser profile with minimum privileges, not an unrestricted personal browser session.
- Disable/avoid CAPTCHA bypass, stealth, and evasion capabilities. Stop at challenges and ask the user to act.
- Review whether your configuration sends DOM text, screenshots, cookies, logs, or recordings to an external model or hosted browser. Obtain informed permission before any private-data transfer.

### An existing browser tool

You can use an assistant's existing browser tool instead. The requirements are the same: scoped destinations, untrusted-page handling, verified observations, permission before disclosures, and user-controlled final submission. No vendor-specific dependency is required.

## Concrete handoff

1. Capture a posting with `scripts/job_search.py capture` and a source URL.
2. Run `python3 scripts/job_search.py browser-task --workspace /private/workspace JOB_ID`.
3. Review `applications/JOB_ID/browser_task.md`, especially the destination.
4. Ask your configured browser assistant to read the browser-assistance skill and execute the read-only brief under the approved domain scope.
5. Save the sourced result to private notes. Use job-fit before deciding to pursue it.

The CLI does not fetch URLs, resolve domains, or launch these projects. Its URL checks reject obvious dangerous schemes, embedded credentials, and private IPs; they do not prevent DNS rebinding, private DNS targets, or malicious redirects. Verify destinations and enforce network/action restrictions at the browser layer. An unconstrained agent must not receive candidate data for form filling.

## Form-filling boundary

Before any field entry, show the candidate the exact destination, fields, and approved document versions. Explain that autosave can transmit data before submission. If reliable action restrictions cannot keep the browser from submitting or accepting consent, use manual filling instead.

The user always handles login, sensitive questions, attestations, consent, and final Submit/Send. Neither a generated task brief nor `--confirm-submitted` authorizes a browser to perform those actions.
