# Architecture

Chat Context RAG is a local Electron application backed by FastAPI, PostgreSQL,
pgvector, and the OpenAI API. Discord is accessed only through the signed-in
embedded web surface; no user token or self-bot API is used.

## Two-phase ingestion

Discord traversal and RAG indexing are intentionally decoupled:

```text
Discord DOM -> normalization -> canonical content + raw occurrence storage
            -> close ingestion session -> persistent indexing job
            -> chronological conversation chunking -> OpenAI embeddings
            -> halfvec HNSW storage + normalized chunk/message links
```

`message_contents` stores one normalized copy of each exact text, its occurrence
count, and a generated `simple` PostgreSQL full-text vector. `discord_messages`
stores every occurrence with Discord identity, author, channel, snowflake order,
and timestamp. Exact duplicate text is never discarded; occurrences share a
canonical content row.

Electron writes up to 400 messages per request during traversal. These requests
perform no OpenAI calls. A scan creates an `ingestion_session`; stopping or
reaching the channel beginning closes it and queues a durable `indexing_job`.
Running jobs return to `queued` after a backend restart. Failed jobs retain raw
data and can be retried; active jobs can be cancelled.

The indexer uses a server-side PostgreSQL cursor and streams messages in
snowflake order. Memory is bounded by the cursor page, one unfinished chunk,
and one embedding batch. Adjacent identical messages from the same author are
rendered once with a repetition count while all source IDs remain linked.
Conversation boundaries use a 20-minute gap and an 1,800-character cap.

When a later session overlaps an indexed message, the job snapshots all source
messages from affected chunks, removes those chunks, and rebuilds the combined
boundary. This preserves context across scan sessions and handles edited
messages without leaving stale vectors.

## Vector storage

New chunks are stored in `rag_chunks` as `halfvec(1536)` and indexed with HNSW
using `halfvec_cosine_ops`. Half precision retains all embedding dimensions while
reducing vector and index storage. The legacy `conversation_chunks` table remains
readable until the user explicitly clears the database; no startup migration
deletes data.

`rag_chunk_messages` provides normalized source links for boundary rebuilding,
indexed-message statistics, and retrieval diversity. Chunk IDs remain
deterministic from source IDs and rendered content, making retries idempotent.

## Hybrid retrieval

Each chat question produces 30 HNSW candidates and 30 `simple` full-text
candidates. Full-text hits use their newest and earliest occurrences and expand
to four neighboring messages on either side, capped at 12 messages and stopped
by a 20-minute gap.

Candidates are combined with reciprocal-rank fusion using constant 60. Exact
canonical-content matches merge into their vector candidate instead of filling
multiple result slots. A recency multiplier contributes at most 10 percent and
decays with a three-year half-life, so old strategies remain discoverable.
The best eight diverse contexts are sent to the OpenAI Responses API. Retrieved
Discord text is untrusted evidence; the prompt requires citations and an
explicit insufficient-evidence response when appropriate.

If no new hybrid data exists, chat falls back to the legacy vector index. This
keeps the current database usable until an explicit clear and re-import.

## Public API

- `POST /ingestion/sessions` starts a raw scan session.
- `POST /messages/import` stores raw messages for a session.
- `POST /ingestion/sessions/{id}/finish` queues indexing.
- `GET /indexing/jobs/{id}` reports durable progress.
- `POST /indexing/jobs/{id}/retry` and `/cancel` control a job.
- `POST /chat` performs hybrid RAG with legacy fallback.
- `GET /database/resume-point` reads the oldest raw message, then legacy data.
- `GET /database/overview` reports raw, deduplication, index, job, and size data.
- `DELETE /database` requires `VYMAZAT` and clears both generations of data.

## Configuration

The automated test suite includes a 100,000-message synthetic test that verifies
streaming and the 64-chunk embedding bound.

FastAPI loads secrets and model configuration from `.env`; `.env.example`
contains safe placeholders only. `OPENAI_EMBEDDING_DIMENSIONS` remains 1536.
Changing it requires a new compatible `rag_chunks` table.
