import copy
import hashlib
import io
import importlib.util
import json
import shutil
import sys
import tempfile
import unittest
import urllib.error
from unittest import mock
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "creator-agent-factory/scripts"))
import model_profile
FIXTURE = ROOT / "docs/proof/creator-factory-e2e-v1/work/factory-input"
SPEC = importlib.util.spec_from_file_location("factory", ROOT / "creator-agent-factory/scripts/factory.py")
factory = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(factory)
INTAKE_SPEC = importlib.util.spec_from_file_location("creator_intake", ROOT / "creator-agent-factory/scripts/intake.py")
creator_intake = importlib.util.module_from_spec(INTAKE_SPEC)
INTAKE_SPEC.loader.exec_module(creator_intake)
SEMANTIC_SPEC = importlib.util.spec_from_file_location("semantic_uat", ROOT / "creator-agent-factory/scripts/semantic_uat.py")
semantic_uat = importlib.util.module_from_spec(SEMANTIC_SPEC)
SEMANTIC_SPEC.loader.exec_module(semantic_uat)
PORTABILITY_SPEC = importlib.util.spec_from_file_location("portability_audit", ROOT / "creator-agent-factory/scripts/portability_audit.py")
portability_audit = importlib.util.module_from_spec(PORTABILITY_SPEC)
PORTABILITY_SPEC.loader.exec_module(portability_audit)
SCORE_HOLDOUTS_SPEC = importlib.util.spec_from_file_location("score_holdouts", ROOT / "creator-agent-factory/scripts/score_holdouts.py")
score_holdouts = importlib.util.module_from_spec(SCORE_HOLDOUTS_SPEC)
SCORE_HOLDOUTS_SPEC.loader.exec_module(score_holdouts)
RAW_FIXTURE = ROOT / "fixtures/creator-factory/maya-signal-resume-raw"


def tree_digest(path):
    rows = []
    for item in sorted(p for p in path.rglob("*") if p.is_file()):
        rows.append((item.relative_to(path).as_posix(), hashlib.sha256(item.read_bytes()).hexdigest()))
    return hashlib.sha256(factory.canonical(dict(rows))).hexdigest()


class FactoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="factory-test-"))

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_complete_build_and_private_boundary(self):
        summary = factory.build(FIXTURE, self.tmp / "proof")
        self.assertEqual(summary["documents"], 9)
        self.assertEqual(summary["source_facts"], 42)
        self.assertEqual(summary["derived_rules"], 9)
        self.assertEqual(summary["synthetic_qa"], 8)
        release_id_dir = next((self.tmp / "proof/release").iterdir())
        release = next(release_id_dir.iterdir())
        public = json.loads((release / "public.json").read_text())
        private = json.loads((release / "private.json").read_text())
        self.assertNotIn("system-prompt", json.dumps(public))
        self.assertEqual(public["product"]["price"]["model"], "per_delivery")
        self.assertEqual(public["product"]["price"]["unit"], "review")
        self.assertIn("system_prompt", private)
        workflow = private["runtime_policy"]["delivery_workflow"]
        self.assertEqual(workflow["mode"], "draft_claim_audit_revise")
        self.assertEqual(workflow["audit"]["unit"], "atomic_claim")
        self.assertTrue(workflow["audit"]["evidence_authority"]["protected_knowledge_cannot_support_user_specific_claims"])
        self.assertEqual(workflow["max_revision_passes"], 2)
        self.assertFalse(workflow["expose_intermediate"])
        self.assertTrue((release / "skills/signal-resume-review/SKILL.md").is_file())
        verification = factory.verify_release(release)
        self.assertTrue(verification["passed"])
        self.assertEqual(verification["factory_trace_keys_found"], [])
        self.assertEqual(
            set(private["few_shots"][0]),
            {"category", "question", "answer"},
        )
        self.assertFalse((release / "skills/signal-resume-review/references/method-model.json").exists())
        self.assertIn(
            "Only the validated final deliverable may reach the Consumer",
            (release / "skills/signal-resume-review/SKILL.md").read_text(),
        )
        rag_documents = json.loads((release / "rag/documents.json").read_text())
        rag_chunks = json.loads((release / "rag/chunks.json").read_text())
        self.assertEqual(
            set(rag_documents[0]),
            {"document_id", "title", "kind", "content_sha256", "provenance", "text"},
        )
        self.assertEqual(set(rag_chunks[0]), {"chunk_id", "document_id", "provenance", "text"})
        self.assertEqual(
            set(rag_documents[0]["provenance"]),
            {"source_kind", "source_sha256", "locations"},
        )
        self.assertTrue(rag_documents[0]["provenance"]["locations"])
        self.assertTrue(verification["checks"]["runtime_rag_preserves_minimum_provenance"])
        self.assertTrue(verification["checks"]["runtime_rag_text_excludes_factory_annotations"])
        runtime_rag_text = "\n".join(
            item["text"] for item in [*rag_documents, *rag_chunks]
        ).lower()
        for marker in (
            "claim:", "source provenance:", "intake source id",
            "original path:", "extracted path:", "raw sha256:",
            "extracted sha256:",
        ):
            self.assertNotIn(marker, runtime_rag_text)
        traces = json.loads((self.tmp / "proof/work/distilled/trace-matrix.json").read_text())
        self.assertEqual(len(traces), 63)
        self.assertTrue(all(t["verified"] and t["source_fact_closure"] for t in traces))

    def test_deterministic_across_two_outputs(self):
        factory.build(FIXTURE, self.tmp / "a")
        factory.build(FIXTURE, self.tmp / "b")
        self.assertEqual(tree_digest(self.tmp / "a"), tree_digest(self.tmp / "b"))

    def test_identical_rerun_is_allowed_but_changed_output_is_not(self):
        output = self.tmp / "proof"
        factory.build(FIXTURE, output)
        factory.build(FIXTURE, output)
        (output / "work/reports/gates.md").write_text("changed\n")
        with self.assertRaises(factory.BuildError):
            factory.build(FIXTURE, output)

    def test_missing_annotation_fails(self):
        pack = self.tmp / "pack"
        shutil.copytree(FIXTURE, pack)
        plan = json.loads((pack / "factory-plan.json").read_text())
        del plan["claim_annotations"][next(iter(plan["claim_annotations"]))]
        (pack / "factory-plan.json").write_text(json.dumps(plan))
        with self.assertRaises(factory.BuildError):
            factory.build(pack, self.tmp / "bad")

    def test_factory_rejects_nested_support_arrays_before_closure(self):
        pack = self.tmp / "pack"
        shutil.copytree(FIXTURE, pack)
        plan = json.loads((pack / "factory-plan.json").read_text())
        plan["derived_rules"][0]["supports"] = [["S-COURSE-001"], "S-RUBRIC-001"]
        (pack / "factory-plan.json").write_text(json.dumps(plan))
        with self.assertRaisesRegex(factory.BuildError, "flat string list"):
            factory.build(pack, self.tmp / "bad")

    def test_factory_rejects_undeclared_external_tool_need(self):
        pack = self.tmp / "pack"
        shutil.copytree(FIXTURE, pack)
        manifest = json.loads((pack / "source-manifest.json").read_text())
        manifest["product"]["external_tools"] = []
        (pack / "source-manifest.json").write_text(json.dumps(manifest))
        plan = json.loads((pack / "factory-plan.json").read_text())
        plan["tool_needs"] = [{
            "name": "Ask the user a question", "kind": "external", "required": True,
            "reason": "Continue the conversation.", "support": "intent",
        }]
        (pack / "factory-plan.json").write_text(json.dumps(plan))
        with self.assertRaisesRegex(factory.BuildError, "declared product external tool"):
            factory.build(pack, self.tmp / "bad")

    def test_invented_creator_authority_fails(self):
        pack = self.tmp / "pack"
        shutil.copytree(FIXTURE, pack)
        plan = json.loads((pack / "factory-plan.json").read_text())
        plan["qa_seeds"]["direct"][0]["answer"] = "Maya says she has seen this work every time."
        (pack / "factory-plan.json").write_text(json.dumps(plan))
        with self.assertRaises(factory.BuildError):
            factory.build(pack, self.tmp / "bad")

    def test_renderer_is_creator_and_domain_agnostic(self):
        manifest = {
            "creator": {"id": "ari-cole", "name": "Ari Cole", "bio": "Strength coach"},
            "product": {
                "id": "adaptive-strength-plan",
                "name": "Adaptive Strength Plan",
                "description": "Adjust training using available equipment and recovery signals.",
                "promise": "Produce a usable seven-day training plan from the user's goals, equipment, and logs.",
                "boundaries": [
                    "Do not infer outcomes from adoption alone.",
                    "Do not place disputed metrics or causal claims in the deliverable.",
                ],
            },
        }
        source = {
            "S-QUALITY": {"excerpt": "A plan must fit the available equipment."},
            "S-OMIT": {"excerpt": "Do not add volume when pain is unresolved.", "omission": "Delay added volume while pain is unresolved."},
            "S-BOUNDARY": {"excerpt": "Do not diagnose an injury."},
        }
        derived = [{"id": "D-ADAPT", "statement": "Reduce the next session when recovery signals deteriorate."}]
        by_id = {**source, "D-ADAPT": derived[0]}
        method = {
            "phases": [{"instruction": "Read goals, equipment, and recent logs.", "supports": ["D-ADAPT"]}],
            "quality_bar": ["S-QUALITY"],
            "omissions": ["S-OMIT"],
            "boundaries": ["S-BOUNDARY"],
        }
        prompt = factory.render_system_prompt(manifest, method, derived, by_id)
        skill = factory.render_protected_skill(manifest, method)
        combined = prompt + skill
        self.assertIn("Ari Cole", combined)
        self.assertIn("Adaptive Strength Plan", combined)
        self.assertIn("Reduce the next session", combined)
        self.assertIn("Do not infer outcomes from adoption alone.", prompt)
        self.assertIn("Do not place disputed metrics or causal claims in the deliverable.", prompt)
        self.assertIn("A caveat does not make an unsupported assertion safe", prompt)
        self.assertIn("do not reintroduce it as a plausible effect", prompt)
        self.assertIn("## Missing-input recovery", prompt)
        self.assertIn("## Evidence-minimal delivery", prompt)
        self.assertIn("smallest useful in-scope result", prompt)
        self.assertIn("Do not repeat an unsupported proposition as if it were true", prompt)
        self.assertIn("The declared product promise and method phases control", prompt)
        self.assertIn("carry out the complete promised method", prompt)
        self.assertIn("single isolated rewrite or clarification", prompt)
        self.assertIn("generic refusal", prompt)
        self.assertIn("Do not add generic domain education", prompt)
        self.assertIn("at most three plain sentences", prompt)
        self.assertIn("brief recovery path instead of a generic refusal", skill)
        self.assertIn("smallest useful in-scope", skill)
        self.assertIn("stay under\n500 words", skill)
        self.assertIn("one plain supported-output paragraph", skill)
        self.assertIn("do not add generic domain", skill)
        self.assertIn("at most three plain sentences", skill)
        self.assertNotIn("Maya", combined)
        self.assertNotIn("resume", combined.lower())
        self.assertNotIn("employment", combined.lower())

    def test_release_verifier_detects_tampering(self):
        factory.build(FIXTURE, self.tmp / "proof")
        release_id_dir = next((self.tmp / "proof/release").iterdir())
        release = next(release_id_dir.iterdir())
        prompt = release / "skills/signal-resume-review/SKILL.md"
        prompt.write_text(prompt.read_text() + "tampered\n")
        self.assertFalse(factory.verify_release(release)["passed"])

    def test_release_verifier_rejects_factory_or_review_leakage(self):
        factory.build(FIXTURE, self.tmp / "proof")
        release_id_dir = next((self.tmp / "proof/release").iterdir())
        release = next(release_id_dir.iterdir())
        leaked = release / "review/evals.json"
        leaked.parent.mkdir(parents=True)
        leaked.write_text("{}\n")
        verification = factory.verify_release(release)
        self.assertFalse(verification["passed"])
        self.assertEqual(verification["unexpected_files"], ["review/evals.json"])

    def test_raw_intake_needs_only_directory_and_intent(self):
        workspace = self.tmp / "intake"
        intent = (RAW_FIXTURE / "creator-intent.txt").read_text().strip()
        summary = creator_intake.intake(RAW_FIXTURE / "raw", intent, workspace)
        self.assertEqual(summary["totals"]["extracted_documents"], 9)
        self.assertEqual(summary["totals"]["unsupported_files"], 0)
        self.assertEqual(summary["creator_supplied"], {"directory": "raw", "product_intent": intent})
        self.assertFalse(any((RAW_FIXTURE / "raw").rglob("*.json")))
        video = next(item for item in summary["documents"] if item["kind"] == "video")
        self.assertEqual(video["extractor"], "sidecar VTT")
        self.assertTrue(video["transcript_provenance"]["segments_within_media"])
        self.assertLessEqual(
            video["transcript_provenance"]["final_end_seconds"],
            video["transcript_provenance"]["media_duration_seconds"],
        )
        self.assertTrue(any(item["kind"] == "pdf" for item in summary["documents"]))
        pdf = next(item for item in summary["documents"] if item["kind"] == "pdf")
        self.assertEqual(pdf["extractor"], "pdftotext -layout with page boundaries")
        self.assertEqual(pdf["pdf_provenance"]["page_count"], 1)
        self.assertEqual(pdf["pdf_provenance"]["pages"][0]["page_number"], 1)
        self.assertEqual(pdf["pdf_provenance"]["pages"][0]["location"], "course/evidence-workbook.pdf#page=1")
        extracted_pdf = (workspace / pdf["extracted_path"]).read_text()
        self.assertIn("<!-- source-location: course/evidence-workbook.pdf#page=1 -->", extracted_pdf)
        self.assertIn("## PDF page 1", extracted_pdf)

    def test_portability_raw_boundary_allows_json_course_exports_but_rejects_symlinks(self):
        valid = self.tmp / "valid-input"
        (valid / "raw/course").mkdir(parents=True)
        (valid / "creator-intent.txt").write_text("Create a useful agent.")
        (valid / "raw/course/export.json").write_text('{"lesson":"content"}')
        report = portability_audit.raw_boundary(valid)
        self.assertTrue(report["raw_and_natural_language_intent_only"])
        self.assertEqual(report["source_json_files"], ["raw/course/export.json"])

        linked = self.tmp / "linked-input"
        linked.mkdir()
        (linked / "creator-intent.txt").write_text("Create a useful agent.")
        (linked / "raw").symlink_to(valid / "raw", target_is_directory=True)
        linked_report = portability_audit.raw_boundary(linked)
        self.assertFalse(linked_report["raw_and_natural_language_intent_only"])
        self.assertIn("raw", linked_report["symlinks"])

    def test_pdf_extraction_preserves_each_page_location(self):
        fake_pdf = self.tmp / "course.pdf"
        fake_pdf.write_bytes(b"not-used")
        with (
            mock.patch.object(creator_intake, "command_path", return_value="/usr/bin/pdftotext"),
            mock.patch.object(creator_intake, "run_checked", return_value="First page text\fSecond page text\f"),
        ):
            pages, extractor = creator_intake.extract_pdf(fake_pdf)
        rendered, provenance = creator_intake.render_pdf_pages(pages, Path("course/course.pdf"))
        self.assertEqual(extractor, "pdftotext -layout with page boundaries")
        self.assertEqual(provenance["page_count"], 2)
        self.assertEqual(
            [page["location"] for page in provenance["pages"]],
            ["course/course.pdf#page=1", "course/course.pdf#page=2"],
        )
        self.assertIn("<!-- source-location: course/course.pdf#page=1 -->", rendered)
        self.assertIn("<!-- source-location: course/course.pdf#page=2 -->", rendered)
        self.assertLess(rendered.index("First page text"), rendered.index("Second page text"))

    def test_page_location_survives_factory_trace_and_runtime_rag(self):
        pack = self.tmp / "pack"
        shutil.copytree(FIXTURE, pack)
        manifest = json.loads((pack / "source-manifest.json").read_text())
        target = manifest["documents"][0]
        target["kind"] = "workbook"
        target["source_location"] = "course/workbook.pdf#page=7"
        target["raw_sha256"] = "a" * 64
        (pack / "source-manifest.json").write_text(json.dumps(manifest))

        factory.build(pack, self.tmp / "proof")
        release = next(next((self.tmp / "proof/release").iterdir()).iterdir())
        rag_documents = json.loads((release / "rag/documents.json").read_text())
        rag_chunks = json.loads((release / "rag/chunks.json").read_text())
        traced = [
            row for row in json.loads((self.tmp / "proof/work/distilled/trace-matrix.json").read_text())
            if "course/workbook.pdf#page=7" in row["source_locations"]
        ]
        runtime_doc = next(
            document for document in rag_documents
            if document["provenance"]["locations"] == ["course/workbook.pdf#page=7"]
        )
        runtime_chunks = [chunk for chunk in rag_chunks if chunk["document_id"] == runtime_doc["document_id"]]
        self.assertTrue(traced)
        self.assertEqual(runtime_doc["provenance"]["source_sha256"], "a" * 64)
        self.assertTrue(runtime_chunks)
        self.assertTrue(all(
            chunk["provenance"]["locations"] == ["course/workbook.pdf#page=7"]
            for chunk in runtime_chunks
        ))

    def test_runtime_rag_sanitizer_keeps_teaching_text_only(self):
        annotated = """# Lesson\n\nSource provenance:\n- intake source id: `src-course`\n- original path: `course.pdf`\n- extracted path: `extracted/course.md`\n- raw sha256: `abc`\n\n<!-- source-location: course.pdf#page=2 -->\n<!-- claim:S-LESSON-001 -->\n## Principle\nKeep the smallest defensible claim.\n"""
        cleaned = factory.runtime_rag_text(annotated)
        self.assertEqual(cleaned, "# Lesson\n\n## Principle\nKeep the smallest defensible claim.\n")

    def test_runtime_rag_sanitizer_preserves_creator_provenance_lesson(self):
        annotated = """# Lesson\n\nSource provenance:\n- intake source id: `src-course`\n- original path: `course.pdf`\n- extracted path: `extracted/course.md`\n- raw sha256: `abc`\n\n<!-- claim:S-LESSON-001 -->\n## Evidence practice\nA defensible memo explains its evidence.\n\n## Provenance\nProvenance: retain the source trail your reader needs.\n"""
        cleaned = factory.runtime_rag_text(annotated)
        self.assertNotIn("intake source id", cleaned)
        self.assertIn("## Provenance", cleaned)
        self.assertIn("Provenance: retain the source trail your reader needs.", cleaned)
        self.assertFalse(factory.runtime_rag_text_has_factory_annotations(cleaned))

    def test_runtime_rag_sanitizer_removes_legacy_factory_preamble_only(self):
        annotated = """# Lesson\n\nProvenance:\nDistilled from intake document `src-course` at original path `course.txt`. Each claim excerpt is reproduced exactly from the extracted intake text.\n\n<!-- claim:S-001 -->\n## Provenance\nProvenance: cite the source in the final memo.\n"""
        cleaned = factory.runtime_rag_text(annotated)
        self.assertNotIn("Distilled from intake document", cleaned)
        self.assertIn("## Provenance", cleaned)
        self.assertIn("Provenance: cite the source in the final memo.", cleaned)
        self.assertFalse(factory.runtime_rag_text_has_factory_annotations(cleaned))

    def test_runtime_rag_verifier_detects_only_factory_annotation_shapes(self):
        self.assertTrue(factory.runtime_rag_text_has_factory_annotations("- raw sha256: `abc`\n"))
        self.assertTrue(factory.runtime_rag_text_has_factory_annotations("<!-- claim:S-001 -->\n"))
        self.assertFalse(factory.runtime_rag_text_has_factory_annotations("Provenance: cite the original path in your appendix.\n"))

    def test_system_prompt_has_no_exact_normalized_duplicate_bullets(self):
        summary = factory.build(FIXTURE, self.tmp / "proof")
        report = json.loads((self.tmp / "proof/work/reports/prompt-purification.json").read_text())
        self.assertEqual(report["duplicate_normalized_bullets"], 0)
        self.assertTrue(report["passed"])

    def test_system_prompt_enforces_clause_level_evidence_discipline(self):
        factory.build(FIXTURE, self.tmp / "proof")
        release = next(next((self.tmp / "proof/release").iterdir()).iterdir())
        prompt = json.loads((release / "private.json").read_text())["system_prompt"]
        self.assertIn("Audit the final deliverable clause by clause.", prompt)
        self.assertIn("Evidence of an action, mechanism, usage, or adoption supports only", prompt)
        self.assertIn("Plausibility is not support.", prompt)

    def test_held_out_evals_include_global_claim_and_product_boundaries(self):
        held_out = [{
            "id": "H-001", "category": "boundary", "input": "probe",
            "expected_behavior": "stay grounded", "supports": ["S-001"],
            "observable_checks": ["Refuses unsupported claims."],
        }]
        manifest = {"product": {"boundaries": ["Does not invent outcomes."]}}
        compiled = factory.make_heldout_evals(held_out, manifest)
        self.assertEqual(compiled[0]["id"], "H-001")
        self.assertEqual(len(compiled[0]["global_boundary_checks"]), 2)
        self.assertIn("Every new factual or causal assertion", compiled[0]["observable_checks"][-2])
        self.assertIn("Does not invent outcomes.", compiled[0]["observable_checks"][-1])

    def test_claim_audit_requires_every_atomic_claim_to_be_entailed(self):
        workflow = factory.delivery_workflow_contract()
        self.assertIn("procedural advice, not a claim that the requested material already exists", workflow["audit_instruction"])
        self.assertIn("entailed as a quotation", workflow["audit_instruction"])
        self.assertIn("Creator-method advice", workflow["audit_instruction"])
        self.assertIn("Remove any unprovided person", workflow["revision_instruction"])
        raw = json.dumps({
            "passed": True,
            "claims": [
                {"unit_id": "U001", "claim": "The checklist was adopted.", "verdict": "entailed", "evidence": "input"},
                {"unit_id": "U002", "claim": "It standardized work.", "verdict": "unsupported", "evidence": "no outcome evidence"},
            ],
        })
        audited = semantic_uat.parse_claim_audit(raw, workflow, [
            {"unit_id": "U001", "text": "The checklist was adopted."},
            {"unit_id": "U002", "text": "It standardized work."},
        ])
        self.assertFalse(audited["passed"])

    def test_claim_audit_pass_is_computed_not_reviewer_reported(self):
        workflow = factory.delivery_workflow_contract()
        audited = semantic_uat.parse_claim_audit(json.dumps({
            "claims": [{
                "unit_id": "U001", "claim": "The checklist was adopted.",
                "verdict": "entailed", "evidence": "user input",
            }],
        }), workflow, [{"unit_id": "U001", "text": "The checklist was adopted."}])
        self.assertTrue(audited["passed"])

    def test_claim_audit_payload_separates_user_facts_from_creator_knowledge(self):
        workflow = factory.delivery_workflow_contract()
        payload = semantic_uat.claim_audit_payload(
            user="The checklist was adopted.",
            protected_context="Course lesson: checklists can standardize work.",
            draft="The checklist standardized work.",
            workflow=workflow,
        )
        self.assertEqual(payload["user_input"], "The checklist was adopted.")
        self.assertEqual(payload["protected_knowledge"], "Course lesson: checklists can standardize work.")
        self.assertTrue(payload["evidence_authority"]["protected_knowledge_cannot_support_user_specific_claims"])
        self.assertEqual(payload["claim_inventory"], [{"unit_id": "U001", "text": "The checklist standardized work."}])

    def test_delivery_workflow_revises_and_reaudits_before_returning(self):
        workflow = factory.delivery_workflow_contract()
        responses = [
            "The checklist standardized delivery.",
            json.dumps({"passed": False, "claims": [{"unit_id": "U001", "claim": "standardized delivery", "verdict": "unsupported", "evidence": "adoption only"}]}),
            "The checklist was adopted.",
            json.dumps({"passed": True, "claims": [{"unit_id": "U001", "claim": "The checklist was adopted.", "verdict": "entailed", "evidence": "user input"}]}),
        ]
        with mock.patch.object(semantic_uat, "complete", side_effect=responses):
            final, trace = semantic_uat.execute_delivery_workflow(
                url="https://creator.invalid/v1", api_key="creator", model=model_profile.KIMI_MODEL,
                reviewer_url="https://reviewer.invalid/v1", reviewer_api_key="reviewer", reviewer_model=model_profile.KIMI_MODEL,
                evidence_context="protected context", user="task", workflow=workflow,
            )
        self.assertEqual(final, "The checklist was adopted.")
        self.assertTrue(trace["passed"])
        self.assertEqual(trace["revision_passes"], 1)
        self.assertEqual(len(trace["audits"]), 2)

    def test_claim_audit_fails_when_reviewer_omits_a_draft_unit(self):
        workflow = factory.delivery_workflow_contract()
        inventory = semantic_uat.markdown_claim_units(
            "The checklist was adopted. It standardized delivery.", workflow
        )
        raw = json.dumps({
            "passed": True,
            "claims": [{
                "unit_id": "U001", "claim": "The checklist was adopted.",
                "verdict": "entailed", "evidence": "user input",
            }],
        })
        audited = semantic_uat.parse_claim_audit(raw, workflow, inventory)
        self.assertFalse(audited["passed"])
        self.assertEqual(audited["coverage"]["missing_unit_ids"], ["U002"])

    def test_claim_unitizer_covers_bullets_and_table_cells(self):
        workflow = factory.delivery_workflow_contract()
        units = semantic_uat.markdown_claim_units(
            "# Heading\n- Adopted by two teams; improved speed.\n\n| Claim | Evidence |\n| --- | --- |\n| Designed checklist | created checklist |",
            workflow,
        )
        self.assertEqual([row["text"] for row in units], [
            "Adopted by two teams;", "improved speed.", "Designed checklist", "created checklist",
        ])

    def test_delivery_audit_batches_claim_units_and_merges_global_coverage(self):
        workflow = factory.delivery_workflow_contract()
        draft = "\n".join(f"Claim {index} is supported." for index in range(1, 22))
        first = [{
            "unit_id": f"U{index:03d}", "claim": f"Claim {index} is supported.",
            "verdict": "entailed", "evidence": "user input",
        } for index in range(1, 13)]
        second = [{
            "unit_id": f"U{index:03d}", "claim": f"Claim {index} is supported.",
            "verdict": "entailed", "evidence": "user input",
        } for index in range(13, 22)]
        with mock.patch.object(semantic_uat, "complete", side_effect=[
            draft,
            json.dumps({"passed": True, "claims": first}),
            json.dumps({"passed": True, "claims": second}),
        ]) as provider:
            final, trace = semantic_uat.execute_delivery_workflow(
                url="https://creator.invalid/v1", api_key="creator", model=model_profile.KIMI_MODEL,
                reviewer_url="https://reviewer.invalid/v1", reviewer_api_key="reviewer", reviewer_model=model_profile.KIMI_MODEL,
                evidence_context="protected context", user="task", workflow=workflow,
            )
        self.assertEqual(final, draft)
        self.assertTrue(trace["passed"])
        self.assertEqual(trace["audits"][0]["batch_count"], 2)
        self.assertEqual(provider.call_count, 3)

    def test_semantic_run_requires_passing_workflow_trace_for_every_case(self):
        inputs = [{"id": "H-001"}, {"id": "H-002"}]
        outputs = [
            {"id": "H-001", "response": "Grounded answer."},
            {"id": "H-002", "response": "I can only provide a limited answer."},
        ]
        traces = [
            {"id": "H-001", "passed": True},
            {"id": "H-002", "passed": False, "boundary_safe_partial": True},
        ]
        self.assertFalse(semantic_uat.semantic_run_passed(inputs=inputs, outputs=outputs, workflow_traces=traces))
        traces[1] = {"id": "H-002", "passed": True}
        self.assertTrue(semantic_uat.semantic_run_passed(inputs=inputs, outputs=outputs, workflow_traces=traces))

    def test_semantic_run_rejects_missing_workflow_trace(self):
        self.assertFalse(semantic_uat.semantic_run_passed(
            inputs=[{"id": "H-001"}],
            outputs=[{"id": "H-001", "response": "Answer."}],
            workflow_traces=[],
        ))

    def test_semantic_checkpoint_write_is_atomic_and_replaceable(self):
        checkpoint = self.tmp / "candidate-outputs.json"
        semantic_uat.atomic_write_json(checkpoint, {"release_digest": "first", "outputs": []})
        semantic_uat.atomic_write_json(checkpoint, {"release_digest": "second", "outputs": [{"id": "H-001"}]})
        self.assertEqual(json.loads(checkpoint.read_text())["release_digest"], "second")
        self.assertEqual(list(self.tmp.glob(".*.tmp")), [])

    def test_kimi_profile_is_the_only_factory_model_and_uses_temperature_one(self):
        self.assertEqual(model_profile.KIMI_MODEL, "kimi-k2.6")
        self.assertEqual(
            model_profile.controls_for(model_profile.KIMI_MODEL, "candidate"),
            {"thinking": {"type": "disabled"}, "temperature": 0.6, "max_completion_tokens": 3000},
        )
        self.assertEqual(
            model_profile.controls_for(model_profile.KIMI_MODEL, "delivery_audit"),
            {"thinking": {"type": "disabled"}, "temperature": 0.6, "max_completion_tokens": 2500},
        )
        self.assertEqual(
            model_profile.controls_for(model_profile.KIMI_MODEL, "blind_judge"),
            {"thinking": {"type": "disabled"}, "temperature": 0.6, "max_completion_tokens": 2500},
        )
        with self.assertRaisesRegex(ValueError, "requires model kimi-k2.6"):
            model_profile.controls_for("some-other-model", "candidate")

    def test_blind_judge_sends_and_records_kimi_controls(self):
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({
            "choices": [{"finish_reason": "stop", "message": {"content": '{"A":[],"B":[]}'}}],
        }).encode()
        with mock.patch.object(score_holdouts.urllib.request, "urlopen", return_value=response) as provider:
            self.assertEqual(
                score_holdouts.provider_json(
                    url="https://kimi.invalid/v1", key="secret",
                    model=model_profile.KIMI_MODEL, payload={"probe": "x"},
                ),
                {"A": [], "B": []},
            )
        sent = json.loads(provider.call_args.args[0].data)
        self.assertEqual(sent["model"], "kimi-k2.6")
        self.assertEqual(sent["temperature"], 0.6)
        self.assertEqual(sent["thinking"], {"type": "disabled"})
        self.assertEqual(sent["max_completion_tokens"], 2500)
        self.assertNotIn("reasoning_format", sent)
        with self.assertRaisesRegex(ValueError, "requires model kimi-k2.6"):
            score_holdouts.provider_json(
                url="https://kimi.invalid/v1", key="secret",
                model="some-other-model", payload={"probe": "x"},
            )

    def provider_cache_fixture(self):
        namespace = semantic_uat.provider_cache_namespace(
            release_digest="sha256:" + "1" * 64,
            inputs_sha256="sha256:" + "2" * 64,
            candidate_url="https://creator.invalid/v1",
            candidate_model=model_profile.KIMI_MODEL,
            reviewer_url="https://reviewer.invalid/v1",
            reviewer_model=model_profile.KIMI_MODEL,
        )
        cache = semantic_uat.ExactRequestCache(self.tmp / "work/provider-cache", namespace)
        request = semantic_uat.provider_request_identity(
            url="https://creator.invalid/v1", model=model_profile.KIMI_MODEL,
            system="system", user="user", phase="creator_draft",
            request_label="case-1", response_format=None,
            controls=semantic_uat.completion_controls(model_profile.KIMI_MODEL, json_mode=False),
        )
        return namespace, cache, request

    def test_provider_cache_exact_hit_avoids_network(self):
        _namespace, cache, _request = self.provider_cache_fixture()
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({
            "choices": [{"finish_reason": "stop", "message": {"content": "Complete cached answer."}}],
        }).encode()
        arguments = dict(
            url="https://creator.invalid/v1", api_key="secret", model=model_profile.KIMI_MODEL,
            system="system", user="user", phase="creator_draft", request_label="case-1",
            cache=cache,
        )
        with mock.patch.object(semantic_uat.urllib.request, "urlopen", return_value=response) as provider:
            self.assertEqual(semantic_uat.complete(**arguments), "Complete cached answer.")
        self.assertEqual(provider.call_count, 1)
        sent = json.loads(provider.call_args.args[0].data)
        self.assertEqual(sent["model"], "kimi-k2.6")
        self.assertEqual(sent["temperature"], 0.6)
        self.assertEqual(sent["thinking"], {"type": "disabled"})
        self.assertEqual(sent["max_completion_tokens"], 3000)
        with mock.patch.object(semantic_uat.urllib.request, "urlopen") as provider:
            self.assertEqual(semantic_uat.complete(**arguments), "Complete cached answer.")
        provider.assert_not_called()

    def test_provider_cache_misses_on_any_request_or_namespace_change(self):
        namespace, cache, request = self.provider_cache_fixture()
        cache.put(request, "Cached answer.", json_mode=False)
        for field, replacement in (
            ("user", "different user"),
            ("system", "different system"),
            ("model", "different-model"),
            ("url", "https://different.invalid/v1"),
            ("phase", "creator_revision"),
            ("request_label", "case-2"),
            ("response_format", {"type": "json_object"}),
        ):
            changed = copy.deepcopy(request)
            changed[field] = replacement
            with self.subTest(field=field):
                self.assertIsNone(cache.get(changed, json_mode=False))
        changed_controls = copy.deepcopy(request)
        changed_controls["controls"]["temperature"] = 0.1
        self.assertIsNone(cache.get(changed_controls, json_mode=False))
        namespace_changes = (
            (("release_digest",), "sha256:" + "3" * 64),
            (("inputs_sha256",), "sha256:" + "4" * 64),
            (("candidate", "base_url"), "https://other-creator.invalid/v1"),
            (("candidate", "model"), "other-creator-model"),
            (("candidate", "controls", "temperature"), 0.1),
            (("reviewer", "base_url"), "https://other-reviewer.invalid/v1"),
            (("reviewer", "model"), "other-reviewer-model"),
            (("reviewer", "controls", "max_completion_tokens"), 999),
        )
        for path, replacement in namespace_changes:
            changed_namespace = copy.deepcopy(namespace)
            cursor = changed_namespace
            for part in path[:-1]:
                cursor = cursor[part]
            cursor[path[-1]] = replacement
            with self.subTest(namespace_path=path):
                other_cache = semantic_uat.ExactRequestCache(cache.root, changed_namespace)
                self.assertIsNone(other_cache.get(request, json_mode=False))

    def test_provider_errors_and_malformed_responses_are_not_cached(self):
        _namespace, cache, _request = self.provider_cache_fixture()
        failure = urllib.error.HTTPError(
            "https://creator.invalid/v1/chat/completions", 400, "Bad Request", {},
            io.BytesIO(b'{"error":{"message":"bad request"}}'),
        )
        with mock.patch.object(semantic_uat.urllib.request, "urlopen", side_effect=failure):
            with self.assertRaises(RuntimeError):
                semantic_uat.complete(
                    url="https://creator.invalid/v1", api_key="secret", model=model_profile.KIMI_MODEL,
                    system="system", user="user", phase="creator_draft", request_label="case-1",
                    cache=cache,
                )
        failure.close()
        self.assertEqual(list(cache.root.rglob("*.json")), [])

        malformed = mock.MagicMock()
        malformed.__enter__.return_value.read.return_value = json.dumps({
            "choices": [{"finish_reason": "stop", "message": {"content": "not-json"}}],
        }).encode()
        with mock.patch.object(semantic_uat.urllib.request, "urlopen", return_value=malformed):
            with self.assertRaisesRegex(RuntimeError, "malformed"):
                semantic_uat.complete(
                    url="https://reviewer.invalid/v1", api_key="secret", model=model_profile.KIMI_MODEL,
                    system="audit", user='{"claim_inventory":[]}', json_mode=True,
                    phase="delivery_audit", request_label="batch-1", cache=cache,
                )
        self.assertEqual(list(cache.root.rglob("*.json")), [])

        partial = mock.MagicMock()
        partial.__enter__.return_value.read.return_value = json.dumps({
            "choices": [{"finish_reason": "length", "message": {"content": '{"claims":[]}'}}],
        }).encode()
        with mock.patch.object(semantic_uat.urllib.request, "urlopen", return_value=partial):
            with self.assertRaisesRegex(RuntimeError, "partial"):
                semantic_uat.complete(
                    url="https://reviewer.invalid/v1", api_key="secret", model=model_profile.KIMI_MODEL,
                    system="audit", user='{"claim_inventory":[]}', json_mode=True,
                    phase="delivery_audit", request_label="batch-1", cache=cache,
                )
        self.assertEqual(list(cache.root.rglob("*.json")), [])

    def test_corrupt_provider_cache_entry_is_a_safe_miss(self):
        _namespace, cache, request = self.provider_cache_fixture()
        cache.put(request, "Stale cached answer.", json_mode=False)
        mismatched = json.loads(cache._path(request).read_text())
        mismatched["namespace"]["inputs_sha256"] = "sha256:" + "9" * 64
        semantic_uat.atomic_write_json(cache._path(request), mismatched)
        self.assertIsNone(cache.get(request, json_mode=False))
        cache._path(request).write_text("{corrupt")
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({
            "choices": [{"finish_reason": "stop", "message": {"content": "Fresh network answer."}}],
        }).encode()
        with mock.patch.object(semantic_uat.urllib.request, "urlopen", return_value=response) as provider:
            answer = semantic_uat.complete(
                url="https://creator.invalid/v1", api_key="secret", model=model_profile.KIMI_MODEL,
                system="system", user="user", phase="creator_draft", request_label="case-1",
                cache=cache,
            )
        self.assertEqual(answer, "Fresh network answer.")
        self.assertEqual(provider.call_count, 1)

    def test_provider_cache_stays_in_factory_work_and_out_of_release(self):
        output = self.tmp / "proof"
        factory.build(FIXTURE, output)
        cache_root = semantic_uat.provider_cache_root(output / "review/candidate-results.json")
        self.assertEqual(cache_root, output / "work/provider-cache")
        _namespace, cache, request = self.provider_cache_fixture()
        private_cache = semantic_uat.ExactRequestCache(cache_root, cache.namespace)
        private_cache.put(request, "Private cached response.", json_mode=False)
        release = next(next((output / "release").iterdir()).iterdir())
        self.assertFalse(any("provider-cache" in path.as_posix() for path in release.rglob("*")))
        self.assertTrue(factory.verify_release(release)["passed"])

    def test_blind_judge_accepts_exact_input_binding(self):
        inputs_bytes = b'[{"id":"H-001","input":"exact probe"}]\n'
        inputs_sha256 = "sha256:" + hashlib.sha256(inputs_bytes).hexdigest()
        payload = {"inputs_sha256": inputs_sha256}
        self.assertEqual(
            score_holdouts.validate_inputs_binding(
                candidate_payload=payload,
                baseline_payload=payload,
                inputs_bytes=inputs_bytes,
            ),
            inputs_sha256,
        )

    def test_blind_judge_rejects_missing_or_wrong_baseline_input_binding(self):
        inputs_bytes = b'[{"id":"H-001","input":"exact probe"}]\n'
        inputs_sha256 = "sha256:" + hashlib.sha256(inputs_bytes).hexdigest()
        candidate = {"inputs_sha256": inputs_sha256}
        for baseline in ({}, {"inputs_sha256": "sha256:" + "0" * 64}):
            with self.subTest(baseline=baseline):
                with self.assertRaisesRegex(ValueError, "baseline is not bound"):
                    score_holdouts.validate_inputs_binding(
                        candidate_payload=candidate,
                        baseline_payload=baseline,
                        inputs_bytes=inputs_bytes,
                    )

    def test_semantic_resume_discards_orphaned_output_or_trace(self):
        outputs, traces = semantic_uat.reconcile_semantic_checkpoints(
            outputs=[
                {"id": "H-001", "response": "committed"},
                {"id": "H-OUTPUT-ONLY", "response": "orphan"},
            ],
            workflow_traces=[
                {"id": "H-001", "passed": True},
                {"id": "H-TRACE-ONLY", "passed": True},
            ],
        )
        self.assertEqual([item["id"] for item in outputs], ["H-001"])
        self.assertEqual([item["id"] for item in traces], ["H-001"])

    def test_provider_wall_clock_deadline_fails_closed(self):
        with self.assertRaises(TimeoutError):
            with semantic_uat.hard_wall_clock_deadline(0.01):
                import time
                time.sleep(0.05)

    def test_provider_uses_kimi_json_object_without_relaxing_local_parser(self):
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({
            "choices": [{"finish_reason": "stop", "message": {"content": '{"claims":[]}'}}],
        }).encode()
        with mock.patch.object(semantic_uat.urllib.request, "urlopen", return_value=response) as provider:
            answer = semantic_uat.complete(
                url="https://reviewer.invalid/v1", api_key="secret", model=model_profile.KIMI_MODEL,
                system="audit", user="payload", json_mode=True, phase="delivery_audit",
            )
        self.assertEqual(answer, '{"claims":[]}')
        self.assertEqual(provider.call_count, 1)
        sent = json.loads(provider.call_args.args[0].data)
        self.assertEqual(sent["model"], "kimi-k2.6")
        self.assertEqual(sent["temperature"], 0.6)
        self.assertEqual(sent["thinking"], {"type": "disabled"})
        self.assertEqual(sent["max_completion_tokens"], 2500)
        self.assertEqual(sent["response_format"], {"type": "json_object"})

    def test_transcript_timestamps_cannot_overrun_media(self):
        transcript = self.tmp / "bad.vtt"
        transcript.write_text("WEBVTT\n\n00:00:00.000 --> 00:00:12.000\nToo long.\n")
        with self.assertRaises(creator_intake.IntakeError):
            creator_intake.transcript_provenance(transcript.read_text(), transcript, 10.0)


if __name__ == "__main__":
    unittest.main()
