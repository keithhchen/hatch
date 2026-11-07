import unittest

import _bootstrap  # noqa: F401
from hatch_ingest.browser import response_length
from hatch_ingest.sources import (DouyinStrategy, HostStrategy, InstagramStrategy, MediaCandidate as C,
                                  StrategyRegistry, XiaohongshuStrategy, default_strategies, embedded_state,
                                  urls_in)


class RegistryTest(unittest.TestCase):
    def test_selection_by_host(self):
        reg = default_strategies()
        pick = lambda u: type(reg.for_url(u))  # noqa: E731
        self.assertIs(pick("https://www.douyin.com/video/1"), DouyinStrategy)
        self.assertIs(pick("https://www.instagram.com/reel/AbC/"), InstagramStrategy)
        self.assertIs(pick("https://xhslink.com/x"), XiaohongshuStrategy)
        self.assertIs(pick("https://notdouyin.com/x"), HostStrategy)  # suffix must be a label boundary
        self.assertIs(pick("https://example.com/"), HostStrategy)

    def test_new_platform_is_one_class(self):
        class Foo(HostStrategy):
            hosts = ("foo.example",)
        self.assertIsInstance(StrategyRegistry().register(Foo()).for_url("https://a.foo.example/p"), Foo)


class PlanTest(unittest.TestCase):
    def test_generic_largest_video_first_and_audio_ignored_for_merge_flag(self):
        plan = HostStrategy().plan([C("https://c/a.mp4", "video/mp4", 10), C("https://c/b.mp4", "video/mp4", 99),
                                    C("https://c/s.js", "application/javascript", 500)], "https://x/")
        self.assertEqual(plan.videos, ("https://c/b.mp4", "https://c/a.mp4"))

    def test_douyin_signals_split_tracks(self):
        plan = DouyinStrategy().plan([C("https://v.douyinvod.com/media-video-avc1/x?mime_type=video_mp4", "application/octet-stream", 5),
                                      C("https://v.douyinvod.com/media-audio-und/y", "video/mp4", 2),
                                      C("https://static.douyin.com/app.js", "text/javascript", 9)], "https://www.douyin.com/video/1")
        self.assertEqual(len(plan.videos), 1)
        self.assertIn("media-video", plan.videos[0])
        self.assertIn("media-audio", plan.audios[0])

    def test_instagram_strips_range_params_and_collapses(self):
        plan = InstagramStrategy().plan([C("https://cdn/v.mp4?efg=1&bytestart=0&byteend=999", "video/mp4", 1000),
                                         C("https://cdn/v.mp4?efg=1&bytestart=1000&byteend=1999", "video/mp4", 1000)],
                                        "https://www.instagram.com/reel/AbC/")
        self.assertEqual(plan.videos, ("https://cdn/v.mp4?efg=1",))

    def test_instagram_binds_current_post_not_neighbours(self):
        cands = [C("https://cdn/neighbour.mp4", "video/mp4", 9), C("https://cdn/AbC_cur.mp4", "video/mp4", 1)]
        plan = InstagramStrategy().plan(cands, "https://www.instagram.com/reel/AbC/")
        self.assertEqual(plan.videos, ("https://cdn/AbC_cur.mp4",))

    def test_instagram_ambiguous_binds_nothing(self):
        cands = [C("https://cdn/a.mp4", "video/mp4", 9), C("https://cdn/b.mp4", "video/mp4", 1)]
        self.assertEqual(InstagramStrategy().plan(cands, "https://www.instagram.com/reel/AbC/").videos, ())

    def test_blob_and_non_http_ignored(self):
        self.assertEqual(HostStrategy().plan([C("blob:https://x/1", "video/mp4", 1)], "https://x/").videos, ())


class StateTest(unittest.TestCase):
    HTML = '<script>window.__S__ = {"a": {"u": "https://v.douyinvod.com/x", "n": 1}, "l": ["https://img/p.jpg"]};</script>'

    def test_embedded_state(self):
        self.assertEqual(embedded_state(self.HTML, "__S__")["a"]["n"], 1)
        self.assertIsNone(embedded_state(self.HTML, "__MISSING__"))
        self.assertIsNone(embedded_state("__S__ = {broken", "__S__"))

    def test_state_candidates_filtered_by_signals(self):
        class S(DouyinStrategy):
            state_vars = ("__S__",)
        self.assertEqual([c.url for c in S().state_candidates(self.HTML)], ["https://v.douyinvod.com/x"])
        self.assertEqual(list(urls_in({"a": ["https://a", 3]})), ["https://a"])


class LengthTest(unittest.TestCase):
    def test_response_length(self):
        self.assertEqual(response_length({"content-range": "bytes 0-9/1234", "content-length": "10"}), 1234)
        self.assertEqual(response_length({"content-length": "77"}), 77)
        self.assertEqual(response_length({}), 0)


if __name__ == "__main__":
    unittest.main()
