import hashlib
import io
import re
import zipfile
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from typing import List, Optional, Tuple
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from backend.models import SourceMessageInput, WhatsAppPreviewMessage


MAX_TEXT_BYTES = 50 * 1024 * 1024
MAX_COMPRESSION_RATIO = 200
LINE_PATTERNS = (
    re.compile(
        r"^\[(?P<date>\d{1,2}[./-]\s*\d{1,2}[./-]\s*\d{2,4}),?\s+"
        r"(?P<time>\d{1,2}:\d{2}(?::\d{2})?(?:\s*[APap][Mm])?)\]\s*(?P<body>.*)$"
    ),
    re.compile(
        r"^(?P<date>\d{1,2}[./-]\s*\d{1,2}[./-]\s*\d{2,4}),?\s+"
        r"(?P<time>\d{1,2}:\d{2}(?::\d{2})?(?:\s*[APap][Mm])?)\s+-\s+(?P<body>.*)$"
    ),
)
MEDIA_MARKER = re.compile(
    r"(<media omitted>|media omitted|vynech[aá]n|omitted|\.opus|\.jpg|\.jpeg|\.png|\.mp4)",
    re.IGNORECASE,
)


class WhatsAppTextEntrySelectionRequired(ValueError):
    def __init__(self, entries: List[str]) -> None:
        super().__init__("ZIP obsahuje více .txt souborů; vyberte jeden.")
        self.entries = entries


@dataclass(frozen=True)
class ParsedWhatsAppMessage:
    raw_timestamp: str
    timestamp: datetime
    author: str
    content: str
    is_system: bool
    is_media_placeholder: bool


@dataclass(frozen=True)
class ParsedWhatsAppExport:
    messages: List[ParsedWhatsAppMessage]
    detected_date_order: Optional[str]
    requires_date_order: bool
    text_entry: Optional[str]

    def preview_samples(self) -> List[WhatsAppPreviewMessage]:
        return [
            WhatsAppPreviewMessage(
                author=message.author, content=message.content,
                timestamp=message.timestamp,
            )
            for message in self.messages[:5]
        ]


class WhatsAppExportParser:
    def parse(
        self, payload: bytes, file_name: str, date_order: Optional[str] = None,
        timezone_name: str = "UTC", text_entry: Optional[str] = None,
    ) -> ParsedWhatsAppExport:
        text, selected_entry = self._extract_text(payload, file_name, text_entry)
        lines = text.replace("\u202f", " ").replace("\u200e", "").splitlines()
        raw_records = self._group_records(lines)
        if not raw_records:
            raise ValueError("Soubor neobsahuje rozpoznatelný WhatsApp export.")
        detected, ambiguous = self._detect_date_order(raw_records)
        effective_order = date_order or detected or "DMY"
        timezone = self._timezone(timezone_name)
        messages = [
            self._parse_record(record, effective_order, timezone)
            for record in raw_records
        ]
        return ParsedWhatsAppExport(messages, detected, ambiguous, selected_entry)

    def to_inputs(
        self, parsed: ParsedWhatsAppExport, conversation_id: str,
        conversation_label: str,
    ) -> List[SourceMessageInput]:
        duplicate_ordinals = Counter()
        inputs = []
        for index, message in enumerate(parsed.messages):
            identity = (message.raw_timestamp, message.author, message.content)
            ordinal = duplicate_ordinals[identity]
            duplicate_ordinals[identity] += 1
            digest = hashlib.sha256(
                "\x1f".join((*identity, str(ordinal), conversation_id)).encode("utf-8")
            ).hexdigest()
            inputs.append(SourceMessageInput(
                external_id=f"waexp:{digest}", author=message.author,
                content=message.content, timestamp=message.timestamp,
                channel=conversation_label, source_type="whatsapp",
                conversation_id=conversation_id, conversation_label=conversation_label,
                message_order=int(message.timestamp.timestamp() * 1_000_000) * 1000
                + index % 1000,
                source_metadata={"import_kind": "whatsapp_export"},
            ))
        return inputs

    @staticmethod
    def _extract_text(
        payload: bytes, file_name: str, requested_entry: Optional[str],
    ) -> Tuple[str, Optional[str]]:
        if file_name.lower().endswith(".zip"):
            return WhatsAppExportParser._extract_zip_text(payload, requested_entry)
        if len(payload) > MAX_TEXT_BYTES:
            raise ValueError("WhatsApp textový export překračuje limit 50 MiB.")
        return WhatsAppExportParser._decode(payload), None

    @staticmethod
    def _extract_zip_text(payload: bytes, requested_entry: Optional[str]) -> Tuple[str, str]:
        try:
            with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                text_entries = [item for item in archive.infolist() if item.filename.lower().endswith(".txt")]
                if not text_entries:
                    raise ValueError("ZIP neobsahuje žádný .txt export.")
                if requested_entry:
                    entries = [item for item in text_entries if item.filename == requested_entry]
                    if not entries:
                        raise ValueError("Vybraný textový záznam v ZIPu nebyl nalezen.")
                    selected = entries[0]
                elif len(text_entries) == 1:
                    selected = text_entries[0]
                else:
                    raise WhatsAppTextEntrySelectionRequired(
                        [item.filename for item in text_entries],
                    )
                if selected.file_size > MAX_TEXT_BYTES:
                    raise ValueError("WhatsApp text v ZIPu překračuje limit 50 MiB.")
                ratio = selected.file_size / max(1, selected.compress_size)
                if ratio > MAX_COMPRESSION_RATIO:
                    raise ValueError("ZIP má podezřelý kompresní poměr.")
                return WhatsAppExportParser._decode(archive.read(selected)), selected.filename
        except zipfile.BadZipFile as error:
            raise ValueError("Soubor není platný ZIP archiv.") from error

    @staticmethod
    def _decode(payload: bytes) -> str:
        try:
            return payload.decode("utf-8-sig")
        except UnicodeDecodeError as error:
            raise ValueError("WhatsApp export musí být v UTF-8.") from error

    @staticmethod
    def _group_records(lines: List[str]) -> List[Tuple[str, str, str]]:
        records = []
        current = None
        for line in lines:
            match = next((pattern.match(line) for pattern in LINE_PATTERNS if pattern.match(line)), None)
            if match:
                if current:
                    records.append(tuple(current))
                current = [match.group("date"), match.group("time"), match.group("body")]
            elif current:
                current[2] += f"\n{line}"
        if current:
            records.append(tuple(current))
        return records

    @staticmethod
    def _detect_date_order(records: List[Tuple[str, str, str]]) -> Tuple[Optional[str], bool]:
        first_values = []
        second_values = []
        for date_token, _time, _body in records:
            first, second, *_ = re.split(r"[./-]", date_token)
            first_values.append(int(first))
            second_values.append(int(second))
        if any(value > 12 for value in first_values):
            return "DMY", False
        if any(value > 12 for value in second_values):
            return "MDY", False
        return None, True

    @staticmethod
    def _parse_record(record, date_order: str, timezone: ZoneInfo) -> ParsedWhatsAppMessage:
        date_token, time_token, body = record
        timestamp = WhatsAppExportParser._parse_timestamp(
            date_token, time_token, date_order, timezone,
        )
        author, separator, content = body.partition(": ")
        is_system = not separator
        if is_system:
            author, content = "WhatsApp system", body
        content = content.strip() or "[Prázdná WhatsApp zpráva]"
        is_media = bool(MEDIA_MARKER.search(content))
        if is_media:
            content = f"[WhatsApp médium] {content}"
        return ParsedWhatsAppMessage(
            f"{date_token} {time_token}", timestamp, author.strip(), content,
            is_system, is_media,
        )

    @staticmethod
    def _parse_timestamp(
        date_token: str, time_token: str, date_order: str, timezone: ZoneInfo,
    ) -> datetime:
        parts = [int(value) for value in re.split(r"[./-]", date_token)]
        if len(parts) != 3 or date_order not in {"DMY", "MDY"}:
            raise ValueError("Neplatný formát data WhatsApp exportu.")
        day, month, year = parts if date_order == "DMY" else (parts[1], parts[0], parts[2])
        year = year + 2000 if year < 100 else year
        normalized_time = re.sub(r"\s+", " ", time_token.strip()).upper()
        has_seconds = normalized_time.count(":") == 2
        if normalized_time.endswith((" AM", " PM")):
            time_format = "%I:%M:%S %p" if has_seconds else "%I:%M %p"
        else:
            time_format = "%H:%M:%S" if has_seconds else "%H:%M"
        parsed_time = datetime.strptime(normalized_time, time_format).time()
        return datetime.combine(datetime(year, month, day).date(), parsed_time, timezone)

    @staticmethod
    def _timezone(timezone_name: str) -> ZoneInfo:
        try:
            return ZoneInfo(timezone_name)
        except ZoneInfoNotFoundError as error:
            raise ValueError("Neznámá časová zóna WhatsApp importu.") from error
