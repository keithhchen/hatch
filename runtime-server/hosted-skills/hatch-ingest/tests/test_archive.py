import tempfile
import unittest
import zipfile
from pathlib import Path

import _bootstrap  # noqa: F401
from hatch_ingest.converters import ArchiveConverter, ConversionContext, default_registry
from hatch_ingest.domain import ArchiveRefused, Item, Payload


def make_zip(directory: Path, entries: dict[str, bytes]) -> Path:
    path = directory / "a.zip"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return path


class ArchiveTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def run_archive(self, path: Path, converter=None):
        work = self.dir / "work"
        work.mkdir(exist_ok=True)
        payload = Payload(Item("i1", "file", name="a.zip"), path, ".zip")
        ctx = ConversionContext(work, None, None, None)
        return (converter or default_registry().select(payload)).convert(payload, ctx)

    def test_registry_routes_zip_to_archive(self):
        payload = Payload(Item("i1", "file", name="a.zip"), Path("a.zip"), ".zip")
        self.assertIsInstance(default_registry().select(payload), ArchiveConverter)

    def test_text_entries_become_one_document_with_contents(self):
        path = make_zip(self.dir, {"notes/a.md": b"# A\n\nalpha", "b.txt": "第二份".encode(), "__MACOSX/._a": b"x",
                                   ".DS_Store": b"x", "notes/": b""})
        done = self.run_archive(path)
        self.assertEqual(done.status, "ok")
        self.assertEqual(done.original, path)
        self.assertTrue(done.body.startswith("## Contents"))
        self.assertIn("- notes/a.md (converted)", done.body)
        self.assertIn("## notes/a.md\n\n# A\n\nalpha", done.body)
        self.assertIn("## b.txt\n\n第二份", done.body)
        self.assertNotIn("MACOSX", done.body)
        self.assertNotIn("DS_Store", done.body)

    def test_unknown_entry_is_listed_and_makes_the_item_partial(self):
        done = self.run_archive(make_zip(self.dir, {"a.md": b"ok", "model.xyz": b"\x00\x01"}))
        self.assertEqual(done.status, "partial")
        self.assertIn("- model.xyz (", done.body)
        self.assertIn("model.xyz: no converter", done.error)
        self.assertIn("## a.md\n\nok", done.body)

    def test_a_failing_entry_does_not_lose_the_others(self):
        class Boom:
            def select(self, payload):
                class C:
                    def convert(self, p, ctx):
                        if p.source_name == "bad.txt":
                            raise RuntimeError("cannot read")
                        return default_registry().select(p).convert(p, ctx)
                return C()
        done = self.run_archive(make_zip(self.dir, {"bad.txt": b"x", "good.txt": b"fine"}), ArchiveConverter(Boom()))
        self.assertEqual(done.status, "partial")
        self.assertIn("bad.txt: cannot read", done.error)
        self.assertIn("## good.txt\n\nfine", done.body)

    def test_unsafe_or_unreadable_archive_is_refused(self):
        for name in ("../evil.txt", "/etc/passwd", "a/../../b.txt"):
            with self.subTest(name=name), self.assertRaises(ArchiveRefused):
                self.run_archive(make_zip(self.dir, {name: b"x"}))
        bad = self.dir / "bad.zip"
        bad.write_bytes(b"PK\x03\x04 not a zip")
        with self.assertRaises(ArchiveRefused):
            self.run_archive(bad)

    def test_limits(self):
        many = make_zip(self.dir, {f"{i}.txt": b"x" for i in range(5)})
        small = ArchiveConverter(default_registry())
        small.MAX_ENTRIES = 3
        with self.assertRaisesRegex(ArchiveRefused, "entries"):
            self.run_archive(many, small)
        bomb = make_zip(self.dir, {"zeros.txt": bytes(5_000_000)})
        with self.assertRaisesRegex(ArchiveRefused, "compressed"):
            self.run_archive(bomb)
        big = ArchiveConverter(default_registry())
        big.MAX_BYTES = 10
        with self.assertRaisesRegex(ArchiveRefused, "bytes"):
            self.run_archive(many, big)

    def test_nested_zip_is_listed_not_unpacked(self):
        inner = make_zip(self.dir, {"deep.txt": b"deep"})
        outer = self.dir / "outer.zip"
        with zipfile.ZipFile(outer, "w") as zf:
            zf.writestr("inner.zip", inner.read_bytes())
        done = self.run_archive(outer)
        self.assertEqual(done.status, "partial")
        self.assertNotIn("deep", done.body)
        self.assertIn("inner.zip", done.body)


if __name__ == "__main__":
    unittest.main()
