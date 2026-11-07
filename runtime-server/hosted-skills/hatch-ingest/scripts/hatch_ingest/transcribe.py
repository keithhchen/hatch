"""Transcriber adapters. DashScope realtime ASR over WebSocket (paraformer-realtime-v2)."""
from __future__ import annotations

import json
import queue
import threading
import uuid
from typing import Any, Callable, Iterable, Iterator

from .domain import NoTranscriber
from .resilience import retry

DASHSCOPE_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference"


def fixed_segments(chunks: Iterable[bytes], max_bytes: int) -> Iterator[list[bytes]]:
    """Regroup a byte-chunk stream into lists whose total size is <= max_bytes."""
    seg: list[bytes] = []
    size = 0
    for chunk in chunks:
        while chunk:
            room = max_bytes - size
            seg.append(chunk[:room])
            size += len(seg[-1])
            chunk = chunk[room:]
            if size >= max_bytes:
                yield seg
                seg, size = [], 0
    if seg:
        yield seg


class NullTranscriber:
    provider, model = "none", "none"
    available = False

    def transcribe(self, pcm: Iterable[bytes]) -> str:
        raise NoTranscriber("no transcriber configured")


class DashScopeTranscriber:
    provider = "dashscope"

    def __init__(self, api_key: str, model: str = "paraformer-realtime-v2", url: str = DASHSCOPE_URL,
                 segment_seconds: int = 600, connect: Callable[..., Any] | None = None):
        self.api_key, self.model, self.url = api_key, model, url
        self.segment_bytes = segment_seconds * 16000 * 2
        self._connect = connect

    @property
    def available(self) -> bool:
        return bool(self.api_key)

    def transcribe(self, pcm: Iterable[bytes]) -> str:
        parts = [self._recognize(seg) for seg in fixed_segments(pcm, self.segment_bytes)]
        return "\n".join(p for p in parts if p).strip()

    @retry(attempts=2, delay=2.0)
    def _recognize(self, pieces: list[bytes]) -> str:
        connect = self._connect
        if connect is None:
            import websocket  # pip: websocket-client
            connect = websocket.create_connection
        # The sandbox proxy swaps the vault placeholder for the real key on this header.
        ws = connect(self.url, header=[f"Authorization: bearer {self.api_key}"], timeout=60)
        task_id = uuid.uuid4().hex
        events: queue.Queue = queue.Queue()

        def reader() -> None:
            try:
                while True:
                    msg = ws.recv()
                    if not msg:
                        events.put({"header": {"event": "task-failed", "error_message": "connection closed"}})
                        return
                    if isinstance(msg, bytes):
                        continue
                    ev = json.loads(msg)
                    events.put(ev)
                    if ev["header"]["event"] in ("task-finished", "task-failed"):
                        return
            except Exception as e:  # noqa: BLE001
                events.put({"header": {"event": "task-failed", "error_message": str(e)}})

        def send(action: str, payload: dict) -> None:
            ws.send(json.dumps({"header": {"action": action, "task_id": task_id, "streaming": "duplex"},
                                "payload": payload}))

        sentences: list[str] = []

        def wait_for(target: str, timeout: float) -> None:
            while True:
                ev = events.get(timeout=timeout)
                name = ev["header"]["event"]
                if name == "task-failed":
                    raise RuntimeError(ev["header"].get("error_message", "dashscope task failed"))
                if name == "result-generated":
                    s = ev.get("payload", {}).get("output", {}).get("sentence", {})
                    if s.get("sentence_end") and s.get("text"):
                        sentences.append(s["text"])
                if name == target:
                    return

        try:
            threading.Thread(target=reader, daemon=True).start()
            send("run-task", {"task_group": "audio", "task": "asr", "function": "recognition",
                              "model": self.model, "input": {},
                              "parameters": {"format": "pcm", "sample_rate": 16000,
                                             "language_hints": ["zh", "en"]}})
            wait_for("task-started", 30)
            for chunk in fixed_segments(pieces, 16000):  # ~0.5 s frames
                ws.send_binary(b"".join(chunk))
            send("finish-task", {"input": {}})
            wait_for("task-finished", 300)
        finally:
            try:
                ws.close()
            except Exception:  # noqa: BLE001
                pass
        return "\n".join(sentences)


def wav_bytes(pcm: bytes, rate: int = 16000) -> bytes:
    """16-bit mono PCM wrapped as a WAV file."""
    import io
    import wave
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


class DashScopeHttpTranscriber:
    """DashScope ASR over plain HTTPS (OpenAI-compatible endpoint).

    Preferred in the hosted sandbox: its egress proxy swaps vault placeholders on ordinary HTTPS
    requests, but rejects WebSocket upgrades (observed: 400 at handshake, 2026-11-07).
    """

    provider = "dashscope"
    URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"

    def __init__(self, api_key: str, model: str = "qwen3-asr-flash", segment_seconds: int = 120,
                 post: Callable[..., Any] | None = None):
        self.api_key, self.model = api_key, model
        self.segment_bytes = segment_seconds * 16000 * 2
        self._post = post

    @property
    def available(self) -> bool:
        return bool(self.api_key)

    def transcribe(self, pcm: Iterable[bytes]) -> str:
        parts = [self._recognize(b"".join(seg)) for seg in fixed_segments(pcm, self.segment_bytes)]
        return "\n".join(p for p in parts if p).strip()

    @retry(attempts=2, delay=2.0)
    def _recognize(self, pcm: bytes) -> str:
        import base64
        post = self._post
        if post is None:
            import requests
            post = requests.post
        audio = "data:audio/wav;base64," + base64.b64encode(wav_bytes(pcm)).decode()
        r = post(self.URL, timeout=300,
                 headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
                 json={"model": self.model, "stream": False, "asr_options": {"enable_itn": True},
                       "messages": [{"role": "user", "content": [{"type": "input_audio", "input_audio": {"data": audio}}]}]})
        if r.status_code != 200:
            raise RuntimeError(f"dashscope asr HTTP {r.status_code}: {r.text[:200]}")
        return (r.json()["choices"][0]["message"]["content"] or "").strip()
