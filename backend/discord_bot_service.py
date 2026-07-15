import re
from typing import List, Optional

from backend.chat_models import ChatSource
from backend.discord_bot_models import (
    DiscordAnswerEvidence, DiscordBotAnswerPage, DiscordBotAnswerRequest,
    DiscordBotAnswerResult, DiscordBotDeliveryUpdate, DiscordBotModelSettings,
    DiscordBotSettingsView, DiscordGuildPermissions,
)
from backend.discord_bot_repository import DiscordBotRepository
from backend.discord_bot_retrieval import DiscordBotRetrievalPolicy


CITATION_PATTERN = re.compile(r"\[E([1-9][0-9]*)\]")


class DiscordBotService:
    def __init__(
        self, repository: DiscordBotRepository, provider_registry,
        index_repository, hybrid_repository, source_projector,
        archive_context_reader, workspace_settings=None, archive_text_searcher=None,
    ) -> None:
        self.repository = repository
        self.provider_registry = provider_registry
        self.retrieval_policy = DiscordBotRetrievalPolicy(
            provider_registry, index_repository, hybrid_repository,
            source_projector, archive_context_reader, workspace_settings,
            archive_text_searcher,
        )

    def settings(self) -> DiscordBotSettingsView:
        return self.repository.settings()

    def update_model(self, model: DiscordBotModelSettings) -> DiscordBotModelSettings:
        if model.chat_provider_id:
            self.provider_registry.get(model.chat_provider_id)
        return self.repository.update_model(model)

    def update_permissions(
        self, permissions: DiscordGuildPermissions,
    ) -> DiscordGuildPermissions:
        return self.repository.replace_permissions(permissions)

    def answer(self, request: DiscordBotAnswerRequest) -> DiscordBotAnswerResult:
        model = self.repository.settings().model
        self._require_model(model)
        parent_id = self.repository.parent_for_message(request.reply_to_message_id)
        answer_id = self.repository.create_answer(request, model, parent_id)
        try:
            generated = self._generate(request, model, parent_id)
            self.repository.complete_answer(answer_id, *generated[1:])
            return DiscordBotAnswerResult(answer_id=answer_id, **generated[0])
        except Exception as error:
            warnings = [*request.warnings, str(error)[:500]]
            self.repository.fail_answer(answer_id, error.__class__.__name__, warnings)
            raise

    def record_delivery(
        self, answer_id: str, update: DiscordBotDeliveryUpdate,
    ) -> DiscordBotAnswerResult:
        self.repository.record_delivery(
            answer_id, update.message_ids, update.status, update.warning,
        )
        detail = self.repository.answer_detail(answer_id)
        return DiscordBotAnswerResult(
            answer_id=answer_id, answer=detail.answer or "", basis=detail.basis,
            evidence=detail.evidence, warnings=detail.warnings,
        )

    def list_answers(
        self, limit: int, offset: int, guild_id: Optional[str],
        channel_id: Optional[str],
    ) -> DiscordBotAnswerPage:
        return self.repository.list_answers(limit, offset, guild_id, channel_id)

    def answer_detail(self, answer_id: str):
        return self.repository.answer_detail(answer_id)

    def delete_answer(self, answer_id: str) -> dict:
        return {"deleted": self.repository.delete_answer(answer_id)}

    def delete_guild_answers(self, guild_id: str) -> dict:
        return {"deleted": self.repository.delete_guild_answers(guild_id)}

    def delete_all_answers(self) -> dict:
        return {"deleted": self.repository.delete_all_answers()}

    def _generate(self, request, model, parent_id):
        history = self.repository.history_for(parent_id)
        provider = self.provider_registry.create_chat_provider(
            model.chat_provider_id, model.chat_model,
        )
        answer, sources, activities, warnings = self.retrieval_policy.answer(
            request, model, provider, history,
        )
        warnings = list(dict.fromkeys([*request.warnings, *warnings]))
        if not answer.strip():
            raise ValueError("Discord bot model returned an empty answer.")
        evidence, cited_ids = self._evidence(answer, sources)
        answer = self._sanitize_citations(answer, cited_ids)
        basis = "room_context" if cited_ids else "general_knowledge"
        result = {
            "answer": answer.strip(), "basis": basis,
            "evidence": evidence, "warnings": warnings,
        }
        serialized_activity = [item.model_dump(mode="json") for item in activities]
        completion = (
            answer.strip(), basis, evidence, cited_ids, serialized_activity, warnings,
        )
        return result, *completion

    @staticmethod
    def _evidence(answer: str, sources: List[ChatSource]):
        valid_ids = {
            f"E{index}" for index, source in enumerate(sources, start=1)
            if source.source_message_ids and source.guild_id and source.channel_id
        }
        cited = list(dict.fromkeys(
            f"E{match}" for match in CITATION_PATTERN.findall(answer)
            if f"E{match}" in valid_ids
        ))
        evidence = [DiscordAnswerEvidence(
            evidence_id=f"E{index}", origin=source.evidence_origin,
            author=source.author, content=source.content, timestamp=source.timestamp,
            channel_id=source.channel_id, guild_id=source.guild_id,
            message_id=source.source_message_ids[0] if source.source_message_ids else None,
            match_score=source.match_score, cited=f"E{index}" in cited,
        ) for index, source in enumerate(sources, start=1)]
        return evidence, cited

    @staticmethod
    def _sanitize_citations(answer: str, cited_ids: List[str]) -> str:
        cited = set(cited_ids)
        return CITATION_PATTERN.sub(
            lambda match: match.group(0) if f"E{match.group(1)}" in cited else "",
            answer,
        )

    @staticmethod
    def _require_model(model: DiscordBotModelSettings) -> None:
        if not model.chat_provider_id or not model.chat_model:
            raise ValueError("Discord bot AI model is not configured.")
