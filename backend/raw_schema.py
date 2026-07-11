from typing import List


def raw_schema_statements() -> List[str]:
    return [
        """CREATE TABLE IF NOT EXISTS message_contents (
            content_hash TEXT PRIMARY KEY, content TEXT NOT NULL,
            occurrence_count BIGINT NOT NULL DEFAULT 0,
            search_vector TSVECTOR GENERATED ALWAYS AS
              (to_tsvector('simple', content)) STORED)""",
        """CREATE INDEX IF NOT EXISTS message_contents_search_gin
            ON message_contents USING gin(search_vector)""",
        """CREATE TABLE IF NOT EXISTS discord_messages (
            external_id TEXT PRIMARY KEY, message_order NUMERIC(20,0) NOT NULL,
            author TEXT NOT NULL, sent_at TIMESTAMPTZ, channel TEXT,
            channel_id TEXT, guild_id TEXT, content_hash TEXT NOT NULL
              REFERENCES message_contents(content_hash), updated_at TIMESTAMPTZ DEFAULT NOW())""",
        """CREATE INDEX IF NOT EXISTS discord_messages_channel_order
            ON discord_messages(channel_id, message_order)""",
        """CREATE TABLE IF NOT EXISTS ingestion_sessions (
            id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
            channel TEXT, status TEXT NOT NULL, raw_message_count BIGINT DEFAULT 0,
            created_at TIMESTAMPTZ DEFAULT NOW(), finished_at TIMESTAMPTZ)""",
        """CREATE TABLE IF NOT EXISTS ingestion_session_messages (
            session_id TEXT REFERENCES ingestion_sessions(id) ON DELETE CASCADE,
            message_id TEXT REFERENCES discord_messages(external_id) ON DELETE CASCADE,
            PRIMARY KEY(session_id,message_id))""",
        """CREATE TABLE IF NOT EXISTS indexing_jobs (
            id TEXT PRIMARY KEY, session_id TEXT UNIQUE REFERENCES ingestion_sessions(id),
            status TEXT NOT NULL, total_messages BIGINT DEFAULT 0,
            processed_messages BIGINT DEFAULT 0, stored_chunks BIGINT DEFAULT 0,
            last_error TEXT, created_at TIMESTAMPTZ DEFAULT NOW(),
            started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
            worker_id TEXT, lease_expires_at TIMESTAMPTZ)""",
        """ALTER TABLE indexing_jobs ADD COLUMN IF NOT EXISTS worker_id TEXT""",
        """ALTER TABLE indexing_jobs
            ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ""",
        """CREATE INDEX IF NOT EXISTS indexing_jobs_claimable
            ON indexing_jobs(status, lease_expires_at, created_at)""",
        """CREATE TABLE IF NOT EXISTS indexing_job_messages (
            job_id TEXT REFERENCES indexing_jobs(id) ON DELETE CASCADE,
            message_id TEXT REFERENCES discord_messages(external_id) ON DELETE CASCADE,
            PRIMARY KEY(job_id,message_id))""",
    ]
