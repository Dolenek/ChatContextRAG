def queue_job_sql() -> str:
    return """INSERT INTO indexing_jobs (id,session_id,status,total_messages)
        VALUES (%s,%s,'queued',%s) ON CONFLICT (session_id) DO UPDATE SET
        status='queued', total_messages=EXCLUDED.total_messages, processed_messages=0,
        stored_chunks=0, last_error=NULL, started_at=NULL, finished_at=NULL,
        worker_id=NULL, lease_expires_at=NULL"""


def snapshot_messages_sql() -> str:
    return """INSERT INTO indexing_job_messages(job_id,message_id)
        WITH session_ids AS (
          SELECT message_id FROM ingestion_session_messages WHERE session_id=%s),
        affected AS (SELECT chunk_id FROM rag_chunk_messages
          WHERE message_id IN (SELECT message_id FROM session_ids)),
        targets AS (SELECT message_id FROM session_ids UNION SELECT message_id
          FROM rag_chunk_messages WHERE chunk_id IN (SELECT chunk_id FROM affected))
        SELECT %s,message_id FROM targets ON CONFLICT DO NOTHING"""


def select_jobs_sql(condition: str) -> str:
    return f"""SELECT id,session_id,status,total_messages,processed_messages,
               stored_chunks,last_error,started_at,finished_at,created_at
               FROM indexing_jobs WHERE {condition}"""


def claimable_job_sql() -> str:
    return """SELECT id FROM indexing_jobs
        WHERE status='queued' OR (status='running' AND
          (lease_expires_at IS NULL OR lease_expires_at<=NOW()))
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1"""


def claim_job_sql() -> str:
    return """UPDATE indexing_jobs SET status='running',
        started_at=COALESCE(started_at,NOW()), last_error=NULL, worker_id=%s,
        lease_expires_at=NOW()+make_interval(secs=>%s) WHERE id=%s"""


def renew_lease_sql() -> str:
    return """UPDATE indexing_jobs
        SET lease_expires_at=NOW()+make_interval(secs=>%s)
        WHERE id=%s AND status='running' AND worker_id=%s RETURNING id"""
