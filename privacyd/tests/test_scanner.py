from privacyd.scanner import detect_deterministic


def test_detects_synthetic_pii_spans() -> None:
    text = (
        "Contact Alice Example at alice@example.test or +1 (415) 555-0101. "
        "See https://example.test/path."
    )

    spans = detect_deterministic(text)
    found = {(span.kind, text[span.start : span.end]) for span in spans}

    assert ("PERSON", "Alice Example") in found
    assert ("EMAIL", "alice@example.test") in found
    assert ("PHONE", "+1 (415) 555-0101") in found
    assert ("URL", "https://example.test/path") in found
