import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("job_search", ROOT / "scripts" / "job_search.py")
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name) / "private"
        self.assertEqual(self.run_cli("init")[0], 0)

    def run_cli(self, command, *arguments):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli.main([command, "--workspace", str(self.workspace), *arguments])
        return code, out.getvalue().strip(), err.getvalue().strip()

    def capture(self, **overrides):
        values = {
            "posting": str(ROOT / "examples" / "job-posting.txt"),
            "company": "Example Cooperative", "role": "Operations Analyst",
            "url": "https://example.com/careers/operations-analyst",
        }
        values.update(overrides)
        arguments = []
        for key, value in values.items():
            if value is not None:
                arguments.extend([f"--{key}", value])
        return self.run_cli("capture", *arguments)

    def test_init_templates_and_ignore(self):
        self.assertTrue((self.workspace / "resume.md").is_file())
        self.assertEqual((self.workspace / ".gitignore").read_text(), "*\n!.gitignore\n")
        self.assertEqual(self.run_cli("init")[0], 1)

    def test_git_ignores_private_artifacts(self):
        subprocess.run(["git", "init", "-q", str(self.workspace)], check=True)
        result = subprocess.run(
            ["git", "-C", str(self.workspace), "status", "--porcelain", "--untracked-files=all"],
            check=True, capture_output=True, text=True,
        )
        self.assertEqual(result.stdout.strip(), "?? .gitignore")

    def test_reject_repository_workspace(self):
        with self.assertRaises(ValueError):
            cli.workspace_path(ROOT / "private-test")

    def test_capture_preserves_source_and_deduplicates(self):
        code, job_id, _ = self.capture()
        self.assertEqual(code, 0)
        directory = self.workspace / "applications" / job_id
        self.assertEqual((directory / "job_posting.txt").read_text(), (ROOT / "examples" / "job-posting.txt").read_text())
        self.assertEqual(self.capture()[0], 1)
        self.assertIn(job_id, self.run_cli("list")[1])
        self.assertEqual(json.loads((directory / "application.json").read_text())["status"], "discovered")

    def test_status_requires_submission_confirmation_and_keeps_history(self):
        _, job_id, _ = self.capture()
        self.assertEqual(self.run_cli("status", job_id, "applied")[0], 1)
        self.assertEqual(self.run_cli("status", job_id, "ready")[0], 0)
        self.assertEqual(self.run_cli("status", job_id, "applied", "--confirm-submitted")[0], 0)
        self.run_cli("status", job_id, "applied", "--confirm-submitted")
        data = json.loads((self.workspace / "applications" / job_id / "application.json").read_text())
        self.assertEqual([event["status"] for event in data["history"]], ["discovered", "ready", "applied"])

    def test_browser_task_contains_no_resume_and_will_not_overwrite(self):
        (self.workspace / "resume.md").write_text("PRIVATE RESUME SENTINEL")
        _, job_id, _ = self.capture()
        code, path, _ = self.run_cli("browser-task", job_id)
        self.assertEqual(code, 0)
        brief = Path(path).read_text()
        self.assertIn("Read-only", brief)
        self.assertIn("Never bypass", brief)
        self.assertNotIn("PRIVATE RESUME SENTINEL", brief)
        self.assertEqual(self.run_cli("browser-task", job_id)[0], 1)

    def test_no_source_url_cannot_generate_browser_task(self):
        _, job_id, _ = self.capture(url=None)
        self.assertEqual(self.run_cli("browser-task", job_id)[0], 1)

    def test_reject_unsafe_urls(self):
        for url in ("file:///etc/passwd", "javascript:alert(1)", "http://localhost/jobs",
                    "http://127.0.0.1/jobs", "http://192.168.1.1/jobs", "http://[::1]/jobs",
                    "https://user:password@example.com/jobs", "https://example.com:99999/jobs",
                    "https://example.com/\njobs"):
            with self.subTest(url=url):
                self.assertEqual(self.capture(url=url)[0], 1)

    def test_reject_empty_posting_and_company(self):
        posting = Path(self.temp.name) / "empty.txt"
        posting.write_text(" ")
        self.assertEqual(self.capture(posting=str(posting))[0], 1)
        self.assertEqual(self.capture(company=" ")[0], 1)

    def test_reject_traversal(self):
        self.assertEqual(self.run_cli("status", "../outside", "ready")[0], 1)

    def test_reject_symlink_escape(self):
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        (self.workspace / "applications" / "escape").symlink_to(outside, target_is_directory=True)
        self.assertEqual(self.run_cli("status", "escape", "ready")[0], 1)

    def test_reject_symlinked_record(self):
        _, job_id, _ = self.capture()
        record = self.workspace / "applications" / job_id / "application.json"
        outside = Path(self.temp.name) / "record.json"
        record.rename(outside)
        record.symlink_to(outside)
        self.assertEqual(self.run_cli("status", job_id, "ready")[0], 1)

    def test_malformed_record_is_reported(self):
        _, job_id, _ = self.capture()
        (self.workspace / "applications" / job_id / "application.json").write_text("[]")
        code, _, error = self.run_cli("list")
        self.assertEqual(code, 1)
        self.assertIn("Invalid record", error)

    def test_uninitialized_workspace_is_rejected(self):
        (self.workspace / ".job-search-workspace").unlink()
        self.assertEqual(self.run_cli("list")[0], 1)


class SkillTests(unittest.TestCase):
    def test_skill_metadata_and_safety(self):
        skills = list((ROOT / "skills").glob("*/SKILL.md"))
        self.assertEqual(len(skills), 7)
        for path in skills:
            with self.subTest(skill=path.parent.name):
                text = path.read_text()
                self.assertTrue(text.startswith("---\n"))
                self.assertIn(f"name: {path.parent.name}\n", text)
                self.assertIn("description:", text)
                self.assertIn("## Inputs", text)
                self.assertIn("## Output", text)
                self.assertIn("## Safety", text)
                self.assertIn("AGENTS.md", text)


if __name__ == "__main__":
    unittest.main()
