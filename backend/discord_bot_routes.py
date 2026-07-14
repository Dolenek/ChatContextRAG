from typing import Optional

from fastapi import FastAPI, HTTPException, Query

from backend.discord_bot_models import (
    DiscordBotAnswerDetail, DiscordBotAnswerPage, DiscordBotAnswerRequest,
    DiscordBotAnswerResult, DiscordBotDeliveryUpdate, DiscordBotModelSettings,
    DiscordBotSettingsView, DiscordGuildPermissions,
)
from backend.discord_bot_service import DiscordBotService


def register_discord_bot_routes(
    application: FastAPI, service: DiscordBotService,
) -> None:
    @application.get(
        "/integrations/discord-bot/settings", response_model=DiscordBotSettingsView,
    )
    def settings() -> DiscordBotSettingsView:
        return service.settings()

    @application.put(
        "/integrations/discord-bot/settings/model",
        response_model=DiscordBotModelSettings,
    )
    def update_model(model: DiscordBotModelSettings) -> DiscordBotModelSettings:
        return service.update_model(model)

    @application.put(
        "/integrations/discord-bot/guilds/{guild_id}/permissions",
        response_model=DiscordGuildPermissions,
    )
    def update_permissions(
        guild_id: str, permissions: DiscordGuildPermissions,
    ) -> DiscordGuildPermissions:
        if guild_id != permissions.guild_id:
            raise ValueError("Discord guild ID does not match the route.")
        return service.update_permissions(permissions)

    @application.post(
        "/integrations/discord-bot/answers", response_model=DiscordBotAnswerResult,
    )
    def answer(request: DiscordBotAnswerRequest) -> DiscordBotAnswerResult:
        return service.answer(request)

    @application.patch(
        "/integrations/discord-bot/answers/{answer_id}/delivery",
        response_model=DiscordBotAnswerResult,
    )
    def record_delivery(
        answer_id: str, update: DiscordBotDeliveryUpdate,
    ) -> DiscordBotAnswerResult:
        return service.record_delivery(answer_id, update)

    @application.get(
        "/integrations/discord-bot/answers", response_model=DiscordBotAnswerPage,
    )
    def list_answers(
        limit: int = Query(default=25, ge=1, le=100),
        offset: int = Query(default=0, ge=0), guild_id: Optional[str] = None,
        channel_id: Optional[str] = None,
    ) -> DiscordBotAnswerPage:
        return service.list_answers(limit, offset, guild_id, channel_id)

    @application.get(
        "/integrations/discord-bot/answers/{answer_id}",
        response_model=DiscordBotAnswerDetail,
    )
    def answer_detail(answer_id: str) -> DiscordBotAnswerDetail:
        try:
            return service.answer_detail(answer_id)
        except LookupError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @application.delete("/integrations/discord-bot/answers/{answer_id}")
    def delete_answer(answer_id: str) -> dict:
        return service.delete_answer(answer_id)

    @application.delete("/integrations/discord-bot/answers")
    def delete_answers(guild_id: Optional[str] = None) -> dict:
        return service.delete_guild_answers(guild_id) if guild_id else (
            service.delete_all_answers()
        )

