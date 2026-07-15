import logging
import uuid
from dataclasses import dataclass
from typing import Optional

import psycopg


LOGGER = logging.getLogger(__name__)
READ_MODEL_ADVISORY_LOCK = 1_812_199_103


@dataclass(frozen=True)
class RefreshClaim:
    projection_key: str
    projection_kind: str
    embedding_index_id: Optional[str]
    requested_revision: int
    failure_count: int


class PostgresReadModelRefresher:
    def __init__(
        self, database_dsn: str, debounce_seconds: int = 5,
        lease_seconds: int = 600,
    ) -> None:
        self.database_dsn = database_dsn
        self.debounce_seconds = debounce_seconds
        self.lease_seconds = lease_seconds
        self.worker_id = str(uuid.uuid4())

    def refresh_next(self) -> bool:
        with psycopg.connect(self.database_dsn, autocommit=True) as connection:
            if not self._try_global_lock(connection):
                return False
            try:
                claim = self._claim_next(connection)
                if not claim:
                    return False
                self._run_claim(connection, claim)
                return True
            finally:
                connection.execute(
                    "SELECT pg_advisory_unlock(%s)", (READ_MODEL_ADVISORY_LOCK,),
                )

    def _run_claim(self, connection, claim: RefreshClaim) -> None:
        try:
            with connection.transaction():
                connection.execute(
                    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
                )
                if claim.projection_kind == "archive":
                    self._refresh_archive(connection)
                elif claim.embedding_index_id:
                    self._refresh_index(connection, claim.embedding_index_id)
                self._complete(connection, claim)
        except psycopg.errors.SerializationFailure:
            LOGGER.info(
                "Read-model refresh superseded: projection=%s", claim.projection_key,
            )
            self._requeue_superseded(connection, claim)
        except Exception as error:
            LOGGER.exception(
                "Read-model refresh failed: projection=%s", claim.projection_key,
            )
            self._record_failure(connection, claim, error)

    def _requeue_superseded(self, connection, claim: RefreshClaim) -> None:
        connection.execute("""UPDATE read_model_refresh_state SET status='queued',
            next_attempt_at=NOW(),lease_owner=NULL,lease_expires_at=NULL,last_error=NULL
            WHERE projection_key=%s AND lease_owner=%s""",
            (claim.projection_key, self.worker_id),
        )

    def _claim_next(self, connection) -> Optional[RefreshClaim]:
        with connection.transaction():
            row = connection.execute(self._claim_sql(), (
                self.debounce_seconds, self.worker_id, self.lease_seconds,
            )).fetchone()
        return RefreshClaim(*row) if row else None

    @staticmethod
    def _claim_sql() -> str:
        return """WITH candidate AS (
            SELECT state.projection_key FROM read_model_refresh_state state
            LEFT JOIN rag_application_settings settings ON settings.id=1
            WHERE (state.status='queued'
                     AND state.requested_at<=NOW()-(%s * INTERVAL '1 second'))
               OR (state.status='failed' AND state.next_attempt_at<=NOW())
               OR (state.status='running' AND state.lease_expires_at<NOW())
            ORDER BY CASE WHEN state.projection_kind='archive' THEN 0
                          WHEN state.embedding_index_id=settings.active_embedding_index_id
                          THEN 1 ELSE 2 END,
                     state.requested_at,state.projection_key
            FOR UPDATE OF state SKIP LOCKED LIMIT 1
        )
        UPDATE read_model_refresh_state state
        SET status='running',lease_owner=%s,
            lease_expires_at=NOW()+(%s * INTERVAL '1 second')
        FROM candidate WHERE state.projection_key=candidate.projection_key
        RETURNING state.projection_key,state.projection_kind,
                  state.embedding_index_id,state.requested_revision,state.failure_count"""

    @staticmethod
    def _try_global_lock(connection) -> bool:
        return bool(connection.execute(
            "SELECT pg_try_advisory_lock(%s)", (READ_MODEL_ADVISORY_LOCK,),
        ).fetchone()[0])

    def _refresh_archive(self, connection) -> None:
        row = connection.execute("""SELECT COUNT(*),COUNT(DISTINCT content_hash),
            COUNT(DISTINCT author),COUNT(DISTINCT (source_type,
              COALESCE(conversation_id,channel_id,external_id))),
            MIN(sent_at),MAX(sent_at) FROM source_messages""").fetchone()
        connection.execute("""INSERT INTO workspace_read_summary
            (id,raw_message_count,unique_content_count,total_authors,total_conversations,
             oldest_message_at,newest_message_at,generated_at)
            VALUES (1,%s,%s,%s,%s,%s,%s,NOW())
            ON CONFLICT(id) DO UPDATE SET raw_message_count=EXCLUDED.raw_message_count,
              unique_content_count=EXCLUDED.unique_content_count,
              total_authors=EXCLUDED.total_authors,
              total_conversations=EXCLUDED.total_conversations,
              oldest_message_at=EXCLUDED.oldest_message_at,
              newest_message_at=EXCLUDED.newest_message_at,generated_at=NOW()""", row)
        self._replace_archive_breakdowns(connection)

    @staticmethod
    def _replace_archive_breakdowns(connection) -> None:
        connection.execute("DELETE FROM archive_breakdown_read_model")
        connection.execute("""INSERT INTO archive_breakdown_read_model
            (dimension,row_key,label,item_count)
            SELECT 'channels',source_type||':'||
              COALESCE(conversation_id,channel_id,external_id),
              COALESCE(MAX(conversation_label),MAX(channel),'Bez konverzace'),COUNT(*)
            FROM source_messages
            GROUP BY source_type,COALESCE(conversation_id,channel_id,external_id)""")
        connection.execute("""INSERT INTO archive_breakdown_read_model
            (dimension,row_key,label,item_count)
            SELECT 'authors',author,author,COUNT(*)
            FROM source_messages GROUP BY author""")

    def _refresh_index(self, connection, index_id: str) -> None:
        if not connection.execute(
            "SELECT 1 FROM embedding_indexes WHERE id=%s", (index_id,),
        ).fetchone():
            return
        counts = connection.execute("""SELECT
            (SELECT COUNT(*) FROM rag_chunks WHERE embedding_index_id=%s),
            (SELECT COUNT(DISTINCT message_id) FROM rag_chunk_messages
             WHERE embedding_index_id=%s),
            COALESCE((SELECT raw_message_count FROM workspace_read_summary WHERE id=1),
                     (SELECT COUNT(*) FROM source_messages))""",
            (index_id, index_id),
        ).fetchone()
        self._replace_scopes(connection, index_id)
        self._replace_breakdowns(connection, index_id)
        connection.execute("""INSERT INTO embedding_index_read_summary
            (embedding_index_id,chunk_count,indexed_message_count,
             pending_message_count,generated_at)
            VALUES (%s,%s,%s,GREATEST(%s-%s,0),NOW())
            ON CONFLICT(embedding_index_id) DO UPDATE SET
              chunk_count=EXCLUDED.chunk_count,
              indexed_message_count=EXCLUDED.indexed_message_count,
              pending_message_count=EXCLUDED.pending_message_count,
              generated_at=NOW()""",
            (index_id, counts[0], counts[1], counts[2], counts[1]),
        )

    @staticmethod
    def _replace_scopes(connection, index_id: str) -> None:
        connection.execute(
            "DELETE FROM chat_scope_read_model WHERE embedding_index_id=%s",
            (index_id,),
        )
        connection.execute("""INSERT INTO chat_scope_read_model
            (embedding_index_id,source_type,conversation_id,display_name,
             container_name,message_count)
            SELECT %s,message.source_type,message.conversation_id,
              COALESCE(MAX(message.conversation_label),MAX(message.channel),
                       'Unnamed conversation'),
              COALESCE(MAX(message.container_label),MAX(message.guild_id)),
              COUNT(DISTINCT message.external_id)
            FROM rag_chunk_messages link
            JOIN source_messages message ON message.external_id=link.message_id
            WHERE link.embedding_index_id=%s AND message.conversation_id IS NOT NULL
            GROUP BY message.source_type,message.conversation_id""", (index_id, index_id))

    @staticmethod
    def _replace_breakdowns(connection, index_id: str) -> None:
        connection.execute(
            "DELETE FROM database_breakdown_read_model WHERE embedding_index_id=%s",
            (index_id,),
        )
        connection.execute("""INSERT INTO database_breakdown_read_model
            (embedding_index_id,dimension,label,item_count)
            SELECT %s,'embedding-models',embedding_model,COUNT(*)
            FROM rag_chunks WHERE embedding_index_id=%s GROUP BY embedding_model""",
            (index_id, index_id),
        )

    def _complete(self, connection, claim: RefreshClaim) -> None:
        result = connection.execute("""UPDATE read_model_refresh_state SET
            published_revision=%s,
            status=CASE WHEN requested_revision>%s THEN 'queued' ELSE 'ready' END,
            next_attempt_at=NOW(),lease_owner=NULL,lease_expires_at=NULL,
            generated_at=NOW(),last_error=NULL,failure_count=0
            WHERE projection_key=%s AND lease_owner=%s""",
            (
                claim.requested_revision, claim.requested_revision,
                claim.projection_key, self.worker_id,
            ),
        )
        if result.rowcount != 1:
            raise RuntimeError("Read-model refresh lease was lost before publication.")

    def _record_failure(self, connection, claim: RefreshClaim, error: Exception) -> None:
        failure_count = claim.failure_count + 1
        retry_seconds = min(300, 5 * (2 ** min(failure_count - 1, 6)))
        connection.execute("""UPDATE read_model_refresh_state SET status='failed',
            next_attempt_at=NOW()+(%s * INTERVAL '1 second'),lease_owner=NULL,
            lease_expires_at=NULL,last_error=%s,failure_count=%s
            WHERE projection_key=%s AND lease_owner=%s""",
            (
                retry_seconds, str(error)[:1000], failure_count,
                claim.projection_key, self.worker_id,
            ),
        )
