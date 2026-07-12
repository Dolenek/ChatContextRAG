def queue_job_sql() -> str:
    return """INSERT INTO indexing_jobs
        (id,session_id,embedding_index_id,status,total_messages)
        VALUES (%s,%s,%s,'queued',%s) ON CONFLICT (session_id,embedding_index_id) DO UPDATE SET
        status='queued', total_messages=EXCLUDED.total_messages, processed_messages=0,
        stored_chunks=0, last_error=NULL, started_at=NULL, finished_at=NULL,
        worker_id=NULL, lease_expires_at=NULL"""


def snapshot_messages_sql() -> str:
    return """INSERT INTO indexing_job_messages(job_id,message_id)
        WITH session_ids AS (
          SELECT session_message.message_id
          FROM ingestion_session_messages session_message
          JOIN source_messages source ON source.external_id=session_message.message_id
          WHERE session_message.session_id=%s AND (
            NOT EXISTS (SELECT 1 FROM rag_chunk_messages link
              WHERE link.embedding_index_id=(
                SELECT embedding_index_id FROM indexing_jobs WHERE id=%s)
                AND link.message_id=session_message.message_id)
            OR EXISTS (SELECT 1 FROM rag_chunk_messages link
              JOIN rag_chunks chunk ON chunk.embedding_index_id=link.embedding_index_id
                AND chunk.id=link.chunk_id
              WHERE link.embedding_index_id=(
                SELECT embedding_index_id FROM indexing_jobs WHERE id=%s)
                AND link.message_id=session_message.message_id
                AND chunk.updated_at<source.updated_at))),
        affected AS (SELECT chunk_id FROM rag_chunk_messages
          WHERE embedding_index_id=(SELECT embedding_index_id FROM indexing_jobs WHERE id=%s)
            AND message_id IN (SELECT message_id FROM session_ids)),
        targets AS (SELECT message_id FROM session_ids UNION SELECT message_id
          FROM rag_chunk_messages WHERE embedding_index_id=(
            SELECT embedding_index_id FROM indexing_jobs WHERE id=%s)
            AND chunk_id IN (SELECT chunk_id FROM affected))
        SELECT %s,message_id FROM targets ON CONFLICT DO NOTHING"""


def select_jobs_sql(condition: str) -> str:
    return f"""SELECT id,session_id,status,total_messages,processed_messages,
               stored_chunks,last_error,started_at,finished_at,created_at,
               embedding_index_id,(SELECT name FROM embedding_indexes index
                 WHERE index.id=indexing_jobs.embedding_index_id),job_type,
               (SELECT CASE WHEN guild_id='__maintenance__' THEN 'maintenance'
                 ELSE source_type END FROM ingestion_sessions session
                 WHERE session.id=indexing_jobs.session_id),
               (SELECT COALESCE(conversation_label,channel,conversation_id,channel_id)
                 FROM ingestion_sessions session WHERE session.id=indexing_jobs.session_id),
               (SELECT COALESCE(container_label,container_id)
                 FROM ingestion_sessions session WHERE session.id=indexing_jobs.session_id)
               FROM indexing_jobs WHERE {condition}"""


def claimable_job_sql() -> str:
    return """SELECT id FROM indexing_jobs
        WHERE status='queued' OR (status='running' AND
          (lease_expires_at IS NULL OR lease_expires_at<=NOW()))
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1"""


def claim_job_sql() -> str:
    return """WITH claimed AS (
        UPDATE indexing_jobs SET status='running',
          started_at=COALESCE(started_at,NOW()), last_error=NULL, worker_id=%s,
          lease_expires_at=NOW()+make_interval(secs=>%s) WHERE id=%s
          RETURNING embedding_index_id)
        UPDATE embedding_indexes idx SET last_error=NULL,
          status=CASE WHEN idx.status='failed' THEN 'building' ELSE idx.status END,
          updated_at=NOW() FROM claimed WHERE idx.id=claimed.embedding_index_id"""


def renew_lease_sql() -> str:
    return """UPDATE indexing_jobs
        SET lease_expires_at=NOW()+make_interval(secs=>%s)
        WHERE id=%s AND status='running' AND worker_id=%s RETURNING id"""
