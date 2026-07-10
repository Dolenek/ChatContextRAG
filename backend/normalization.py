import re
import unicodedata
from typing import Iterable, List

from backend.models import DiscordMessageInput
from backend.vector_models import NormalizedMessage


class DiscordMessageNormalizer:
    def normalize(self, messages: Iterable[DiscordMessageInput]) -> List[NormalizedMessage]:
        return [self._normalize_message(message) for message in messages]

    def _normalize_message(self, message: DiscordMessageInput) -> NormalizedMessage:
        return NormalizedMessage(
            external_id=message.external_id.strip(),
            author=self._normalize_inline_text(message.author) or "Neznámý autor",
            content=self._normalize_content(message.content),
            timestamp=message.timestamp,
            channel=self._normalize_inline_text(message.channel) if message.channel else None,
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
