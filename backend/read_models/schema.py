from typing import List


READ_MODEL_SCHEMA_VERSION = 1
ARCHIVE_PROJECTION_KEY = "archive"


def read_model_schema_statements() -> List[str]:
    return [
        _refresh_state_table(),
        _workspace_summary_table(),
        _index_summary_table(),
        _scope_table(),
        _breakdown_table(),
        _breakdown_order_index(),
        _seed_archive_state(),
        _seed_index_states(),
    ]


def _refresh_state_table() -> str:
    return """CREATE TABLE IF NOT EXISTS read_model_refresh_state (
        projection_key TEXT PRIMARY KEY,
        projection_kind TEXT NOT NULL CHECK(projection_kind IN ('archive','index')),
        embedding_index_id TEXT REFERENCES embedding_indexes(id) ON DELETE CASCADE,
        schema_version INTEGER NOT NULL DEFAULT 1,
        requested_revision BIGINT NOT NULL DEFAULT 1,
        published_revision BIGINT NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK(status IN ('queued','running','ready','failed')),
        requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        lease_owner TEXT,
        lease_expires_at TIMESTAMPTZ,
        generated_at TIMESTAMPTZ,
        last_error TEXT,
        failure_count INTEGER NOT NULL DEFAULT 0,
        CHECK((projection_kind='archive' AND embedding_index_id IS NULL)
          OR (projection_kind='index' AND embedding_index_id IS NOT NULL)))"""


def _workspace_summary_table() -> str:
    return """CREATE TABLE IF NOT EXISTS workspace_read_summary (
        id INTEGER PRIMARY KEY CHECK(id=1),
        raw_message_count BIGINT NOT NULL,
        unique_content_count BIGINT NOT NULL,
        total_authors BIGINT NOT NULL,
        total_conversations BIGINT NOT NULL,
        oldest_message_at TIMESTAMPTZ,
        newest_message_at TIMESTAMPTZ,
        generated_at TIMESTAMPTZ NOT NULL)"""


def _index_summary_table() -> str:
    return """CREATE TABLE IF NOT EXISTS embedding_index_read_summary (
        embedding_index_id TEXT PRIMARY KEY REFERENCES embedding_indexes(id) ON DELETE CASCADE,
        chunk_count BIGINT NOT NULL,
        indexed_message_count BIGINT NOT NULL,
        pending_message_count BIGINT NOT NULL,
        generated_at TIMESTAMPTZ NOT NULL)"""


def _scope_table() -> str:
    return """CREATE TABLE IF NOT EXISTS chat_scope_read_model (
        embedding_index_id TEXT NOT NULL REFERENCES embedding_indexes(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        container_name TEXT,
        message_count BIGINT NOT NULL,
        PRIMARY KEY(embedding_index_id,source_type,conversation_id))"""


def _breakdown_table() -> str:
    return """CREATE TABLE IF NOT EXISTS database_breakdown_read_model (
        embedding_index_id TEXT NOT NULL REFERENCES embedding_indexes(id) ON DELETE CASCADE,
        dimension TEXT NOT NULL CHECK(dimension IN ('channels','authors','embedding-models')),
        label TEXT NOT NULL,
        item_count BIGINT NOT NULL,
        PRIMARY KEY(embedding_index_id,dimension,label))"""


def _breakdown_order_index() -> str:
    return """CREATE INDEX IF NOT EXISTS database_breakdown_read_model_order
        ON database_breakdown_read_model
        (embedding_index_id,dimension,item_count DESC,label)"""


def _seed_archive_state() -> str:
    return f"""INSERT INTO read_model_refresh_state
        (projection_key,projection_kind,schema_version,requested_at)
        VALUES ('{ARCHIVE_PROJECTION_KEY}','archive',{READ_MODEL_SCHEMA_VERSION},
                NOW()-INTERVAL '5 seconds')
        ON CONFLICT(projection_key) DO NOTHING"""


def _seed_index_states() -> str:
    return f"""INSERT INTO read_model_refresh_state
        (projection_key,projection_kind,embedding_index_id,schema_version,requested_at)
        SELECT 'index:'||id,'index',id,{READ_MODEL_SCHEMA_VERSION},
               NOW()-INTERVAL '5 seconds' FROM embedding_indexes
        ON CONFLICT(projection_key) DO NOTHING"""
