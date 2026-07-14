from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

from backend.chat_models import ChatSource
from backend.archive_time import ArchiveTimeRange
from backend.source_context import SourceContextProjector


MAX_EVIDENCE_MESSAGES = 48


@dataclass(frozen=True)
class EvidenceRecord:
    evidence_id: str
    source: ChatSource
    time_range: Optional[ArchiveTimeRange] = None


class EvidenceRegistry:
    def __init__(self, character_limit: int) -> None:
        self.character_limit = character_limit
        self.character_count = 0
        self.records: List[EvidenceRecord] = []
        self.ids_by_message: Dict[Tuple[str, str, str], str] = {}

    def add_sources(
        self, sources: Sequence[ChatSource], origin: str,
        time_range: Optional[ArchiveTimeRange] = None,
    ) -> dict:
        messages, exhausted = [], False
        for source in sources:
            payload = self._add_source(source, origin, time_range)
            if payload:
                messages.append(payload)
            elif self.is_exhausted:
                exhausted = True
                break
        return {
            "kind": "untrusted_archive_evidence",
            "messages": messages,
            "budget_exhausted": exhausted or self.is_exhausted,
            "remaining_characters": max(0, self.character_limit - self.character_count),
        }

    def source_for(self, evidence_id: str) -> Optional[ChatSource]:
        record = self.record_for(evidence_id)
        return record.source if record else None

    def record_for(self, evidence_id: str) -> Optional[EvidenceRecord]:
        return next(
            (record for record in self.records if record.evidence_id == evidence_id), None,
        )

    def sources(self) -> List[ChatSource]:
        return SourceContextProjector.normalize_match_scores(
            [record.source for record in self.records],
        )

    @property
    def is_exhausted(self) -> bool:
        return (
            self.character_count >= self.character_limit
            or len(self.records) >= MAX_EVIDENCE_MESSAGES
        )

    def _add_source(
        self, source: ChatSource, origin: str,
        time_range: Optional[ArchiveTimeRange],
    ) -> Optional[dict]:
        key = self._message_key(source)
        if not key:
            return None
        existing_id = self.ids_by_message.get(key)
        if existing_id:
            return {"evidence_id": existing_id, "already_provided": True}
        if self.is_exhausted:
            return None
        remaining = self.character_limit - self.character_count
        visible_content = source.content[:remaining]
        if not visible_content:
            return None
        evidence_id = f"E{len(self.records) + 1}"
        stored_source = source.model_copy(update={"evidence_origin": origin})
        self.records.append(EvidenceRecord(evidence_id, stored_source, time_range))
        self.ids_by_message[key] = evidence_id
        self.character_count += len(visible_content)
        return self._payload(evidence_id, stored_source, visible_content)

    @staticmethod
    def _message_key(source: ChatSource) -> Optional[Tuple[str, str, str]]:
        if len(source.source_message_ids) != 1:
            return None
        return (
            source.source_type,
            source.conversation_id or source.channel_id or "",
            source.source_message_ids[0],
        )

    @staticmethod
    def _payload(evidence_id, source, visible_content) -> dict:
        return {
            "evidence_id": evidence_id,
            "source_type": source.source_type,
            "conversation_id": source.conversation_id,
            "author": source.author,
            "timestamp": source.timestamp.isoformat() if source.timestamp else None,
            "content": visible_content,
            "content_truncated": len(visible_content) < len(source.content),
            "evidence_origin": source.evidence_origin,
        }
