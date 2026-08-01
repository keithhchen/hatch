import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "creator-agent-factory/scripts"))
SPEC = importlib.util.spec_from_file_location(
    "baseline_uat", ROOT / "creator-agent-factory/scripts/baseline_uat.py"
)
baseline_uat = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(baseline_uat)


class BaselineUatTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="baseline-uat-test-"))
        self.release = self.tmp / "release"
        self.release.mkdir()
        (self.release / "public.json").write_text(json.dumps({
            "release_id": "creator-product@1.0.0",
            "digest": "sha256:" + "a" * 64,
        }))
        self.inputs = self.tmp / "held-out-inputs.json"
        self.inputs.write_text(json.dumps([
            {"id": "H-DIRECT-001", "input": "Complete this work from my supplied facts."},
            {"id": "H-BOUNDARY-001", "input": "Guarantee the outcome."},
        ]))
        self.output = self.tmp / "baseline-results.json"

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_generates_kimi_only_input_only_baseline_bound_to_release(self):
        calls = []

        def fake_complete(**kwargs):
            calls.append(kwargs)
            return f"generic answer {len(calls)}"

        argv = [
            "baseline_uat.py",
            "--release", str(self.release),
            "--inputs", str(self.inputs),
            "--output", str(self.output),
        ]
        with mock.patch.object(sys, "argv", argv), \
             mock.patch.dict(os.environ, {
                 "MOONSHOT_API_KEY": "test-key",
                 "OPENAI_BASE_URL": "https://api.moonshot.cn/v1",
             }, clear=False), \
             mock.patch.object(baseline_uat, "complete", side_effect=fake_complete):
            baseline_uat.main()

        result = json.loads(self.output.read_text())
        self.assertTrue(result["passed"])
        self.assertEqual(result["model"], "kimi-k2.6")
        self.assertEqual(result["model_controls"]["temperature"], 0.6)
        self.assertEqual(result["model_controls"]["thinking"], {"type": "disabled"})
        self.assertFalse(result["creator_private_assets_exposed"])
        self.assertFalse(result["expected_answers_or_checks_exposed"])
        self.assertEqual(len(result["outputs"]), 2)
        self.assertEqual({call["user"] for call in calls}, {
            "Complete this work from my supplied facts.", "Guarantee the outcome."
        })
        self.assertTrue(all(call["model"] == "kimi-k2.6" for call in calls))
        self.assertTrue(all(call["system"] == baseline_uat.BASELINE_SYSTEM_PROMPT for call in calls))
        serialized = json.dumps(calls)
        self.assertNotIn("private.json", serialized)
        self.assertNotIn("expected_behavior", serialized)
        self.assertNotIn("observable_checks", serialized)

    def test_rejects_non_kimi_model_before_provider_call(self):
        argv = [
            "baseline_uat.py",
            "--release", str(self.release),
            "--inputs", str(self.inputs),
            "--output", str(self.output),
            "--model", "other-model",
        ]
        with mock.patch.object(sys, "argv", argv), \
             mock.patch.dict(os.environ, {"MOONSHOT_API_KEY": "test-key"}, clear=False), \
             self.assertRaisesRegex(ValueError, "requires model kimi-k2.6"):
            baseline_uat.main()


if __name__ == "__main__":
    unittest.main()
