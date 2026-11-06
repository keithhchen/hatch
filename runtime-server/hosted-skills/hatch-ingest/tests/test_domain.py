import unittest
from pathlib import Path

import _bootstrap  # noqa: F401
from hatch_ingest.domain import (Converted, Item, ItemResult, Payload, Profile, ProfileLedger, aggregate,
                                 content_fields, detect_login_wall, redact, render_frontmatter,
                                 render_markdown, writable_cookies)


class FrontmatterTest(unittest.TestCase):
    def test_quotes_and_skips_none(self):
        fm = render_frontmatter({"title": "a: b\n\"c\"", "author": None, "kind": "link"})
        self.assertIn('title: "a: b\\n\\"c\\""', fm)
        self.assertNotIn("author", fm)
        self.assertTrue(fm.startswith("---\n") and fm.endswith("---\n"))

    def test_content_fields_transcription_and_chinese(self):
        item = Item("i1", "file", name="talk.mp4", upload_name="talk.mp4")
        p = Payload(item, Path("x.mp4"), ".mp4", title="演讲", source_name="talk.mp4")
        c = Converted(Path("x.mp4"), "media", transcription={"provider": "dashscope", "model": "m"})
        f = content_fields(p, c, "2026-01-01T00:00:00+00:00")
        self.assertEqual(f["transcription_provider"], "dashscope")
        self.assertIn("title: \"演讲\"", render_frontmatter(f))
        self.assertNotIn("source_url", render_frontmatter(f))

    def test_notes_rendered_before_body(self):
        md = render_markdown({"title": "t"}, ["transcription unavailable"], "body")
        self.assertLess(md.index("Note: transcription unavailable"), md.index("body"))


class CookieFilterTest(unittest.TestCase):
    def test_drops_vault_and_out_of_scope(self):
        cookies = [
            {"name": "a", "value": "__kha_vault_vcrd_x__", "domain": ".xhs.com", "path": "/"},
            {"name": "b", "value": "real", "domain": ".xhs.com", "path": "/", "expires": -1, "secure": True, "extra": 1},
            {"name": "c", "value": "real", "domain": "tracker.net", "path": "/"},
        ]
        out = writable_cookies(cookies, ["www.xhs.com"])
        self.assertEqual([c["name"] for c in out], ["b"])
        self.assertNotIn("expires", out[0])
        self.assertNotIn("extra", out[0])


class ResultTest(unittest.TestCase):
    def test_aggregate_and_ledger(self):
        ledger = ProfileLedger()
        ledger.used("p1")
        ledger.used("p2")
        ledger.needs_login("p2", "wall")
        ledger.used("p2")  # must not reset
        res = aggregate([ItemResult("i1", "ok", "i1.original.pdf", "i1.content.md"),
                         ItemResult("i2", "failed", error="boom")], ledger.states())
        self.assertEqual(res["items"][0], {"id": "i1", "status": "ok", "original": "i1.original.pdf",
                                           "markdown": "i1.content.md"})
        self.assertEqual(res["items"][1], {"id": "i2", "status": "failed", "error": "boom"})
        self.assertEqual(res["profiles"], [{"id": "p1", "status": "ready"},
                                           {"id": "p2", "status": "needs_login", "note": "wall"}])

    def test_login_wall(self):
        self.assertTrue(detect_login_wall("https://x.com/i/flow/login", "anything long " * 200))
        self.assertTrue(detect_login_wall("https://a.com/p", "请登录后查看"))
        self.assertFalse(detect_login_wall("https://a.com/p", "正文 " * 600 + "请登录"))
        self.assertFalse(detect_login_wall("https://a.com/blogin-guide", "hello"))

    def test_profile_match_and_item_validation(self):
        p = Profile.from_dict({"id": "p", "hosts": ["xiaohongshu.com"]})
        self.assertTrue(p.matches("https://www.xiaohongshu.com/x"))
        self.assertFalse(p.matches("https://notxiaohongshu.com/x"))
        with self.assertRaises(ValueError):
            Item.from_dict({"id": "../a", "kind": "link", "url": "u"})
        with self.assertRaises(ValueError):
            Item.from_dict({"id": "a", "kind": "file"})

    def test_redact(self):
        self.assertEqual(redact("x __kha_vault_vcrd_ab-c__ y"), "x [vault] y")


if __name__ == "__main__":
    unittest.main()
