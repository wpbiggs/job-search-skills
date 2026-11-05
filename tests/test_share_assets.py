import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("share_assets", ROOT / "scripts" / "build_share_assets.py")
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)


class ShareAssetsTests(unittest.TestCase):
    def test_bundle_contains_only_allowlisted_public_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = assets.build(temporary)
            with zipfile.ZipFile(output / "job-search-skills.zip") as archive:
                self.assertEqual(set(archive.namelist()), {f"job-search-skills/{name}" for name in assets.FILES})
                for name in archive.namelist():
                    self.assertNotIn("..", Path(name).parts)
                    self.assertNotIn("applications/", name)
                    self.assertEqual(archive.read(name), (ROOT / name.removeprefix("job-search-skills/")).read_bytes())

    def test_guide_is_standalone_and_archive_is_reproducible(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = assets.build(temporary)
            guide = (output / "guide.md").read_text()
            for skill in assets.SKILLS:
                self.assertIn(f"name: {skill}\n", guide)
            self.assertIn("Conversation only", guide)
            self.assertIn("cannot open", guide)
            first = (output / "job-search-skills.zip").read_bytes()
            assets.build(temporary)
            self.assertEqual(first, (output / "job-search-skills.zip").read_bytes())
