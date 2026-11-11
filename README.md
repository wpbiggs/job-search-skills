# Job Search Skills

An open, candidate-first toolkit for finding and pursuing work that fits you—not a mass-application bot.

Use reusable agent skills with your preferred AI assistant and optional browser tools. Keep your experience, preferences, resumes, and application history in a **private local workspace**.

**No-code start:** visit [Job Search Skills](https://william.biggers.family/job-search) to copy a starter prompt or download the instructions. You can also read [START_HERE.md](START_HERE.md) directly. An assistant without browsing or file access can work from pasted postings and return drafts in chat—no terminal required.

## What works today

- An optional [private website workspace](https://william.biggers.family/job-search/workspace), with passkey sign-in, recovery, candidate-only reviews, outcomes, export, and deletion.
- An authenticated [remote MCP endpoint](docs/MCP.md) for the AI assistant you choose, plus a local SQLite/stdio mode. No model keys, hosted inference, or SurrealSites dependency.
- Candidate-reviewed [preparation portability](docs/PORTABILITY.md) between empty hosted/self-hosted and local destinations, without restoring old authority or credentials.
- [Reviewed manual handoffs](docs/REVIEWED_SUBMISSION_DEPLOYMENT.md): exact saved-document review, 15-minute one-use opening approval, stale-record protection, and candidate-reported receipts. You operate the employer site and perform final submission; these handoffs do not authorize an automated browser.
- [Constrained browser pilot infrastructure](docs/EXECUTOR_PILOT.md): separate private Browser Run service, explicit read-only employer-form inspection, fictional ATS verification, one-use attempt storage and pause/cancel controls. This is **not a live auto-apply feature**: employer adapters, interactive handoff and the five-application pilot remain gated; final employer submission stays candidate-operated.

- Seven portable `SKILL.md` workflows for profiling, discovery, fit assessment, truthful application materials, browser assistance, tracking, and interviews.
- A dependency-free Python CLI to create a private workspace, capture postings, track statuses, and prepare browser task briefs.
- Integration guides for [Alibaba Page Agent](https://github.com/alibaba/page-agent) and [Browser Use](https://github.com/browser-use/browser-use).
- Fictional examples, human approval checkpoints, and automated tests.

**Scope:** the server stores records and supplies tools; the skills are instructions executed by your agent, not a bundled AI service. Neither the CLI nor MCP server searches the web, calls an LLM, calculates hiring odds, drives a browser, or submits applications. Browser integrations require separate configuration. Your chosen assistant supplies research and any harness-supported scheduling and may incur costs or process data externally. See [connection instructions](docs/MCP.md) and [hosted privacy/self-hosting](docs/HOSTED_WORKSPACE.md).

## Quick start

Requirements: Python 3.10+, Git, and an AI assistant that can read files. Browser access is optional.

```sh
git clone https://github.com/wpbiggs/job-search-skills.git
cd job-search-skills
python3 scripts/job_search.py init --workspace ../my-private-job-search
```

Edit `../my-private-job-search/profile.md` and `resume.md` with your actual background and preferences. Do not put personal data in this public repository. Workspace initialization creates its own `.gitignore` that excludes everything except that ignore file; it does not encrypt your data.

Give your assistant this prompt, substituting the actual paths:

```text
Read job-search-skills/AGENTS.md and skills/career-profile/SKILL.md.
My private workspace is my-private-job-search. Help me identify suitable jobs.
Start by reviewing my preferences and evidence; ask about missing constraints.
Do not submit applications, contact anyone, or publish my data.
```

### Install the skills

For clients supported by the [Skills CLI](https://github.com/vercel-labs/skills):

```sh
npx skills add wpbiggs/job-search-skills
```

Alternatively, copy the desired `skills/<name>/` directories into your client's documented skills directory. For clients without skill discovery, ask the agent to read `AGENTS.md` and the relevant `SKILL.md` files directly. Review third-party installers before running them. When installing skills without the repository, also make the root `AGENTS.md` available as context; each skill includes the essential safety rules independently.

### Capture and track a job

```sh
python3 scripts/job_search.py capture --workspace ../my-private-job-search \
  --posting examples/job-posting.txt --company 'Example Cooperative' \
  --role 'Operations Analyst' --url https://example.com/careers/operations-analyst
python3 scripts/job_search.py list --workspace ../my-private-job-search
# Replace JOB_ID with the ID printed by capture:
python3 scripts/job_search.py status --workspace ../my-private-job-search JOB_ID shortlisted
python3 scripts/job_search.py browser-task --workspace ../my-private-job-search JOB_ID
```

The last command writes a **read-only research brief** in the job folder. Give that brief to your configured browser agent. It contains the source URL and safety instructions, not your resume. Inspect it before use. Running the command never launches a browser.

## Workflow

1. **Career profile:** goals, constraints, strengths, and evidence of experience.
2. **Job discovery:** source real postings, verify freshness, deduplicate, and flag scams.
3. **Job fit:** evaluate must-haves, preferences, evidence, gaps, and unknowns.
4. **Application materials:** draft a truthful resume and optional cover letter for user review.
5. **Browser assistance:** research first; only fill forms with explicit permission. The user performs final submission.
6. **Application tracking:** record only observed events and plan follow-ups.
7. **Interview preparation:** practice evidence-backed stories and evaluate the employer, too.

Read [AGENTS.md](AGENTS.md) for orchestration, [browser integrations](docs/browser-integrations.md) for tool choices, and [privacy and safety](docs/privacy-and-safety.md) before using personal data.

## Contribute

```sh
python3 -m unittest discover -s tests -v
```

For the optional TypeScript service: `npm ci`, `npx wrangler types`, `npm run typecheck`, `npm test`, and `npm run build`. The [hosted guide](docs/HOSTED_WORKSPACE.md) covers isolated local browser/protocol tests and deployment.

See [CONTRIBUTING.md](CONTRIBUTING.md). Do not include real resumes, postings containing personal data, cookies, or application histories in issues or pull requests. This is an early toolkit, not a guarantee of interviews or employment.

### Public download assets

`python3 scripts/build_share_assets.py --output /path/to/public/job-search` builds a standalone `guide.md` and a skills ZIP from an explicit public-file allowlist. It never walks a candidate workspace. Rebuild and deploy these assets when the source instructions change. The portfolio landing page is maintained separately in its existing site source.

## License and origins

MIT licensed. Inspired by a private personal job-search workflow; no personal files or Git history are included. Page Agent and Browser Use are independent MIT-licensed projects, not dependencies bundled here. Their services have separate terms and privacy policies. No affiliation or endorsement is implied.
