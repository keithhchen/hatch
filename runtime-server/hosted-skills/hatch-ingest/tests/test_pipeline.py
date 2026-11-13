import json
import tempfile
import unittest
from pathlib import Path

import _bootstrap  # noqa: F401
from hatch_ingest.app import Ingestor
from hatch_ingest.converters import (BaseConverter, ConversionContext, ConverterRegistry, DocumentConverter,
                                     FallbackConverter, HtmlExtractor, HtmlPageConverter, ImageConverter,
                                     MediaConverter, PdfConverter, TextConverter, default_registry,
                                     first_success)
from hatch_ingest.delivery import OutputDelivery
from hatch_ingest.domain import Converted, Item, LoginRequired, Payload, ProfileLedger, ToolError
from hatch_ingest.resilience import never_fail, retry
from hatch_ingest.domain import DownloadFailed
from hatch_ingest.sources import FileSource, SourceRegistry, UploadIndex
from hatch_ingest.transcribe import NullTranscriber, fixed_segments


def payload(ext, html=None, name="n"):
    return Payload(Item("i1", "file", name=name), Path("f" + ext), ext, html=html)


class RegistryTest(unittest.TestCase):
    def test_selection(self):
        reg = default_registry()
        pick = lambda p: type(reg.select(p))  # noqa: E731
        self.assertIs(pick(payload(".txt")), TextConverter)
        self.assertIs(pick(payload(".docx")), DocumentConverter)
        self.assertIs(pick(payload(".pdf")), PdfConverter)
        self.assertIs(pick(payload(".pdf", html="<p>")), HtmlPageConverter)  # link page snapshot
        self.assertIs(pick(payload(".html")), HtmlPageConverter)
        self.assertIs(pick(payload(".jpg")), ImageConverter)
        self.assertIs(pick(payload(".mp4", html="<p>")), MediaConverter)  # media wins over page
        self.assertIs(pick(payload(".m4a")), MediaConverter)
        self.assertIs(pick(payload(".xyz")), FallbackConverter)

    def test_new_format_is_one_class(self):
        class Dwg(BaseConverter):
            name, exts = "dwg", frozenset({".dwg"})
            def convert(self, p, ctx): return Converted(p.path, self.name)
        reg = default_registry().register(Dwg())
        self.assertEqual(reg.select(payload(".dwg")).name, "dwg")

    def test_first_success_falls_through(self):
        def bad(p, c): raise ToolError("nope")
        def empty(p, c): return "  "
        def good(p, c): return "text"
        text, used = first_success(bad, empty, good)(Path("x"), None)
        self.assertEqual((text, used), ("text", "good"))
        with self.assertRaises(ToolError):
            first_success(bad, empty)(Path("x"), None)


class ResilienceTest(unittest.TestCase):
    def test_never_fail(self):
        @never_fail(lambda x, exc: f"err:{exc}")
        def f(x): raise RuntimeError("boom")
        self.assertEqual(f(1), "err:boom")

    def test_retry_and_skip(self):
        calls = []
        @retry(attempts=3, sleep=lambda s: None)
        def flaky():
            calls.append(1)
            if len(calls) < 3: raise ValueError
            return "ok"
        self.assertEqual(flaky(), "ok")
        n = []
        @retry(attempts=3, skip=(LoginRequired,), sleep=lambda s: None)
        def walled():
            n.append(1); raise LoginRequired("u", "p")
        with self.assertRaises(LoginRequired): walled()
        self.assertEqual(len(n), 1)

    def test_segments(self):
        segs = list(fixed_segments([b"abcde", b"fg"], 3))
        self.assertEqual([b"".join(s) for s in segs], [b"abc", b"def", b"g"])


class IngestorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.remote = {}  # url -> bytes: what the presigned URLs serve

    def fetch_url(self, url, dest):
        if url not in self.remote:
            raise DownloadFailed("download failed: HTTP 403")
        dest.write_bytes(self.remote[url])

    def file(self, item_id, name, data=b"", url=None, **extra):
        url = url or f"https://oss.test/{item_id}?Signature=secret"
        self.remote.setdefault(url, data)
        return Item(item_id, "file", name=name, download_url=url, **extra)

    def ingestor(self, ledger=None):
        ctx = lambda wd: ConversionContext(wd, None, HtmlExtractor(), NullTranscriber())  # noqa: E731
        return Ingestor(SourceRegistry([FileSource(self.fetch_url)]), default_registry(),
                        OutputDelivery(self.tmp / "out", clock=lambda: "T"), ctx, self.tmp / "work",
                        ledger or ProfileLedger(), lambda m: None)

    def test_archive_is_one_document_and_an_unsafe_one_fails_the_item(self):
        import io, zipfile
        def zipped(entries):
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w") as zf:
                for entry, text in entries.items():
                    zf.writestr(entry, text)
            return buf.getvalue()
        good, evil = self.ingestor().run([self.file("g", "good.zip", zipped({"a.md": "alpha"})),
                                          self.file("e", "evil.zip", zipped({"../x.txt": "x"}))])
        self.assertEqual((good.status, good.original, good.markdown, good.error), ("ok", "g.original.zip", "g.content.md", None))
        self.assertIn("## a.md\n\nalpha", (self.tmp / "out" / "g.content.md").read_text())
        self.assertEqual(evil.status, "failed")
        self.assertIn("unsafe path", evil.error)

    def test_end_to_end_flat_output_and_batch_continues(self):
        text = "hello 世界".encode()
        items = [self.file("i1", "notes.txt", text),
                 Item("i2", "file", name="gone.txt", download_url="https://oss.test/gone?Signature=secret"),
                 self.file("i3", "blob.xyz", text)]
        r = self.ingestor().run(items)
        self.assertEqual([x.status for x in r], ["ok", "failed", "partial"])
        self.assertIn("download failed: HTTP 403", r[1].error)
        self.assertNotIn("Signature", r[1].error)
        self.assertEqual((r[0].original, r[0].markdown), ("i1.original.txt", "i1.content.md"))
        md = (self.tmp / "out" / "i1.content.md").read_text()
        self.assertIn("hello 世界", md)
        self.assertIn('converter: "text"', md)
        self.assertIsNone(r[2].markdown)  # passthrough keeps the original, invents nothing
        self.assertTrue((self.tmp / "out" / "i3.original.xyz").exists())

    def test_download_is_verified_against_size_and_digest(self):
        import hashlib
        data = b"hello"
        ok, wrong_size, wrong_sha = self.ingestor().run([
            self.file("a", "a.txt", data, bytes=5, sha256=hashlib.sha256(data).hexdigest()),
            self.file("b", "b.txt", data, bytes=6),
            self.file("c", "c.txt", data, bytes=5, sha256="0" * 64)])
        self.assertEqual(ok.status, "ok")
        self.assertIn("got 5 bytes, expected 6", wrong_size.error)
        self.assertIn("sha256 mismatch", wrong_sha.error)
        self.assertEqual((wrong_size.status, wrong_sha.status), ("failed", "failed"))

    def test_finish_lists_flat_files(self):
        out = OutputDelivery(self.tmp / "o2")
        out.save_cookies("p1", [{"name": "a", "value": "v", "domain": "d", "path": "/"}])
        files = out.finish([], [])
        self.assertEqual(files, ["profile.p1.json", "result.json"])
        self.assertEqual(json.loads((self.tmp / "o2" / "profile.p1.json").read_text())["cookies"][0]["name"], "a")

    def test_login_marks_profile(self):
        class Walled:
            def supports(self, i): return True
            def fetch(self, i, wd): raise LoginRequired("https://x", "p1")
        ledger = ProfileLedger()
        ing = self.ingestor(ledger)
        ing.sources = SourceRegistry([Walled()])
        r = ing.process(Item("l1", "link", url="https://x"))
        self.assertEqual(r.status, "failed")
        self.assertEqual(ledger.states()[0].status, "needs_login")


class UploadIndexTest(unittest.TestCase):
    def test_match_by_name_metadata_and_ambiguity(self):
        root = Path(tempfile.mkdtemp())
        (root / "a").mkdir()
        (root / "a" / "talk.mp4").write_bytes(b"1")
        (root / "b").mkdir()
        (root / "b" / "sha1").write_bytes(b"2")
        (root / "b" / "sha1.json").write_text(json.dumps({"title": "memo.pdf"}))
        (root / "task.json").write_text(json.dumps({"items": [{"upload_name": "memo.pdf"}]}))
        idx = UploadIndex(root)
        self.assertEqual(idx.find("talk.mp4").name, "talk.mp4")
        self.assertEqual(idx.find("memo.pdf").name, "sha1")
        with self.assertRaises(FileNotFoundError):
            idx.find("missing.pdf")


if __name__ == "__main__":
    unittest.main()


class ManifestUploadTest(unittest.TestCase):
    def test_finds_manifest_by_shape(self):
        root = Path(tempfile.mkdtemp()) / "upload"
        root.mkdir()
        (root / "task (1).json").write_text(json.dumps({"items": []}))
        idx = UploadIndex(root)
        self.assertEqual(idx.by_shape("items").name, "task (1).json")
        self.assertIsNone(idx.by_shape("profiles"))


class HttpTranscriberTest(unittest.TestCase):
    def test_sends_wav_segments_and_joins_text(self):
        from hatch_ingest.transcribe import DashScopeHttpTranscriber
        calls = []

        class Resp:
            status_code = 200
            def json(self): return {"choices": [{"message": {"content": f"part{len(calls)}"}}]}

        def post(url, **kw):
            calls.append(kw["json"]["messages"][0]["content"][0]["input_audio"]["data"][:22]); return Resp()

        t = DashScopeHttpTranscriber("KEY", segment_seconds=1, post=post)
        self.assertEqual(t.transcribe([b"\0" * 32000 * 2 + b"\0" * 10]), "part1\npart2\npart3")
        self.assertEqual(calls[0], "data:audio/wav;base64,")
