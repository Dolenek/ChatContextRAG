import threading
from typing import Callable, Optional

import psycopg

from backend.read_models.schema import (
    ARCHIVE_PROJECTION_KEY, READ_MODEL_SCHEMA_VERSION,
    read_model_schema_statements,
)


class PostgresReadModelStore:
    def __init__(self, database_dsn: str) -> None:
        self.database_dsn = database_dsn
        self._initialized = False
        self._lock = threading.Lock()
        self._wake_callback: Callable[[], None] = lambda: None

    def ensure_schema(self) -> None:
        if self._initialized:
            return
        with self._lock:
            if self._initialized:
                return
            with psycopg.connect(self.database_dsn, autocommit=True) as connection:
                for statement in read_model_schema_statements():
                    connection.execute(statement)
                self._queue_outdated_schema(connection)
            self._initialized = True

    def set_wake_callback(self, callback: Callable[[], None]) -> None:
        self._wake_callback = callback

    def invalidate_all(self, connection, immediate: bool = False) -> None:
        self._ensure_index_states(connection)
        connection.execute(
            self._invalidate_sql("TRUE"), self._invalidate_parameters(immediate),
        )
        self._wake_callback()

    def invalidate_index(
        self, connection, index_id: str, immediate: bool = False,
    ) -> None:
        self.ensure_index_state(connection, index_id)
        connection.execute(
            self._invalidate_sql("projection_key=%s"),
            (*self._invalidate_parameters(immediate), f"index:{index_id}"),
        )
        self._wake_callback()

    def ensure_index_state(self, connection, index_id: str) -> None:
        connection.execute(
            """INSERT INTO read_model_refresh_state
               (projection_key,projection_kind,embedding_index_id,schema_version,
                requested_at)
               VALUES (%s,'index',%s,%s,NOW()-INTERVAL '5 seconds')
               ON CONFLICT(projection_key) DO NOTHING""",
            (f"index:{index_id}", index_id, READ_MODEL_SCHEMA_VERSION),
        )

    def request_refresh(self, scope: str) -> None:
        self.ensure_schema()
        with psycopg.connect(self.database_dsn) as connection:
            if scope == "active":
                self._invalidate_active(connection)
            elif scope == "all":
                self.invalidate_all(connection, immediate=True)
            else:
                raise ValueError("Unsupported read-model refresh scope.")
        self._wake_callback()

    def reset(self, connection) -> None:
        self._ensure_index_states(connection)
        connection.execute("DELETE FROM chat_scope_read_model")
        connection.execute("DELETE FROM archive_breakdown_read_model")
        connection.execute("DELETE FROM database_breakdown_read_model")
        connection.execute("DELETE FROM embedding_index_read_summary")
        connection.execute("""INSERT INTO workspace_read_summary
            (id,raw_message_count,unique_content_count,total_authors,total_conversations,
             oldest_message_at,newest_message_at,generated_at)
            VALUES (1,0,0,0,0,NULL,NULL,NOW())
            ON CONFLICT(id) DO UPDATE SET raw_message_count=0,unique_content_count=0,
              total_authors=0,total_conversations=0,oldest_message_at=NULL,
              newest_message_at=NULL,generated_at=NOW()""")
        connection.execute("""INSERT INTO embedding_index_read_summary
            (embedding_index_id,chunk_count,indexed_message_count,
             pending_message_count,generated_at)
            SELECT id,0,0,0,NOW() FROM embedding_indexes""")
        connection.execute("""UPDATE read_model_refresh_state
            SET requested_revision=requested_revision+1,
                published_revision=requested_revision+1,status='ready',
                requested_at=NOW(),next_attempt_at=NOW(),generated_at=NOW(),
                lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,failure_count=0""")

    def _invalidate_active(self, connection) -> None:
        connection.execute(
            self._invalidate_sql(
                "projection_key=%s OR embedding_index_id=(SELECT "
                "active_embedding_index_id FROM rag_application_settings WHERE id=1)"
            ),
            (*self._invalidate_parameters(True), ARCHIVE_PROJECTION_KEY),
        )

    @staticmethod
    def _invalidate_sql(condition: str) -> str:
        return f"""UPDATE read_model_refresh_state
            SET requested_revision=requested_revision+1,
                status=CASE WHEN status='running' THEN status ELSE 'queued' END,
                requested_at=NOW()-(%s * INTERVAL '1 second'),next_attempt_at=NOW(),
                last_error=NULL,failure_count=CASE WHEN status='failed' THEN 0
                                                  ELSE failure_count END
            WHERE {condition}"""

    @staticmethod
    def _invalidate_parameters(immediate: bool) -> tuple:
        return (5 if immediate else 0,)

    @staticmethod
    def _ensure_index_states(connection) -> None:
        connection.execute(
            """INSERT INTO read_model_refresh_state
               (projection_key,projection_kind,embedding_index_id,schema_version)
               SELECT 'index:'||id,'index',id,%s FROM embedding_indexes
               ON CONFLICT(projection_key) DO NOTHING""",
            (READ_MODEL_SCHEMA_VERSION,),
        )

    @staticmethod
    def _queue_outdated_schema(connection) -> None:
        connection.execute(
            """UPDATE read_model_refresh_state SET schema_version=%s,
               requested_revision=requested_revision+1,published_revision=0,
               status='queued',requested_at=NOW()-INTERVAL '5 seconds',
               next_attempt_at=NOW(),generated_at=NULL,lease_owner=NULL,
               lease_expires_at=NULL,last_error=NULL
               WHERE schema_version<>%s AND projection_kind='archive'""",
            (READ_MODEL_SCHEMA_VERSION, READ_MODEL_SCHEMA_VERSION),
        )
        connection.execute(
            """UPDATE read_model_refresh_state SET schema_version=%s
               WHERE schema_version<>%s AND projection_kind='index'""",
            (READ_MODEL_SCHEMA_VERSION, READ_MODEL_SCHEMA_VERSION),
        )
