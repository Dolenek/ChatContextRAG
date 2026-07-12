# Architecture

Chat Context is a local Electron desktop application backed by FastAPI,
PostgreSQL with pgvector, and the OpenAI API. It imports conversations through
independent source connectors and exposes multiple source-neutral embedding
indexes over one canonical raw-message layer. One ready index is globally active
for retrieval.

## Source connectors

The original embedded Discord importer remains available under **Nahrát pomocí
Discordu**. It uses an isolated, persistent Discord web partition and extracts
only the currently selected channel. Manual capture, continuous upward scan,
resume, cancellation, and Discord source deep links retain their existing
behavior.

The optional Discord bot runs in the Electron main process only while the
desktop application is running. Its token is encrypted with Electron
`safeStorage` and is never exposed back to the renderer or stored in PostgreSQL,
`.env`, or logs. The bot registers `/chatcontext sync`, `status`, and `stop`.
Commands require the Discord `Manage Channels` permission.

The first `sync` walks the complete accessible channel history in 100-message
pages. Durable sync state stores the oldest and newest cursors, backfill state,
tracking state, active ingestion session, and the last error. An interrupted
backfill resumes from its oldest cursor in the same durable ingestion session;
already committed pages are deduplicated and the final per-index jobs cover the
complete scan. Startup catches up from the newest cursor before listening for live
message create and update events. Discord deletes are intentionally ignored,
because the local database is an archive.

Live bot events are deduplicated by Discord message ID and flushed after 30
seconds of inactivity, after a hard 60-second limit, or at 100 messages. Each
flush closes an ingestion session and creates durable per-index jobs. An edited
message uses the same external ID, so its raw content and affected RAG boundary
are replaced rather than duplicated.

The WhatsApp connector imports local UTF-8 `.txt` or `.zip` exports. It supports
the common bracketed iOS and dashed Android formats, Czech and English date
ordering, 12/24-hour time, multiline messages, system events, and textual media
placeholders. The selected text entry is capped at 50 MiB and suspicious ZIP
compression ratios are rejected. Binary media, OCR, and audio transcription are
not processed.

WhatsApp exports do not contain a stable public message ID. The importer derives
a deterministic `waexp:` ID from the selected conversation, raw timestamp,
author, normalized content, and identical-message ordinal. Re-importing the same
export is idempotent. An edited export entry can appear as a new message because
there is no reliable source identity with which to match the edit.

## Raw storage and migration

`source_messages` stores every occurrence. Existing installations are migrated
transactionally by renaming `discord_messages`; PostgreSQL keeps its foreign-key
relationships intact. Existing Discord external IDs remain unchanged.

Every row has generic `source_type`, `conversation_id`, conversation label,
optional container identity, and JSON source metadata. Legacy `channel_id`,
`guild_id`, and channel fields remain for backward-compatible Discord deep links.
`message_contents` stores one normalized copy of each exact text, its occurrence
count, and a generated PostgreSQL full-text vector.

The migration and schema creation execute in one database transaction. A failure
therefore prevents application startup without leaving a partially migrated
schema. Clearing the database removes messages, vectors, jobs, and integration
cursors while preserving embedding-index definitions, provider profiles,
encrypted secrets, the Discord bot token, and the embedded Discord login.

Ingestion is source-neutral:

```text
connector -> normalization -> source_messages -> ingestion session
          -> per-index durable jobs -> staged chunks -> atomic publish
```

Electron writes at most 400 messages in each `/messages/import` request. Raw
writes use per-message advisory locks, upsert content and message identity, link
the messages to the session, and refresh canonical occurrence counts in one
transaction.

## Indexing

Indexing is deliberately decoupled from collection. Closing an ingestion session
queues a durable job for every ready embedding index whose auto-sync switch is
enabled. The single background worker resolves the provider, model, and dimension
from each job and streams its snapshot in chronological order. Jobs use renewable
leases so an abandoned job can be claimed after its lease expires.

The chunker never combines different `(source_type, conversation_id)` values.
It also separates messages after a 20-minute gap or before the rendered content
would exceed 1,800 characters. Oversized content is split at semantic boundaries
with a small overlap. Adjacent identical messages from the same author and
conversation are rendered once with a repetition count while preserving all
source message links.

Embedding batches contain at most 64 chunks. New vectors and normalized source
links are written into job-scoped staging tables. Existing searchable chunks
remain untouched until every embedding succeeds. The final replacement, link
update, and job completion occur in one transaction. Failed or cancelled jobs do
not expose a partial generation.

`embedding_indexes` stores immutable provider/model/dimension identity and
lifecycle state. Chunks, source links, staging rows, and jobs carry an
`embedding_index_id`, so identical chunk IDs can coexist in different vector
spaces. Embeddings use an unbounded `halfvec` column; every configuration gets
its own dimension cast and partial HNSW index. A rebuild keeps the published
generation searchable until its complete staged generation commits.

When a session includes an edited or overlapping message, the job snapshot also
includes all messages from affected published chunks. The combined boundary is
rebuilt and atomically replaces the old chunks.

## Retrieval and sources

Chat accepts an optional scope containing `source_type` and `conversation_id`.
With no scope, retrieval searches all indexed sources. Both HNSW vector
candidates and PostgreSQL full-text candidates apply the same source-neutral
filter.

Full-text hits expand to neighboring raw messages only within the same source and
conversation. Expansion is capped at 12 messages and stops at a 20-minute gap.
Vector candidates are restricted to the globally active embedding index and use
that index's exact provider, model, and dimension. Vector and full-text results
are combined with reciprocal-rank fusion and a small
recency multiplier. The best diverse contexts are sent through the chat provider
selected for the current conversation. Both Responses and OpenAI-compatible Chat
Completions preserve the same grounding instructions and source identity.

Electron owns custom provider secrets. `safeStorage` ciphertext and non-secret
metadata live below Electron `userData`; only the main process decrypts them.
Electron synchronizes the runtime registry through a token-protected loopback
endpoint. Backend and preload responses expose only `has_api_key`.
Until Electron has persisted an explicit chat selection, the renderer uses the
built-in provider and `OPENAI_CHAT_MODEL` reported by the backend. Database
bootstrap likewise seeds the initial embedding index from
`OPENAI_EMBEDDING_MODEL` and `OPENAI_EMBEDDING_DIMENSIONS`; conflict-safe inserts
preserve an existing active index and any saved user choice.

`POST /chat` returns `source_type`, `conversation_id`, source message IDs, and
legacy Discord deep-link fields. The renderer groups selectable scopes into
Discord channels, WhatsApp conversations, and any future connector types. Only
Discord sources with complete guild/channel/message identity render an **Open in
Discord** action.

## Public API

- `POST /ingestion/sessions` starts a source-neutral raw ingestion session.
- `POST /messages/import` stores up to 400 normalized source messages.
- `POST /ingestion/sessions/{id}/finish` queues per-index jobs and returns the
  compatible first job ID plus all job IDs.
- `GET /ingestion/conversations` lists raw conversations for a source.
- `GET /integrations/sync-states` and `POST /integrations/sync-state` persist
  connector cursors.
- `POST /imports/whatsapp/preview` validates and previews a multipart export.
- `POST /imports/whatsapp` imports a validated multipart export and queues it.
- `GET /indexing/jobs/{id}`, retry, cancel, and pending endpoints manage jobs.
- `GET /chat/scopes` lists searchable source conversations.
- `POST /chat` performs source-scoped hybrid RAG with the active embedding index
  and optional per-conversation chat provider/model.
- `/settings/providers` lists redacted provider metadata and model suggestions.
- `/settings/embedding-indexes` manages independent vector indexes, activation,
  sync, rebuild, and deletion.
- `GET /database/resume-point` remains the embedded Discord resume endpoint.
- `GET /database/overview` reports raw, index, source, and job statistics.
- `DELETE /database` requires `VYMAZAT` and clears stored conversation data.

## Extension boundary

New connectors should produce the generic message and session contracts instead
of writing directly to PostgreSQL. Stable source IDs must be namespaced when they
can collide with existing Discord snowflakes. Connector-specific navigation or
metadata belongs in `source_metadata` and chunk metadata; retrieval and chat
scope code must remain source-neutral.
