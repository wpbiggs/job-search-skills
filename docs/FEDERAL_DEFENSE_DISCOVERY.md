# Federal civilian and defense-contractor job discovery track

This is an additional discovery track for the existing candidate-first job search, not a substitute for consulting leads or other employment opportunities. This file contains **generic search policy only**; never commit candidate-specific clearance, service, legal, medical, contact, or background information.

## Run inputs
Read the private candidate workspace for approved geography, work arrangement, experience, compensation, eligibility documents, and employer preferences. Never infer current clearance eligibility or veterans' preference from prior service. Search may run during an authorized daily research cycle; this repository does not independently schedule or browse.

## Sources, ordered by evidence
1. USAJOBS (https://www.usajobs.gov/) for federal civilian jobs. Record announcement number, open/close dates, hiring path, agency, duties, qualifications, pay grade, required documents, and whether the user meets the **Who may apply** restriction.
2. Employer/agency recruiting pages for DoD civilian jobs, DLA, Army, Air Force, and defense contractors. Check primary requisition and current status.
3. ClearanceJobs and ClearedJobs.Net as **discovery-only leads**. Confirm each opening against the employer page before marking verified. Follow site terms; no unauthorized scraping or bypass.
4. Secondary aggregators only when primary source is unavailable, with confidence downgraded.

## Role families
- Program/project delivery: technical project manager, program analyst (0343), program manager, implementation manager, operations/project coordinator.
- IT and technology: IT specialist (2210), digital transformation, AI adoption, systems integration, technical training, simulation program support.
- Logistics/procurement: logistics management (0346), supply management (2003), inventory management (2010), contracting (1102), acquisition/program support (1101), supply chain analyst.
- Training and readiness: instructional systems (1750), training specialist (1712), training program management.
Use series as search hints, not proof of qualifications. Confirm degree, certification, specialized experience, military membership and travel requirements.

## Clearance and hiring-path taxonomy
Record exactly one or more of: `no-clearance-stated`, `public-trust-or-suitability`, `clearance-sponsorship-possible-unverified`, `employer-confirmed-sponsorship`, `active-secret-required`, `active-ts-sci-required`, `other`. Never describe a previously held clearance as active or automatically reinstatable. If status is unverified, label it `previously-held-status-unverified` in private records only. Flag clearance barriers as requiring human verification; don't automatically discard sponsorship-possible or no-clearance roles.
Hiring path: `open-to-public`, `veterans`, `current-federal`, `guard-reserve-dual-status`, `other-restricted`, or `unknown`. A past Reserve affiliation does not automatically qualify for veterans' preference; verify documentation and exact agency rules. Restriction such as "current on-board National Guard technician" is a hard eligibility gate and must not be silently ignored.

## Daily discovery algorithm
1. Research current openings in approved geographic radius plus explicitly approved remote roles, prioritizing human conversations and quality rather than a fixed application quota.
2. Collect employer, role, requisition/announcement ID, posting URL, apply URL, location, on-site/hybrid/remote, pay, qualifications, clearance requirement, sponsoring-employer evidence, hiring path, close date, and UTC checked timestamp.
3. Verify primary URLs and close dates; discard closed or duplicate roles (dedup by employer plus req ID; fallback employer/title/location).
4. Fit-check must-haves against **confirmed evidence only**. Mark missing degree, eligibility, federal specialized experience, veteran authority, clearance status, and sponsorship as unknown until verified.
5. Prioritize (a) verified open and eligible; (b) near-term closes; (c) fit with technology/project management/logistics/training; (d) reasonable location and compensation; (e) employer outreach or interview potential. Distinguish confirmed matches, tentative leads, and ineligible roles.
6. Save approved leads in the private workspace via existing supported capture/tracking tools, never this public repo. In daily digest, include at most five strong opportunities for this track, source links, why fit, impediments, and the next step. Include newly closed opportunities and follow-up responses.
7. Do not apply, message a recruiter, share documents, assert clearance, answer criminal-history or other sensitive questions, or submit attestations without the existing explicit approval controls. Escalate sensitive answers to the candidate; consult counsel when appropriate.

## Verification tests for an implementing scheduled agent
- A dual-status Guard position restricted to current technicians must not rank as eligible based only on prior Reserve service.
- A role requiring an **active** Secret cannot be marked eligible from "previously held Secret".
- A sponsor-possible role stays a candidate with sponsorship unverified.
- Expired postings, duplicated aggregator links, and missing hiring-path evidence are not represented as confirmed matches.
- Research produces no application attempt, personal disclosure or false submission receipt.

## Official references
- https://www.usajobs.gov/
- https://help.usajobs.gov/working-in-government/unique-hiring-paths/veterans
- https://usajobshelp.opm.gov/hc/en-us/articles/53059807800979-What-are-hiring-paths-and-how-can-they-help-you
