#!/usr/bin/env python3
"""Build public downloads from an explicit allowlist, never a workspace tree."""

import argparse
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SKILLS = (
    "career-profile", "job-discovery", "job-fit", "application-materials",
    "browser-assistance", "application-tracking", "interview-prep",
)
FILES = (
    "START_HERE.md", "AGENTS.md", "LICENSE", "templates/profile.md",
    "templates/resume.md", "docs/browser-integrations.md",
    "docs/privacy-and-safety.md", "docs/MCP.md", "docs/HOSTED_WORKSPACE.md",
) + tuple(f"skills/{name}/SKILL.md" for name in SKILLS)


def build(output):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    sections = [(ROOT / "START_HERE.md").read_text(encoding="utf-8")]
    for name in ("AGENTS.md", *(f"skills/{skill}/SKILL.md" for skill in SKILLS),
                 "templates/profile.md", "templates/resume.md", "docs/browser-integrations.md",
                 "docs/privacy-and-safety.md", "docs/MCP.md", "docs/HOSTED_WORKSPACE.md"):
        sections.append(f"\n---\n\n## Reference: {name}\n\n" + (ROOT / name).read_text(encoding="utf-8"))
    (output / "guide.md").write_text("\n".join(sections), encoding="utf-8")
    with zipfile.ZipFile(output / "job-search-skills.zip", "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in FILES:
            # Fixed timestamps make identical source produce identical archives.
            info = zipfile.ZipInfo(f"job-search-skills/{name}", date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, (ROOT / name).read_bytes())
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(build(args.output))
