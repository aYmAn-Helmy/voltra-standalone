import importlib.util
from pathlib import Path
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1] / "scripts/brand_powera.py"
spec = importlib.util.spec_from_file_location("brand_powera", SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BrandingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.android = Path(self.temp.name)
        for rel, old, _ in module.REPLACEMENTS:
            target = self.android / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(old + "\n", encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def test_branding_and_repeat_application(self):
        self.assertEqual(len(module.apply_branding(self.android)), 4)
        self.assertEqual(module.apply_branding(self.android), [])
        self.assertEqual(module.apply_branding(self.android, check=True), [])
        for rel, old, new in module.REPLACEMENTS:
            content = (self.android / rel).read_text(encoding="utf-8")
            self.assertIn(new, content)
            self.assertNotIn(old, content)

    def test_preflight_prevents_partial_changes(self):
        bad = self.android / module.REPLACEMENTS[-1][0]
        bad.write_text("unexpected format\n", encoding="utf-8")
        with self.assertRaises(RuntimeError):
            module.apply_branding(self.android)
        good = self.android / module.REPLACEMENTS[0][0]
        self.assertIn(module.REPLACEMENTS[0][1], good.read_text(encoding="utf-8"))

    def test_check_fails_until_branded(self):
        with self.assertRaises(RuntimeError):
            module.apply_branding(self.android, check=True)


if __name__ == "__main__":
    unittest.main()
