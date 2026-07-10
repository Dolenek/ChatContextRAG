import re
from typing import List

from backend.models import ChatResponse
from backend.repository import MessageRepository


STOP_WORDS = {
    "a", "aby", "co", "do", "je", "jak", "jako", "k", "kdo", "na", "nebo",
    "o", "od", "pro", "se", "s", "ta", "tak", "to", "ve", "v", "z", "že",
}


class DatabaseChatService:
    def __init__(self, repository: MessageRepository) -> None:
        self.repository = repository

    def answer(self, question: str) -> ChatResponse:
        search_terms = self._extract_terms(question)
        sources = self.repository.search_messages(search_terms)
        if not sources:
            return ChatResponse(
                answer="V databázi jsem k této otázce nenašel žádnou relevantní zprávu.",
                sources=[],
            )
        summaries = [f"{source.author}: {source.content}" for source in sources]
        answer = "V uložených zprávách jsem našel:\n\n" + "\n\n".join(summaries)
        return ChatResponse(answer=answer, sources=sources)

    @staticmethod
    def _extract_terms(question: str) -> List[str]:
        words = re.findall(r"[\wá-žÁ-Ž]+", question.lower(), flags=re.UNICODE)
        meaningful_words = [word for word in words if len(word) > 2 and word not in STOP_WORDS]
        return list(dict.fromkeys(meaningful_words))[:8]
