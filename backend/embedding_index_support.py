import logging
import uuid
from typing import Optional

from backend.models import EmbeddingIndexView
from backend.read_models.metadata import SANITIZED_REFRESH_ERROR


DEFAULT_INDEX_ID = "default-openai"
LOGGER = logging.getLogger(__name__)


def create_index_tables(connection, default_model: str, default_dimensions: int) -> None:
    connection.execute("""CREATE TABLE IF NOT EXISTS embedding_indexes (
        id TEXT PRIMARY KEY,name TEXT NOT NULL,provider_id TEXT NOT NULL,model TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK(dimensions BETWEEN 1 AND 4000),
        requested_dimensions INTEGER,status TEXT NOT NULL,auto_sync BOOLEAN NOT NULL DEFAULT TRUE,
        last_error TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW())""")
    connection.execute(
        """INSERT INTO embedding_indexes
           (id,name,provider_id,model,dimensions,requested_dimensions,status,auto_sync)
           VALUES (%s,'Default OpenAI index','openai',%s,%s,%s,'ready',TRUE)
           ON CONFLICT(id) DO NOTHING""",
        (DEFAULT_INDEX_ID, default_model, default_dimensions, default_dimensions),
    )
    connection.execute("""CREATE TABLE IF NOT EXISTS rag_application_settings (
        id INTEGER PRIMARY KEY CHECK(id=1),active_embedding_index_id TEXT
        REFERENCES embedding_indexes(id) ON DELETE SET NULL,
        timezone_name TEXT NOT NULL DEFAULT 'UTC')""")
    connection.execute("""ALTER TABLE rag_application_settings
        ADD COLUMN IF NOT EXISTS timezone_name TEXT NOT NULL DEFAULT 'UTC'""")
    connection.execute(
        "INSERT INTO rag_application_settings(id,active_embedding_index_id) VALUES(1,%s) "
        "ON CONFLICT(id) DO NOTHING", (DEFAULT_INDEX_ID,),
    )


def migrate_index_jobs(connection) -> None:
    connection.execute("ALTER TABLE indexing_jobs ADD COLUMN IF NOT EXISTS embedding_index_id TEXT")
    connection.execute("ALTER TABLE indexing_jobs ADD COLUMN IF NOT EXISTS job_type TEXT DEFAULT 'incremental'")
    connection.execute(
        "UPDATE indexing_jobs SET embedding_index_id=%s WHERE embedding_index_id IS NULL",
        (DEFAULT_INDEX_ID,),
    )
    connection.execute("ALTER TABLE indexing_jobs ALTER COLUMN embedding_index_id SET NOT NULL")
    connection.execute("ALTER TABLE indexing_jobs DROP CONSTRAINT IF EXISTS indexing_jobs_session_id_key")
    connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS indexing_jobs_session_index_unique "
                       "ON indexing_jobs(session_id,embedding_index_id)")
    connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS indexing_jobs_active_sync_unique "
                       "ON indexing_jobs(embedding_index_id) WHERE job_type='sync' "
                       "AND status IN ('queued','running')")
    connection.execute("CREATE INDEX IF NOT EXISTS indexing_job_messages_message "
                       "ON indexing_job_messages(message_id,job_id)")
    connection.execute("""DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid='indexing_jobs'::regclass AND contype='f'
            AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (embedding_index_id)%') THEN
          ALTER TABLE indexing_jobs ADD CONSTRAINT indexing_jobs_embedding_index_fkey
          FOREIGN KEY(embedding_index_id) REFERENCES embedding_indexes(id) ON DELETE CASCADE;
        END IF; END $$""")


def queue_all_messages(connection, index_id: str, job_type: str) -> Optional[str]:
    return queue_messages(connection, index_id, job_type, "TRUE")


def queue_missing_messages(connection, index_id: str) -> Optional[str]:
    condition = "NOT EXISTS (SELECT 1 FROM rag_chunk_messages link WHERE " \
                "link.embedding_index_id=%s AND link.message_id=message.external_id) " \
                "AND NOT EXISTS (SELECT 1 FROM ingestion_session_messages pending " \
                "JOIN indexing_jobs job ON job.session_id=pending.session_id WHERE " \
                "pending.message_id=message.external_id AND job.embedding_index_id=%s " \
                "AND job.status IN ('queued','running'))"
    return queue_messages(
        connection, index_id, "sync", condition, (index_id, index_id),
    )


def queue_messages(
    connection, index_id: str, job_type: str, condition: str,
    condition_parameters: tuple = (),
) -> Optional[str]:
    session_id, job_id = str(uuid.uuid4()), str(uuid.uuid4())
    connection.execute("""INSERT INTO ingestion_sessions
        (id,source_type,conversation_id,conversation_label,status,finished_at)
        VALUES(%s,'maintenance',%s,'Embedding index maintenance','completed',NOW())""",
        (session_id, index_id))
    query = "INSERT INTO ingestion_session_messages(session_id,message_id) " \
            f"SELECT %s,message.external_id FROM source_messages message WHERE {condition}"
    inserted = connection.execute(query, (session_id, *condition_parameters)).rowcount
    if not inserted:
        connection.execute("DELETE FROM ingestion_sessions WHERE id=%s", (session_id,))
        return None
    connection.execute(
        "UPDATE ingestion_sessions SET raw_message_count=%s WHERE id=%s",
        (inserted, session_id),
    )
    connection.execute("""INSERT INTO indexing_jobs
        (id,session_id,embedding_index_id,job_type,status,total_messages)
        VALUES(%s,%s,%s,%s,'queued',%s)""",
        (job_id, session_id, index_id, job_type, inserted))
    LOGGER.info(
        "Indexing job queued: job_id=%s index_id=%s type=%s messages=%s",
        job_id, index_id, job_type, inserted,
    )
    return job_id


def assert_no_active_job(connection, index_id: str) -> None:
    active = connection.execute(
        """SELECT 1 FROM indexing_jobs WHERE embedding_index_id=%s
           AND status IN ('queued','running') LIMIT 1""", (index_id,),
    ).fetchone()
    if active:
        raise ValueError("This embedding index already has an active job.")


def index_view_sql() -> str:
    return """SELECT idx.id,idx.name,idx.provider_id,idx.model,idx.dimensions,
      idx.requested_dimensions,idx.status,idx.auto_sync,
      COALESCE(summary.chunk_count,0),COALESCE(summary.pending_message_count,0),
      idx.last_error,
      (SELECT job.id FROM indexing_jobs job WHERE job.embedding_index_id=idx.id
       AND job.status IN ('queued','running') ORDER BY job.created_at LIMIT 1),
      idx.created_at,idx.updated_at,
      summary.embedding_index_id IS NOT NULL AND state.published_revision>0,
      state.generated_at,
      state.projection_key IS NULL OR state.requested_revision>state.published_revision
        OR state.status<>'ready',
      state.projection_key IS NULL OR state.status IN ('queued','running'),
      state.last_error IS NOT NULL
      FROM embedding_indexes idx
      LEFT JOIN embedding_index_read_summary summary ON summary.embedding_index_id=idx.id
      LEFT JOIN read_model_refresh_state state ON state.embedding_index_id=idx.id"""


def embedding_index_view(row) -> EmbeddingIndexView:
    return EmbeddingIndexView(
        embedding_index_id=row[0], name=row[1], provider_id=row[2], model=row[3],
        dimensions=row[4], requested_dimensions=row[5], status=row[6],
        auto_sync=row[7], chunk_count=row[8], pending_message_count=row[9],
        last_error=row[10], active_job_id=row[11], created_at=row[12], updated_at=row[13],
        summary_ready=bool(row[14]), summary_generated_at=row[15],
        summary_is_stale=bool(row[16]), summary_refreshing=bool(row[17]),
        summary_error=SANITIZED_REFRESH_ERROR if row[18] else None,
    )
