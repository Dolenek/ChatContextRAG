import re
import unicodedata
from typing import Iterable, List, Optional

from backend.models import SourceMessageInput
from backend.vector_models import NormalizedMessage


class SourceMessageNormalizer:
    def normalize(self, messages: Iterable[SourceMessageInput]) -> List[NormalizedMessage]:
        return [self._normalize_message(message) for message in messages]

    def _normalize_message(self, message: SourceMessageInput) -> NormalizedMessage:
        return NormalizedMessage(
            external_id=message.external_id.strip(),
            author=self._normalize_inline_text(message.author) or "Neznámý autor",
            content=self._normalize_content(message.content),
            timestamp=message.timestamp,
            channel=self._normalize_inline_text(message.channel) if message.channel else None,
            channel_id=message.channel_id.strip() if message.channel_id else None,
            guild_id=message.guild_id.strip() if message.guild_id else None,
            source_type=message.source_type,
            conversation_id=self._optional_identifier(
                message.conversation_id or message.channel_id,
            ),
            conversation_label=self._optional_label(
                message.conversation_label or message.channel,
            ),
            container_id=self._optional_identifier(message.container_id or message.guild_id),
            container_label=self._optional_label(message.container_label),
            source_metadata=message.source_metadata,
            message_order=message.message_order,
        )

    @staticmethod
    def _normalize_inline_text(value: str) -> str:
        normalized = unicodedata.normalize("NFKC", value)
        return re.sub(r"\s+", " ", normalized).strip()

    @staticmethod
    def _normalize_content(value: str) -> str:
        normalized = unicodedata.normalize("NFKC", value).replace("\r\n", "\n")
        lines = [re.sub(r"[ \t]+", " ", line).strip() for line in normalized.split("\n")]
        compact = "\n".join(lines)
        return re.sub(r"\n{3,}", "\n\n", compact).strip()

    @staticmethod
    def _optional_identifier(value: Optional[str]) -> Optional[str]:
        return value.strip() if value else None

    @classmethod
    def _optional_label(cls, value: Optional[str]) -> Optional[str]:
        return cls._normalize_inline_text(value) if value else None


DiscordMessageNormalizer = SourceMessageNormalizer
