import uuid
from contextlib import contextmanager
from typing import Callable, List, Optional

import psycopg
from psycopg.types.json import Jsonb

from backend.chat_models import ChatHistoryTurn
from backend.discord_bot_models import (
    DiscordAnswerEvidence, DiscordBotAnswerDetail, DiscordBotAnswerPage,
    DiscordBotAnswerRequest, DiscordBotAnswerSummary, DiscordBotModelSettings,
    DiscordBotSettingsView, DiscordGuildPermissions, DiscordPermissionSubject,
)
from backend.openai_gateway import ExternalIntegrationError


class DiscordBotRepository:
    def __init__(self, ensure_schema: Callable, connect: Callable) -> None:
        self.ensure_schema = ensure_schema
        self.connect = connect

    def settings(self) -> DiscordBotSettingsView:
        self.ensure_schema()
        with self._connection("settings read") as connection:
            model_row = connection.execute(
                """SELECT chat_provider_id,chat_model,reasoning_effort,retrieval_mode,
                          evidence_character_limit FROM discord_bot_settings WHERE id=1"""
            ).fetchone()
            guild_rows = connection.execute(
                "SELECT guild_id,guild_name FROM discord_bot_guilds ORDER BY guild_name"
            ).fetchall()
            subject_rows = connection.execute(
                """SELECT guild_id,capability,subject_type,subject_id,display_name
                   FROM discord_bot_permission_subjects
                   ORDER BY display_name,subject_id"""
            ).fetchall()
        return DiscordBotSettingsView(
            model=self._model(model_row),
            guilds=self._guilds(guild_rows, subject_rows),
        )

    def update_model(self, model: DiscordBotModelSettings) -> DiscordBotModelSettings:
        self.ensure_schema()
        with self._connection("model settings update") as connection:
            row = connection.execute(
                """UPDATE discord_bot_settings SET chat_provider_id=%s,chat_model=%s,
                          reasoning_effort=%s,retrieval_mode=%s,evidence_character_limit=%s,
                          updated_at=NOW() WHERE id=1
                   RETURNING chat_provider_id,chat_model,reasoning_effort,retrieval_mode,
                             evidence_character_limit""",
                (
                    model.chat_provider_id, model.chat_model, model.reasoning_effort,
                    model.retrieval_mode, model.evidence_character_limit,
                ),
            ).fetchone()
        return self._model(row)

    def replace_permissions(
        self, permissions: DiscordGuildPermissions,
    ) -> DiscordGuildPermissions:
        self.ensure_schema()
        with self._connection("guild permissions update") as connection:
            connection.execute(
                """INSERT INTO discord_bot_guilds(guild_id,guild_name,updated_at)
                   VALUES(%s,%s,NOW()) ON CONFLICT(guild_id) DO UPDATE SET
                   guild_name=EXCLUDED.guild_name,updated_at=NOW()""",
                (permissions.guild_id, permissions.guild_name),
            )
            connection.execute(
                "DELETE FROM discord_bot_permission_subjects WHERE guild_id=%s",
                (permissions.guild_id,),
            )
            rows = self._permission_rows(permissions)
            if rows:
                with connection.cursor() as cursor:
                    cursor.executemany(
                        """INSERT INTO discord_bot_permission_subjects
                           (guild_id,capability,subject_type,subject_id,display_name)
                           VALUES(%s,%s,%s,%s,%s)""",
                        rows,
                    )
        return permissions

    def create_answer(
        self, request: DiscordBotAnswerRequest, model: DiscordBotModelSettings,
        parent_answer_id: Optional[str],
    ) -> str:
        self.ensure_schema()
        answer_id = str(uuid.uuid4())
        recent = [item.model_dump(mode="json") for item in request.recent_context]
        with self._connection("answer creation") as connection:
            connection.execute(
                """INSERT INTO discord_bot_answers
                   (id,guild_id,guild_name,channel_id,channel_name,requester_id,
                    requester_name,trigger_message_id,trigger_type,parent_answer_id,
                    question,status,chat_provider_id,chat_model,reasoning_effort,
                    retrieval_mode,evidence_character_limit,recent_context,trigger_at)
                   VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'generating',
                          %s,%s,%s,%s,%s,%s,%s)""",
                (
                    answer_id, request.guild_id, request.guild_name, request.channel_id,
                    request.channel_name, request.requester_id, request.requester_name,
                    request.trigger_message_id, request.trigger_type, parent_answer_id,
                    request.question, model.chat_provider_id, model.chat_model,
                    model.reasoning_effort, model.retrieval_mode,
                    model.evidence_character_limit, Jsonb(recent), request.trigger_at,
                ),
            )
        return answer_id

    def complete_answer(
        self, answer_id: str, answer: str, basis: str,
        evidence: List[DiscordAnswerEvidence], cited_ids: List[str],
        tool_activity: List[dict], warnings: List[str],
    ) -> None:
        serialized = [item.model_dump(mode="json") for item in evidence]
        with self._connection("answer completion") as connection:
            connection.execute(
                """UPDATE discord_bot_answers SET answer=%s,status='generated',
                   answer_basis=%s,evidence=%s,cited_evidence_ids=%s,tool_activity=%s,
                   warnings=%s,completed_at=NOW() WHERE id=%s""",
                (
                    answer, basis, Jsonb(serialized), Jsonb(cited_ids),
                    Jsonb(tool_activity), Jsonb(warnings), answer_id,
                ),
            )

    def fail_answer(self, answer_id: str, error_code: str, warnings: List[str]) -> None:
        with self._connection("answer failure") as connection:
            connection.execute(
                """UPDATE discord_bot_answers SET status='failed',error_code=%s,
                   warnings=%s,completed_at=NOW() WHERE id=%s""",
                (error_code, Jsonb(warnings), answer_id),
            )

    def record_delivery(
        self, answer_id: str, message_ids: List[str], status: str,
        warning: Optional[str],
    ) -> None:
        with self._connection("answer delivery") as connection:
            connection.execute(
                "DELETE FROM discord_bot_answer_messages WHERE answer_id=%s", (answer_id,),
            )
            if message_ids:
                with connection.cursor() as cursor:
                    cursor.executemany(
                        """INSERT INTO discord_bot_answer_messages(answer_id,message_id,position)
                           VALUES(%s,%s,%s)""",
                        [(answer_id, message_id, index)
                         for index, message_id in enumerate(message_ids)],
                    )
            next_status = "delivered" if status == "delivered" else "delivery_failed"
            connection.execute(
                """UPDATE discord_bot_answers SET status=%s,
                   warnings=warnings || %s WHERE id=%s""",
                (next_status, Jsonb([warning] if warning else []), answer_id),
            )

    def parent_for_message(self, message_id: Optional[str]) -> Optional[str]:
        if not message_id:
            return None
        self.ensure_schema()
        with self._connection("answer parent lookup") as connection:
            row = connection.execute(
                "SELECT answer_id FROM discord_bot_answer_messages WHERE message_id=%s",
                (message_id,),
            ).fetchone()
        return row[0] if row else None

    def history_for(self, parent_answer_id: Optional[str]) -> List[ChatHistoryTurn]:
        if not parent_answer_id:
            return []
        with self._connection("answer history read") as connection:
            rows = connection.execute(
                """WITH RECURSIVE chain AS (
                     SELECT id,parent_answer_id,question,answer,created_at,1 depth
                     FROM discord_bot_answers WHERE id=%s
                     UNION ALL
                     SELECT parent.id,parent.parent_answer_id,parent.question,parent.answer,
                            parent.created_at,chain.depth+1
                     FROM discord_bot_answers parent JOIN chain
                       ON chain.parent_answer_id=parent.id WHERE chain.depth<4)
                   SELECT question,answer FROM chain WHERE answer IS NOT NULL
                   ORDER BY created_at""",
                (parent_answer_id,),
            ).fetchall()
        return [
            turn for row in rows
            for turn in (
                ChatHistoryTurn(role="user", content=row[0]),
                ChatHistoryTurn(role="assistant", content=row[1]),
            )
        ][-8:]

    def list_answers(
        self, limit: int, offset: int, guild_id: Optional[str],
        channel_id: Optional[str],
    ) -> DiscordBotAnswerPage:
        self.ensure_schema()
        where, parameters = self._answer_filters(guild_id, channel_id)
        with self._connection("answer history list") as connection:
            total = connection.execute(
                f"SELECT COUNT(*) FROM discord_bot_answers {where}", parameters,
            ).fetchone()[0]
            rows = connection.execute(
                f"""SELECT id,guild_id,guild_name,channel_id,channel_name,requester_id,
                           requester_name,question,answer,status,answer_basis,created_at
                    FROM discord_bot_answers {where}
                    ORDER BY created_at DESC,id LIMIT %s OFFSET %s""",
                (*parameters, limit, offset),
            ).fetchall()
        return DiscordBotAnswerPage(
            items=[self._summary(row) for row in rows], total=total,
            limit=limit, offset=offset,
        )

    def answer_detail(self, answer_id: str) -> DiscordBotAnswerDetail:
        self.ensure_schema()
        with self._connection("answer detail read") as connection:
            row = connection.execute(self._detail_query(), (answer_id,)).fetchone()
            message_rows = connection.execute(
                """SELECT message_id FROM discord_bot_answer_messages
                   WHERE answer_id=%s ORDER BY position""", (answer_id,),
            ).fetchall()
        if not row:
            raise LookupError("Discord bot answer was not found.")
        return self._detail(row, [item[0] for item in message_rows])

    def delete_answer(self, answer_id: str) -> int:
        return self._delete("id=%s", (answer_id,))

    def delete_guild_answers(self, guild_id: str) -> int:
        return self._delete("guild_id=%s", (guild_id,))

    def delete_all_answers(self) -> int:
        return self._delete("TRUE", ())

    def _delete(self, predicate: str, parameters: tuple) -> int:
        self.ensure_schema()
        with self._connection("answer history deletion") as connection:
            cursor = connection.execute(
                f"DELETE FROM discord_bot_answers WHERE {predicate}", parameters,
            )
            return cursor.rowcount

    @contextmanager
    def _connection(self, operation: str):
        try:
            with self.connect() as connection:
                yield connection
        except psycopg.Error as error:
            raise ExternalIntegrationError(
                f"PostgreSQL Discord bot {operation} failed."
            ) from error

    @staticmethod
    def _model(row) -> DiscordBotModelSettings:
        return DiscordBotModelSettings(
            chat_provider_id=row[0], chat_model=row[1], reasoning_effort=row[2],
            retrieval_mode=row[3], evidence_character_limit=row[4],
        )

    @staticmethod
    def _guilds(guild_rows, subject_rows) -> List[DiscordGuildPermissions]:
        subjects = {}
        for guild_id, capability, subject_type, subject_id, display_name in subject_rows:
            subjects.setdefault((guild_id, capability), []).append(
                DiscordPermissionSubject(
                    subject_type=subject_type, subject_id=subject_id,
                    display_name=display_name,
                )
            )
        return [DiscordGuildPermissions(
            guild_id=guild_id, guild_name=guild_name,
            sync_subjects=subjects.get((guild_id, "sync"), []),
            ask_subjects=subjects.get((guild_id, "ask"), []),
        ) for guild_id, guild_name in guild_rows]

    @staticmethod
    def _permission_rows(permissions):
        rows = []
        for capability, items in (
            ("sync", permissions.sync_subjects), ("ask", permissions.ask_subjects),
        ):
            rows.extend((
                permissions.guild_id, capability, item.subject_type,
                item.subject_id, item.display_name,
            ) for item in items)
        return rows

    @staticmethod
    def _answer_filters(guild_id, channel_id):
        clauses, parameters = [], []
        if guild_id:
            clauses.append("guild_id=%s")
            parameters.append(guild_id)
        if channel_id:
            clauses.append("channel_id=%s")
            parameters.append(channel_id)
        return ("WHERE " + " AND ".join(clauses) if clauses else "", tuple(parameters))

    @staticmethod
    def _summary(row) -> DiscordBotAnswerSummary:
        return DiscordBotAnswerSummary(
            answer_id=row[0], guild_id=row[1], guild_name=row[2], channel_id=row[3],
            channel_name=row[4], requester_id=row[5], requester_name=row[6],
            question=row[7], answer=row[8], status=row[9], basis=row[10],
            created_at=row[11],
        )

    @staticmethod
    def _detail_query() -> str:
        return """SELECT id,guild_id,guild_name,channel_id,channel_name,requester_id,
                         requester_name,question,answer,status,answer_basis,created_at,
                         trigger_message_id,trigger_type,parent_answer_id,chat_provider_id,
                         chat_model,reasoning_effort,retrieval_mode,evidence_character_limit,
                         recent_context,evidence,cited_evidence_ids,tool_activity,warnings,
                         error_code,trigger_at,completed_at
                  FROM discord_bot_answers WHERE id=%s"""

    @classmethod
    def _detail(cls, row, message_ids) -> DiscordBotAnswerDetail:
        summary = cls._summary(row[:12]).model_dump()
        return DiscordBotAnswerDetail(
            **summary, trigger_message_id=row[12], trigger_type=row[13],
            parent_answer_id=row[14], chat_provider_id=row[15], chat_model=row[16],
            reasoning_effort=row[17], retrieval_mode=row[18],
            evidence_character_limit=row[19], recent_context=row[20] or [],
            evidence=row[21] or [], cited_evidence_ids=row[22] or [],
            tool_activity=row[23] or [], warnings=row[24] or [], error_code=row[25],
            response_message_ids=message_ids, trigger_at=row[26], completed_at=row[27],
        )
