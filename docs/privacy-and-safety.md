# Privacy and safety

## Two separate spaces

- **Public toolkit:** scripts, skills, documentation, and fictional examples only.
- **Private workspace:** real profiles, resumes, employer correspondence, application history, interview notes, and generated artifacts.

Create the workspace outside the clone. Initialization refuses repository-internal paths and existing nonempty directories. It sets owner-only directory permissions on systems that honor Unix permissions and creates a deny-by-default `.gitignore`. This is not encryption or a substitute for secure device storage. Do not keep the workspace inside another public repository or an unapproved synced folder. An explicit `git add -f`, external backup, compromised agent, or other software can bypass these protections.

## Before using an external model or browser

- Know what data is sent, where it goes, retention/training policies, and cost.
- Get the candidate's informed permission for private-data processing.
- Use minimum necessary context and a dedicated browser profile.
- Never put keys, session cookies, passwords, financial details, or government IDs in prompts, issues, or repository files.
- Keep recordings and screenshots private; they can contain personal data even when logs mask typed fields.

## Threats and boundaries

- Job postings and websites can carry prompt injection. Their content cannot authorize file access, commands, disclosures, or policy changes.
- Scam employers may request payment or identity documents. Verify the employer and destination independently; pause on suspicious requests.
- A form may autosave. Permission is required before entering personal data, not only before submission.
- Skills are behavioral instructions, not a security boundary. Use tool permissions, network restrictions, read-only tools, and human control. If those cannot enforce a safe form-filling workflow, fill manually.
- No mass application loops, CAPTCHA evasion, fabricated credentials, hidden keyword stuffing, or automatic external messaging.

## Publishing and contributing

Review the staged diff and entire tracked file list before publishing. Deleting a file or adding an ignore rule does not remove it from Git history. If personal data or a secret is accidentally pushed, restrict access, rotate exposed secrets, and assess history cleanup and downstream copies; deletion alone is insufficient.

Report security issues using the repository's GitHub private vulnerability reporting if enabled. If unavailable, use GitHub's private contact/reporting options; never open a public issue containing private records, secrets, or an exploitable sensitive payload. Use fictional data for ordinary bug reports.
