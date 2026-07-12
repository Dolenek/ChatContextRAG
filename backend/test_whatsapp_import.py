import io
import zipfile

import pytest

from backend.whatsapp_parser import WhatsAppExportParser


def test_parses_czech_android_multiline_system_and_media() -> None:
    payload = (
        "13. 7. 2026 09:15 - Ada: První řádek\n"
        "druhý řádek\n"
        "13. 7. 2026 09:16 - obrázek vynechán\n"
        "13. 7. 2026 09:17 - Bob: <Media omitted>\n"
    ).encode()

    parsed = WhatsAppExportParser().parse(
        payload, "rodina.txt", timezone_name="Europe/Prague",
    )

    assert parsed.detected_date_order == "DMY"
    assert not parsed.requires_date_order
    assert len(parsed.messages) == 3
    assert parsed.messages[0].content == "První řádek\ndruhý řádek"
    assert parsed.messages[1].author == "WhatsApp system"
    assert parsed.messages[2].content.startswith("[WhatsApp médium]")


def test_parses_english_ios_and_requires_ambiguous_date_choice() -> None:
    payload = b"[7/8/26, 9:15 PM] Ada: Hello\n[7/8/26, 9:16 PM] Bob: Hi\n"

    parsed = WhatsAppExportParser().parse(
        payload, "chat.txt", date_order="MDY", timezone_name="UTC",
    )

    assert parsed.requires_date_order
    assert parsed.messages[0].timestamp.month == 7
    assert parsed.messages[0].timestamp.day == 8
    assert parsed.messages[0].timestamp.hour == 21


def test_reimport_ids_are_deterministic_and_namespaced() -> None:
    parser = WhatsAppExportParser()
    parsed = parser.parse(
        b"13/7/2026, 09:15 - Ada: Hello\n", "chat.txt", timezone_name="UTC",
    )

    first = parser.to_inputs(parsed, "family", "Family")
    second = parser.to_inputs(parsed, "family", "Family")

    assert first[0].external_id == second[0].external_id
    assert first[0].external_id.startswith("waexp:")
    assert first[0].source_type == "whatsapp"


def test_zip_with_multiple_text_entries_requires_selection() -> None:
    archive_payload = io.BytesIO()
    with zipfile.ZipFile(archive_payload, "w") as archive:
        archive.writestr("one.txt", "13/7/2026 09:15 - Ada: One")
        archive.writestr("two.txt", "13/7/2026 09:15 - Ada: Two")

    with pytest.raises(ValueError, match="více .txt"):
        WhatsAppExportParser().parse(archive_payload.getvalue(), "chat.zip")


def test_unknown_format_is_rejected_before_import() -> None:
    with pytest.raises(ValueError, match="rozpoznatelný"):
        WhatsAppExportParser().parse(b"not a WhatsApp export", "chat.txt")
