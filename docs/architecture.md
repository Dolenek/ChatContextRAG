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
            -> durable staging -> atomic halfvec index replacement
```

`message_contents` stores one normalized copy of each exact text, its occurrence
count, and a generated `simple` PostgreSQL full-text vector. `discord_messages`
stores every occurrence with Discord identity, author, channel, snowflake order,
and timestamp. Exact duplicate text is never discarded; occurrences share a
canonical content row. A request containing the same Discord ID more than once
uses the last value and counts the occurrence once. Editing an existing message
refreshes both the old and new content counts and removes unreferenced canonical
text so it cannot occupy full-text result slots. Concurrent requests that touch
the same Discord ID are serialized for the transaction, including the first
insert, so intermediate edits cannot leave stale canonical content. Each raw
write also holds the ingestion-session row until message links and counts commit.
Session finalization takes the same row lock and can therefore neither overtake
an in-flight batch nor create an incomplete indexing snapshot.

Electron writes up to 400 messages per request during traversal. These requests
perform no OpenAI calls. A scan creates an `ingestion_session`; stopping or
reaching the channel beginning closes it and queues a durable `indexing_job`.
Repeated observations of the same non-top Discord viewport trigger recovery:
the partial raw batch is committed, the loaded list is moved to its upper edge,
and traversal resumes after a backoff instead of spinning indefinitely. DOM
reads and scroll commands have a bounded wait and are cancellation-aware, so a
stalled Discord renderer can be retried or interrupted before the pending raw
batch is flushed and the session is finalized.
The database overview can also create a maintenance session for raw messages
that have no `rag_chunk_messages` link. Creation is serialized with a PostgreSQL
advisory transaction lock and excludes messages already assigned to queued or
running jobs. This recovers raw data left behind by an interrupted session
without duplicating active indexing work.
Each claim assigns a unique worker ID and a renewable 90-second lease. Queued
jobs and running jobs with expired leases are claimable with `SKIP LOCKED`, so a
job abandoned by a stopped backend is recovered without resetting work owned by
another healthy process. A heartbeat renews the lease during slow embedding
calls. Failed, cancelled, and completed jobs can be retried; queued or running
jobs reject retry and active jobs can instead be cancelled. Transient polling
failures are isolated to one worker iteration and do not mutate other jobs.

Embedding batches are written to `rag_staged_chunks` and
`rag_staged_chunk_messages`. Existing searchable chunks remain untouched while
the job is running. The final replacement, source-link update, and job completion
occur in one PostgreSQL transaction guarded by both the job row and worker ID.
Only the current lease owner can prepare, write, fail, or publish staging data;
a late operation from an expired worker cannot delete its successor's staging.
Failure or cancellation discards staging data and leaves the previous searchable
index intact. Cancellation changes the job state and deletes its staging rows in
one transaction. A concurrent or late processing failure cannot overwrite
`cancelled` or another worker's claim with `failed`. Retried jobs atomically
clear stale staging, ownership, progress, and timing fields before processing.

The indexer uses a server-side PostgreSQL cursor and streams messages in
snowflake order. Memory is bounded by the cursor page, one unfinished chunk,
and one embedding batch. Adjacent identical messages from the same author and
channel are rendered once with a repetition count while all source IDs and
timestamp bounds remain linked. Messages across a 20-minute boundary are never
collapsed. Chunk boundaries compare the final timestamp in a collapsed group
with the first timestamp in the next group. Conversation chunks use an
1,800-character cap. Oversized messages are split at paragraph, line, sentence,
or word boundaries instead of arbitrary character positions. Continuation
chunks repeat a compact message header and overlap the previous part by up to
160 characters so retrieval does not lose context at a split boundary.

When a later session overlaps an indexed message, the job snapshots all source
messages from affected chunks and rebuilds the combined boundary in staging.
The atomic replacement preserves context across scan sessions and handles edited
messages without exposing a partially rebuilt index.

## Vector storage

New chunks are stored in `rag_chunks` as `halfvec(1536)` and indexed with HNSW
using `halfvec_cosine_ops`. Half precision retains all embedding dimensions while
reducing vector and index storage. The legacy `conversation_chunks` table remains
readable until the user explicitly clears the database; no startup migration
deletes data.

`rag_chunk_messages` provides normalized source links for boundary rebuilding,
indexed-message statistics, and retrieval diversity. Chunk IDs remain
deterministic from source IDs and rendered content, making retries idempotent.
The two `rag_staged_*` tables are working storage only and are cleared by their
current owner on preparation or commit, by cancellation and terminal retry, and
by explicit database deletion.

## Hybrid retrieval

Chat retrieval accepts an optional source-neutral scope made of `source_type`
and `conversation_id`. With no scope, retrieval searches every indexed message.
With a scope, both HNSW and full-text candidates are constrained before ranking;
the legacy vector fallback applies the same constraint. A Discord conversation
maps to a channel ID. New chunks also store `source_type=discord` and the generic
`conversation_id` alongside Discord-specific deep-link metadata. Existing chunks
without the generic fields are treated as Discord chunks and continue to work.

`GET /chat/scopes` builds the selector catalog from searchable chunk metadata,
merging current and legacy indexes. The API and renderer depend only on the
generic source/conversation identity. A future importer such as WhatsApp can add
its own `source_type`, conversation IDs, labels, and indexed chunks without
changing the chat request contract or selector.

Each chat question produces 30 HNSW candidates and 30 `simple` full-text
candidates. Full-text hits use their newest and earliest occurrences and expand
to four neighboring messages on either side, capped at 12 messages and stopped
by a 20-minute gap. Gap trimming expands outward from the matching anchor, so an
older disconnected message cannot displace the actual full-text hit.

The HNSW query limits vector candidates before joining source-message hashes,
preserving the approximate-nearest-neighbor index path as the database grows.
Canonical occurrences are indexed by `(content_hash, message_order)`, which
supports full-text anchor selection, edit cleanup, and occurrence refreshes
without repeatedly scanning the complete raw message table.

Candidates are combined with reciprocal-rank fusion using constant 60. Exact
canonical-content matches merge into their vector candidate instead of filling
multiple result slots. A recency multiplier contributes at most 10 percent and
decays with a three-year half-life, so old strategies remain discoverable.
The best eight diverse contexts are sent to the OpenAI Responses API. Retrieved
Discord text is untrusted evidence; the prompt requires citations and an
explicit insufficient-evidence response when appropriate.

Every returned context retains its Discord message IDs, channel ID, and guild
ID. `POST /chat` exposes that identity in `sources`; the Electron chat renders
numbered expandable source cards matching the model's `[1]`, `[2]` citations.
When Discord identity is complete, a source card can navigate the embedded
signed-in Discord view directly to the referenced message.

If no new hybrid data exists, chat falls back to the legacy vector index. This
keeps the current database usable until an explicit clear and re-import.

## Public API

- `POST /ingestion/sessions` starts a raw scan session.
- `POST /messages/import` stores raw messages for a session.
- `POST /ingestion/sessions/{id}/finish` queues indexing.
- `GET /indexing/jobs/{id}` reports durable progress.
- `POST /indexing/jobs/{id}/retry` and `/cancel` control a job.
- `POST /indexing/jobs/pending` queues raw messages not covered by the index or
  an active indexing job.
- `POST /chat` performs hybrid RAG with legacy fallback.
- `GET /chat/scopes` lists searchable source conversations for chat filtering.
- `GET /database/resume-point` reads the oldest raw message, then legacy data.
- `GET /database/overview` reports raw, deduplication, index, job, and size data.
- `DELETE /database` requires `VYMAZAT` and clears both generations of data.

## Configuration

The automated test suite includes a 100,000-message synthetic test that verifies
streaming and the 64-chunk embedding bound. The worker rejects missing vectors
or unexpected embedding dimensions before any staged generation can publish.
While the database overview is visible, Electron polls the active job every 1.5
seconds through `GET /indexing/jobs/{id}`. The job card distinguishes queueing,
initial snapshot or first-batch preparation, embedding progress, and terminal
states. A terminal response triggers one full overview refresh so atomically
published chunk and message counts become visible without manual reload.
An optional PostgreSQL integration test verifies that the old generation stays
searchable throughout staging and is replaced only by the final transaction.

FastAPI loads secrets and model configuration from `.env`; `.env.example`
contains safe placeholders only. `OPENAI_EMBEDDING_DIMENSIONS` remains 1536.
Changing it requires a new compatible `rag_chunks` table.
