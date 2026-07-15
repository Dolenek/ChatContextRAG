from dataclasses import dataclass
from datetime import datetime
from typing import Callable, List, Literal, Optional, Sequence

import psycopg

from backend.archive_time import ArchiveTimeRange
from backend.chat_models import ChatScope
from backend.openai_gateway import ExternalIntegrationError
from backend.vector_models import NormalizedMessage


TextMatchMode = Literal["whole_term", "term_prefix", "token_phrase"]
TextOperator = Literal["all", "any"]
TextSort = Literal["oldest", "newest"]


@dataclass(frozen=True)
class ArchiveTextSearchResult:
    messages: List[NormalizedMessage]
    chronology_complete: bool
    ordering_basis: Literal["source_order", "timestamp"]


class PostgresArchiveTextSearch:
    def __init__(self, ensure_schema: Callable, connect: Callable) -> None:
        self.ensure_schema = ensure_schema
        self.connect = connect

    def search(
        self, patterns: Sequence[str], match_mode: TextMatchMode,
        operator: TextOperator, sort: TextSort, limit: int,
        scope: Optional[ChatScope] = None,
        time_range: Optional[ArchiveTimeRange] = None,
        excluded_message_ids: Sequence[str] = (),
        maximum_timestamp: Optional[datetime] = None,
    ) -> ArchiveTextSearchResult:
        self.ensure_schema()
        from_where, parameters = self._from_where(
            patterns, match_mode, operator, scope, time_range,
            excluded_message_ids, maximum_timestamp,
        )
        ordering_basis = "source_order" if scope else "timestamp"
        query = self._search_query(from_where, scope, sort)
        try:
            with self.connect() as connection:
                connection.execute("SET LOCAL statement_timeout='10s'")
                rows = connection.execute(query, (*parameters, limit)).fetchall()
                chronology_complete = self._chronology_complete(
                    connection, from_where, parameters, scope,
                )
        except psycopg.Error as error:
            raise ExternalIntegrationError(
                "PostgreSQL archive text search failed."
            ) from error
        return ArchiveTextSearchResult(
            [self._message(row) for row in rows],
            chronology_complete, ordering_basis,
        )

    def _from_where(
        self, patterns, match_mode, operator, scope, time_range,
        excluded_message_ids, maximum_timestamp,
    ) -> tuple[str, tuple]:
        content_condition = self._content_condition(
            len(patterns), match_mode, operator,
        )
        source_type = scope.source_type if scope else None
        conversation_id = scope.conversation_id if scope else None
        start_at = time_range.start_at if time_range else None
        end_at = time_range.end_at if time_range else None
        fragment = f"""FROM source_messages m
            JOIN message_contents c ON c.content_hash=m.content_hash
            WHERE {content_condition}
              AND (%s::text IS NULL OR m.source_type=%s)
              AND (%s::text IS NULL OR m.conversation_id=%s)
              AND (%s::timestamptz IS NULL OR m.sent_at>=%s)
              AND (%s::timestamptz IS NULL OR m.sent_at<%s)
              AND m.external_id<>ALL(%s::text[])
              AND (%s::timestamptz IS NULL OR
                   (m.sent_at IS NOT NULL AND m.sent_at<%s))"""
        parameters = (
            *patterns, source_type, source_type, conversation_id, conversation_id,
            start_at, start_at, end_at, end_at, list(excluded_message_ids),
            maximum_timestamp, maximum_timestamp,
        )
        return fragment, parameters

    @classmethod
    def _content_condition(
        cls, pattern_count: int, match_mode: TextMatchMode, operator: TextOperator,
    ) -> str:
        expression = cls._query_expression(match_mode)
        conjunction = " AND " if operator == "all" else " OR "
        return "(" + conjunction.join(
            f"c.search_vector @@ {expression}" for _ in range(pattern_count)
        ) + ")"

    @staticmethod
    def _query_expression(match_mode: TextMatchMode) -> str:
        if match_mode == "whole_term":
            return "plainto_tsquery('simple',%s)"
        if match_mode == "token_phrase":
            return "phraseto_tsquery('simple',%s)"
        return """(SELECT to_tsquery(
            'simple', string_agg(quote_literal(lexeme)||':*',' & ' ORDER BY lexeme))
            FROM unnest(tsvector_to_array(to_tsvector('simple',%s)))
                 AS tokens(lexeme))"""

    @classmethod
    def _search_query(cls, from_where: str, scope, sort: TextSort) -> str:
        direction = "ASC" if sort == "oldest" else "DESC"
        if scope:
            order = f"m.message_order {direction},m.external_id {direction}"
        else:
            order = (
                f"m.sent_at {direction} NULLS LAST,m.source_type {direction},"
                f"m.conversation_id {direction},m.message_order {direction},"
                f"m.external_id {direction}"
            )
        return f"""SELECT {cls._columns()} {from_where}
            ORDER BY {order} LIMIT %s"""

    @staticmethod
    def _chronology_complete(connection, from_where, parameters, scope) -> bool:
        if scope:
            return True
        row = connection.execute(
            f"SELECT EXISTS(SELECT 1 {from_where} AND m.sent_at IS NULL LIMIT 1)",
            parameters,
        ).fetchone()
        return not bool(row and row[0])

    @staticmethod
    def _columns() -> str:
        return """m.external_id,m.author,c.content,m.sent_at,m.channel,
            m.channel_id,m.guild_id,m.source_type,m.conversation_id,
            m.conversation_label,m.container_id,m.container_label,
            m.source_metadata,m.message_order"""

    @staticmethod
    def _message(row) -> NormalizedMessage:
        return NormalizedMessage(*row[:13], message_order=int(row[13]))
