from privacyd.entity_map import EntityMapper
from privacyd.sanitizer import SECRET_REPLACEMENT, sanitize_text


def test_person_mapping_is_stable_within_app() -> None:
    mapper = EntityMapper(root_secret=b"unit-test-root")

    first = sanitize_text("Alice Example sent notes.", app_id="app.alpha", entity_mapper=mapper)
    second = sanitize_text("Please ask Alice Example for approval.", app_id="app.alpha", entity_mapper=mapper)

    assert first.sanitized_text == "PERSON_A sent notes."
    assert second.sanitized_text == "Please ask PERSON_A for approval."
    assert [record.pseudonym for record in mapper.records(app_id="app.alpha", kind="PERSON")] == ["PERSON_A"]


def test_same_entity_is_not_correlated_across_apps() -> None:
    mapper = EntityMapper(root_secret=b"unit-test-root")

    left = sanitize_text("Alice Example approved.", app_id="app.alpha", entity_mapper=mapper)
    right = sanitize_text("Alice Example approved.", app_id="app.beta", entity_mapper=mapper)

    assert left.sanitized_text == "PERSON_A approved."
    assert right.sanitized_text == "PERSON_A approved."

    alpha = mapper.records(app_id="app.alpha", kind="PERSON")[0]
    beta = mapper.records(app_id="app.beta", kind="PERSON")[0]
    assert alpha.entity_id != beta.entity_id
    assert alpha.canonical_hash != beta.canonical_hash


def test_secret_values_are_redacted_and_not_entity_mapped() -> None:
    mapper = EntityMapper(root_secret=b"unit-test-root")
    text = 'api_key = "testSecretAbC1234567890XYZ" for Alice Example'

    result = sanitize_text(text, app_id="app.alpha", entity_mapper=mapper)

    assert SECRET_REPLACEMENT in result.sanitized_text
    assert "testSecretAbC1234567890XYZ" not in result.sanitized_text
    assert any(finding.kind == "SECRET" and finding.redacted for finding in result.findings)
    assert all(record.kind != "SECRET" for record in mapper.records())
