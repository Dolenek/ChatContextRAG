from typing import List


def raw_schema_statements(
    default_embedding_model: str = "text-embedding-3-small",
    default_embedding_dimensions: int = 1536,
) -> List[str]:
    dimensions = _validated_dimensions(default_embedding_dimensions)
    return (
        _message_schema_statements() + _session_schema_statements()
        + _embedding_schema_statements(default_embedding_model, dimensions)
        + _job_schema_statements()
        + _integration_schema_statements()
        + chat_session_schema_statements()
    )


def _validated_dimensions(dimensions: int) -> int:
    parsed_dimensions = int(dimensions)
    if not 1 <= parsed_dimensions <= 4000:
        raise ValueError("Default embedding dimensions must be between 1 and 4000.")
    return parsed_dimensions


def _sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _message_schema_statements() -> List[str]:
    return [
        """DO $$ BEGIN
            IF to_regclass('source_messages') IS NULL
               AND to_regclass('discord_messages') IS NOT NULL THEN
                ALTER TABLE discord_messages RENAME TO source_messages;
            END IF;
        END $$""",
        """CREATE TABLE IF NOT EXISTS message_contents (
            content_hash TEXT PRIMARY KEY, content TEXT NOT NULL,
            occurrence_count BIGINT NOT NULL DEFAULT 0,
            search_vector TSVECTOR GENERATED ALWAYS AS
              (to_tsvector('simple', content)) STORED)""",
        """CREATE INDEX IF NOT EXISTS message_contents_search_gin
            ON message_contents USING gin(search_vector)""",
        """CREATE TABLE IF NOT EXISTS source_messages (
            external_id TEXT PRIMARY KEY, message_order NUMERIC(20,0) NOT NULL,
            author TEXT NOT NULL, sent_at TIMESTAMPTZ, channel TEXT,
            channel_id TEXT, guild_id TEXT, source_type TEXT NOT NULL DEFAULT 'discord',
            conversation_id TEXT, conversation_label TEXT, container_id TEXT,
            container_label TEXT, source_metadata JSONB NOT NULL DEFAULT '{}',
            content_hash TEXT NOT NULL REFERENCES message_contents(content_hash),
            updated_at TIMESTAMPTZ DEFAULT NOW())""",
        """ALTER TABLE source_messages
            ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'discord'""",
        """ALTER TABLE source_messages ADD COLUMN IF NOT EXISTS conversation_id TEXT""",
        """ALTER TABLE source_messages ADD COLUMN IF NOT EXISTS conversation_label TEXT""",
        """ALTER TABLE source_messages ADD COLUMN IF NOT EXISTS container_id TEXT""",
        """ALTER TABLE source_messages ADD COLUMN IF NOT EXISTS container_label TEXT""",
        """ALTER TABLE source_messages
            ADD COLUMN IF NOT EXISTS source_metadata JSONB NOT NULL DEFAULT '{}'""",
        """UPDATE source_messages SET conversation_id=COALESCE(conversation_id,channel_id),
            conversation_label=COALESCE(conversation_label,channel),
            container_id=COALESCE(container_id,guild_id)""",
        """CREATE INDEX IF NOT EXISTS source_messages_conversation_order
            ON source_messages(source_type,conversation_id,message_order)""",
        """CREATE INDEX IF NOT EXISTS source_messages_content_order
            ON source_messages(content_hash,message_order)""",
        """CREATE INDEX IF NOT EXISTS source_messages_global_order
            ON source_messages(message_order,external_id)""",
    ]


def _session_schema_statements() -> List[str]:
    return [
        """CREATE TABLE IF NOT EXISTS ingestion_sessions (
            id TEXT PRIMARY KEY, guild_id TEXT, channel_id TEXT, channel TEXT,
            source_type TEXT NOT NULL DEFAULT 'discord', conversation_id TEXT,
            conversation_label TEXT, container_id TEXT, container_label TEXT,
            status TEXT NOT NULL, raw_message_count BIGINT DEFAULT 0,
            created_at TIMESTAMPTZ DEFAULT NOW(), finished_at TIMESTAMPTZ)""",
        """ALTER TABLE ingestion_sessions
            ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'discord'""",
        """ALTER TABLE ingestion_sessions ADD COLUMN IF NOT EXISTS conversation_id TEXT""",
        """ALTER TABLE ingestion_sessions ADD COLUMN IF NOT EXISTS conversation_label TEXT""",
        """ALTER TABLE ingestion_sessions ADD COLUMN IF NOT EXISTS container_id TEXT""",
        """ALTER TABLE ingestion_sessions ADD COLUMN IF NOT EXISTS container_label TEXT""",
        """DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='ingestion_sessions'
                         AND column_name='guild_id' AND is_nullable='NO') THEN
                ALTER TABLE ingestion_sessions ALTER COLUMN guild_id DROP NOT NULL;
            END IF;
            IF EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='ingestion_sessions'
                         AND column_name='channel_id' AND is_nullable='NO') THEN
                ALTER TABLE ingestion_sessions ALTER COLUMN channel_id DROP NOT NULL;
            END IF;
        END $$""",
        """UPDATE ingestion_sessions SET conversation_id=COALESCE(conversation_id,channel_id),
            conversation_label=COALESCE(conversation_label,channel),
            container_id=COALESCE(container_id,guild_id)""",
        """CREATE TABLE IF NOT EXISTS ingestion_session_messages (
            session_id TEXT REFERENCES ingestion_sessions(id) ON DELETE CASCADE,
            message_id TEXT REFERENCES source_messages(external_id) ON DELETE CASCADE,
            PRIMARY KEY(session_id,message_id))""",
    ]


def _embedding_schema_statements(model: str, dimensions: int) -> List[str]:
    model_literal = _sql_literal(model)
    return [
        """CREATE TABLE IF NOT EXISTS embedding_indexes (
            id TEXT PRIMARY KEY,name TEXT NOT NULL,provider_id TEXT NOT NULL,model TEXT NOT NULL,
            dimensions INTEGER NOT NULL CHECK(dimensions BETWEEN 1 AND 4000),
            requested_dimensions INTEGER,status TEXT NOT NULL,auto_sync BOOLEAN NOT NULL DEFAULT TRUE,
            last_error TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW())""",
        """CREATE TABLE IF NOT EXISTS rag_application_settings (
            id INTEGER PRIMARY KEY CHECK(id=1),active_embedding_index_id TEXT
            REFERENCES embedding_indexes(id) ON DELETE SET NULL)""",
        f"""INSERT INTO embedding_indexes
            (id,name,provider_id,model,dimensions,requested_dimensions,status,auto_sync)
            VALUES ('default-openai','Default OpenAI index','openai',
                    {model_literal},{dimensions},{dimensions},'ready',TRUE)
            ON CONFLICT(id) DO NOTHING""",
        """INSERT INTO rag_application_settings(id,active_embedding_index_id)
            VALUES(1,'default-openai') ON CONFLICT(id) DO NOTHING""",
    ]


def _job_schema_statements() -> List[str]:
    return [
        """CREATE TABLE IF NOT EXISTS indexing_jobs (
            id TEXT PRIMARY KEY, session_id TEXT REFERENCES ingestion_sessions(id),
            embedding_index_id TEXT NOT NULL REFERENCES embedding_indexes(id) ON DELETE CASCADE,
            job_type TEXT NOT NULL DEFAULT 'incremental',
            status TEXT NOT NULL, total_messages BIGINT DEFAULT 0,
            processed_messages BIGINT DEFAULT 0, stored_chunks BIGINT DEFAULT 0,
            last_error TEXT, created_at TIMESTAMPTZ DEFAULT NOW(),
            started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
            worker_id TEXT, lease_expires_at TIMESTAMPTZ)""",
        """ALTER TABLE indexing_jobs ADD COLUMN IF NOT EXISTS embedding_index_id TEXT""",
        """ALTER TABLE indexing_jobs ADD COLUMN IF NOT EXISTS job_type TEXT DEFAULT 'incremental'""",
        """UPDATE indexing_jobs SET embedding_index_id='default-openai'
            WHERE embedding_index_id IS NULL""",
        """ALTER TABLE indexing_jobs ALTER COLUMN embedding_index_id SET NOT NULL""",
        """ALTER TABLE indexing_jobs DROP CONSTRAINT IF EXISTS indexing_jobs_session_id_key""",
        """CREATE UNIQUE INDEX IF NOT EXISTS indexing_jobs_session_index_unique
            ON indexing_jobs(session_id,embedding_index_id)""",
        """ALTER TABLE indexing_jobs ADD COLUMN IF NOT EXISTS worker_id TEXT""",
        """ALTER TABLE indexing_jobs
            ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ""",
        """CREATE INDEX IF NOT EXISTS indexing_jobs_claimable
            ON indexing_jobs(status, lease_expires_at, created_at)""",
        """CREATE UNIQUE INDEX IF NOT EXISTS indexing_jobs_active_sync_unique
            ON indexing_jobs(embedding_index_id)
            WHERE job_type='sync' AND status IN ('queued','running')""",
        """CREATE TABLE IF NOT EXISTS indexing_job_messages (
            job_id TEXT REFERENCES indexing_jobs(id) ON DELETE CASCADE,
            message_id TEXT REFERENCES source_messages(external_id) ON DELETE CASCADE,
            PRIMARY KEY(job_id,message_id))""",
        """CREATE INDEX IF NOT EXISTS indexing_job_messages_message
            ON indexing_job_messages(message_id,job_id)""",
    ]


def _integration_schema_statements() -> List[str]:
    return [
        """CREATE TABLE IF NOT EXISTS integration_sync_states (
            source_type TEXT NOT NULL, conversation_id TEXT NOT NULL,
            container_id TEXT, conversation_label TEXT, container_label TEXT,
            oldest_cursor TEXT, newest_cursor TEXT, backfill_complete BOOLEAN DEFAULT FALSE,
            active_session_id TEXT, tracking_enabled BOOLEAN DEFAULT TRUE, last_error TEXT,
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            PRIMARY KEY(source_type,conversation_id))""",
        """ALTER TABLE integration_sync_states
            ADD COLUMN IF NOT EXISTS active_session_id TEXT""",
    ]


def chat_session_schema_statements() -> List[str]:
    return [
        """CREATE TABLE IF NOT EXISTS chat_sessions (
            id TEXT PRIMARY KEY,title TEXT NOT NULL,source_type TEXT,
            conversation_id TEXT,chat_provider_id TEXT,chat_model TEXT,
            reasoning_effort TEXT,
            retrieval_mode TEXT NOT NULL DEFAULT 'deterministic',
            evidence_character_limit INTEGER,
            title_manually_edited BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())""",
        """CREATE TABLE IF NOT EXISTS chat_session_messages (
            session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
            position INTEGER NOT NULL,role TEXT NOT NULL CHECK(role IN ('user','assistant')),
            content TEXT NOT NULL,sources JSONB NOT NULL DEFAULT '[]',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY(session_id,position))""",
        """ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS reasoning_effort TEXT""",
        """ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS retrieval_mode TEXT
            NOT NULL DEFAULT 'deterministic'""",
        """ALTER TABLE chat_sessions
            ADD COLUMN IF NOT EXISTS evidence_character_limit INTEGER""",
        """CREATE INDEX IF NOT EXISTS chat_sessions_recent
            ON chat_sessions(updated_at DESC,id)""",
    ]
