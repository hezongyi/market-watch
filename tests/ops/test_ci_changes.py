"""Exercise CI decisions against real Git histories, not filename mocks."""

import importlib.util
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("ci_changes", ROOT / ".github/scripts/ci_changes.py")
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)

PROJECT = '[project]\nname = "market-watch"\nversion = "1.25.8"\ndependencies = ["fastapi"]\n'


class ChangeClassificationTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.repo = Path(temp.name)
        self.git("init", "-q")
        self.git("config", "user.name", "CI tests")
        self.git("config", "user.email", "ci@example.invalid")
        self.base = self.commit({
            "pyproject.toml": PROJECT,
            "backend/app.py": "value = 1\n",
            "README.md": "# App\n",
        })

    def git(self, *args):
        return subprocess.run(
            ["git", *args], cwd=self.repo, check=True, capture_output=True, text=True
        ).stdout.strip()

    def commit(self, files):
        for name, value in files.items():
            path = self.repo / name
            if value is None:
                path.unlink()
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(value)
        self.git("add", "-A")
        self.git("commit", "-qm", "change inputs")
        return self.git("rev-parse", "HEAD")

    def classify(self, head, base=None, event="pull_request"):
        return ci.classify(self.repo, base or self.base, head, event)

    def test_documentation_and_screenshots_skip_heavy_jobs(self):
        head = self.commit({
            "README.md": "# Updated\n",
            "docs/guide.md": "Guide\n",
            "docs/verification/shot.png": "image fixture",
            "deploy/README.md": "Deployment notes\n",
            ".github/ISSUE_TEMPLATE/task.md": "Issue notes\n",
        })
        self.assertEqual(self.classify(head), {"docs_only": True, "backend_changed": False})

    def test_documentation_mixed_with_code_runs_checks(self):
        head = self.commit({"README.md": "New docs\n", "backend/app.py": "value = 2\n"})
        self.assertEqual(self.classify(head), {"docs_only": False, "backend_changed": True})

    def test_scripts_and_json_below_docs_are_not_automatically_documentation(self):
        for path in ["docs/check.py", "docs/setup.sh", "docs/input.json", "web/page.mdx"]:
            with self.subTest(path=path):
                base = self.git("rev-parse", "HEAD")
                head = self.commit({path: "new content"})
                self.assertFalse(self.classify(head, base=base)["docs_only"])

    def test_version_packaging_does_not_run_full_backend(self):
        head = self.commit({
            "pyproject.toml": PROJECT.replace('"1.25.8"', '"1.25.9"'),
            "web/package.json": '{"version":"1.25.9"}',
            "web/package-lock.json": '{"version":"1.25.9"}',
            "CHANGELOG.md": "New version\n",
        })
        self.assertEqual(self.classify(head), {"docs_only": False, "backend_changed": False})

    def test_version_bump_with_dependency_or_configuration_change_runs_backend(self):
        for content in [
            PROJECT.replace('"fastapi"', '"fastapi", "sqlalchemy"'),
            PROJECT + '\n[tool.pytest.ini_options]\naddopts = "-x"\n',
        ]:
            with self.subTest(content=content):
                head = self.commit({"pyproject.toml": content.replace('"1.25.8"', '"1.25.9"')})
                self.assertTrue(self.classify(head)["backend_changed"])

    def test_missing_and_invalid_project_data_run_backend(self):
        for content in ['invalid [ toml', '[project]\nname = "app"\n', 'project = "app"', None]:
            with self.subTest(content=content):
                head = self.commit({"pyproject.toml": content})
                self.assertTrue(self.classify(head)["backend_changed"])

    def test_runtime_renamed_to_markdown_still_runs_backend(self):
        head = self.commit({"backend/app.py": None, "docs/app.md": "value = 1\n"})
        self.assertEqual(self.classify(head), {"docs_only": False, "backend_changed": True})

    def test_initial_push_checks_all_inputs(self):
        self.assertEqual(
            self.classify(self.base, base="0" * 40, event="push"),
            {"docs_only": False, "backend_changed": True},
        )

    def test_pull_request_uses_merge_base_but_push_includes_all_changes(self):
        feature = self.commit({"pyproject.toml": PROJECT.replace('"1.25.8"', '"1.25.9"')})
        self.git("checkout", "-qb", "other", self.base)
        base = self.commit({"backend/new.py": "another task\n"})
        self.assertFalse(self.classify(feature, base=base)["backend_changed"])
        self.assertTrue(self.classify(feature, base=base, event="push")["backend_changed"])

    def test_empty_diff_is_not_a_documentation_shortcut(self):
        self.assertFalse(self.classify(self.base)["docs_only"])

    def test_bad_revision_fails_instead_of_skipping(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.classify("missing-revision")


class RequiredCheckTests(unittest.TestCase):
    def report(self, classification, docs_only, result):
        env = dict(os.environ, CLASSIFICATION_RESULT=classification,
                   DOCS_ONLY=docs_only, CHECK_RESULT=result)
        return subprocess.run(
            ["bash", str(ROOT / ".github/scripts/ci_required.sh")],
            env=env, capture_output=True, text=True,
        ).returncode

    def test_documentation_shortcut_and_successful_checks_pass(self):
        self.assertEqual(self.report("success", "true", "skipped"), 0)
        self.assertEqual(self.report("success", "false", "success"), 0)

    def test_failure_cancellation_or_missing_classification_cannot_pass(self):
        for status in ["failure", "cancelled", "skipped", ""]:
            with self.subTest(status=status):
                self.assertNotEqual(self.report(status, "true", "skipped"), 0)
        self.assertNotEqual(self.report("success", "", "skipped"), 0)

    def test_failed_or_unexpectedly_skipped_jobs_cannot_pass(self):
        for result in ["failure", "cancelled", "skipped", ""]:
            with self.subTest(result=result):
                self.assertNotEqual(self.report("success", "false", result), 0)


if __name__ == "__main__":
    unittest.main()
