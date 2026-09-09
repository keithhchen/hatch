"""Error-contract unit tests; no product/UAT claims from mocked conversions."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SKILLS = Path(__file__).resolve().parents[1] / "skills"
sys.path.insert(0, str(SKILLS))
from _shared.libreoffice import run_libreoffice

spec = importlib.util.spec_from_file_location(
    "render_docx", SKILLS / "documents/scripts/render_docx.py"
)
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)


class RenderFailures(unittest.TestCase):
    def test_subprocess_uses_private_profile_without_changing_parent(self):
        before = Path.cwd()
        environment = dict(os.environ, OSL_SOCKET_PATH="do-not-reuse")
        with tempfile.TemporaryDirectory() as directory:
            profile = Path(directory).resolve()
            result = run_libreoffice(
                [sys.executable, "-c", "import os,json; print(json.dumps([os.getcwd(),os.environ.get('OSL_SOCKET_PATH')]))"],
                profile=profile, environment=environment,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            cwd, socket = json.loads(result.stdout)
            self.assertEqual(Path(cwd), profile)
            if os.name != "nt":
                self.assertEqual(socket, ".")
        self.assertEqual(Path.cwd(), before)
        self.assertEqual(environment["OSL_SOCKET_PATH"], "do-not-reuse")

    def test_silent_failure_keeps_exit_code(self):
        with tempfile.TemporaryDirectory() as directory:
            result = run_libreoffice(
                [sys.executable, "-c", "raise SystemExit(17)"],
                profile=Path(directory), environment=os.environ,
            )
        self.assertEqual(result.returncode, 17)
        self.assertIn("code 17", result.stderr)

    def test_missing_poppler_is_error_before_conversion(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "probe.docx"
            source.touch()
            with patch.object(sys, "argv", ["render", str(source), "--output-dir", directory]), \
                 patch.dict(os.environ, {"HATCH_SOFFICE": sys.executable,
                                         "HATCH_PDFTOPPM": str(Path(directory) / "missing")}), \
                 patch.object(renderer, "run_libreoffice") as convert:
                with self.assertRaises(SystemExit) as failure:
                    renderer.main()
                self.assertEqual(failure.exception.code, 2)
                convert.assert_not_called()


if __name__ == "__main__":
    unittest.main()
