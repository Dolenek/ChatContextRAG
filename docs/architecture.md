# Architecture

Chat Context is a self-hosted web and Electron application backed by FastAPI,
PostgreSQL with pgvector, and compatible AI providers. It imports conversations through
independent source connectors and exposes multiple source-neutral embedding
indexes over one canonical raw-message layer. One ready index is globally active
for retrieval.

## Runtime and hosting

The same renderer runs in three explicit runtime modes: Electron Local,
Electron Remote, and Web. `window.chatContext` is the stable renderer boundary.
Electron supplies it through preload IPC; the browser supplies an HTTP/SSE
adapter before the UI controllers load. Runtime capabilities control whether
the embedded Discord browser is visible.

The Linux web profile contains PostgreSQL, an internal FastAPI service, and a
Node.js gateway. Only the gateway publishes a host port. It serves the renderer,
owns browser authentication and the long-running Discord bot, keeps provider and
bot secrets in an encrypted persistent store, and forwards an explicit allowlist
of operations to FastAPI. The internal provider-registry endpoint is never
proxied publicly. FastAPI remains the canonical ingestion, retrieval, indexing,
and database service.

One admin account authenticates browser sessions. Sessions are time limited and
use an HttpOnly SameSite cookie plus a per-session CSRF token. Mutations also
require a same-origin request. Login attempts are rate limited. A separately
configured bearer token authenticates Electron Remote requests; it remains in
the Electron main process and is encrypted at rest with `safeStorage`.

Electron stores a Local or Remote `ConnectionTarget`. Local mode starts the
loopback PostgreSQL and FastAPI processes and retains the existing encrypted
desktop provider store. Remote mode skips local infrastructure and routes the
entire workspace through the gateway. The local Discord `BrowserView` remains
available in Remote mode, so its normalized ingestion batches are written
directly to the server. Target changes never migrate or dual-write existing raw
messages automatically, and a failed remote connection never falls back to
Local implicitly. Electron Local additionally offers an explicit, resumable
archive migration to a compatible gateway.

The migration protocol advertises versioned import/export capabilities through
`RuntimeCapabilities`. Local FastAPI snapshots current message IDs into an
otherwise ordinary completed ingestion session. This gives pagination a stable
source set while normal ingestion resumes immediately after snapshot creation.
Only the Electron main process can read the internal export endpoints, using the
ephemeral internal FastAPI token.

Electron sends size-bounded batches to bearer-only gateway migration routes and
stores the acknowledged cursor in its private user-data directory. The remote
session links every accepted ID, including messages already present there, so
its count can verify the complete snapshot. Repeating a lost batch is
idempotent. A browser admin session cannot call migration routes, internal
export routes are never proxied, and neither PostgreSQL service is exposed to
the other host.

All shared backend-client requests have a 30-second deadline and compose that
deadline with an optional caller `AbortSignal`. Timeout errors retain the method
and concrete endpoint. Migration operations use at most three total attempts
with progressive backoff. The cursor and transferred count advance only after
`accepted_count` confirms the entire batch, so a lost response retries the same
page safely. Gateway migration completion first reads session status and returns
an already completed session unchanged, making finalization retry-safe as well.

The Electron-owned `BackendProcess` drains both Uvicorn stdout and stderr into a
5 MiB, three-backup rotating log below private user data. This prevents child
pipe backpressure from blocking Uvicorn's single event loop. Export-page start
and end records include cursor, batch length, and elapsed time. After a local
timeout, Electron publishes a recovery phase, probes `/health`, stores that
result and the failed endpoint, and, when unhealthy, replaces only the managed
Python process tree. PostgreSQL and Electron remain running, and the ephemeral
internal token is reused by the replacement process.

Persisted active migration phases are treated as interrupted when no in-memory
transfer promise exists. They are never rendered as live work after startup.
Paused, interrupted, and failed states expose resume from the last acknowledged
cursor. After all pages and sync states, Electron completes the remote session,
reads both the still-existing local snapshot total and remote session count, and
requires exact equality before deleting the snapshot.

Message conflicts use the Local row for the same external ID while retaining
unrelated server rows. Discord cursor ranges are unioned; an existing server
tracking preference wins, and active sessions or old errors are discarded.
Completion creates no embedding work. A later explicit action queues the
migration session against ready auto-sync indexes, keeping paid provider calls
separate from data transfer. Provider secrets, bot tokens, embeddings, and model
configuration are outside the migration contract.

## Source connectors

The original embedded Discord importer remains available under **Nahrát pomocí
Discordu**. It uses an isolated, persistent Discord web partition and extracts
only the currently selected channel. Manual capture, continuous upward scan,
resume, cancellation, and Discord source deep links retain their existing
behavior.

In an Electron Local workspace, the optional Discord bot runs in the main
process only while the desktop application is running. Its token is encrypted with Electron
`safeStorage` and is never exposed back to the renderer or stored in PostgreSQL,
`.env`, or logs. The bot registers `/chatcontext sync`, `status`, and `stop`.
Commands require the Discord `Manage Channels` permission.

In Web and Electron Remote modes the bot instead runs in the Node gateway. Its
token is encrypted with `CHAT_CONTEXT_SERVER_KEY`, persisted in the server-state
volume, and restored when the gateway starts. Only one bot runtime is active for
the selected workspace.

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

Before storage, message identifiers are trimmed. Author names, conversation
labels, and other inline labels are Unicode NFKC-normalized, stripped, and have
consecutive whitespace collapsed. Content is also NFKC-normalized, CRLF is
converted to LF, horizontal whitespace is collapsed per line, and runs of three
or more newline characters are reduced to two. Missing Discord conversation and
container identities fall back to the legacy channel and guild fields. A blank
author becomes the localized `Neznámý autor` fallback; connectors are responsible for supplying
non-empty content and stable external IDs.

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

Repeated ingestion preserves a raw message's `updated_at` when its content and
source metadata are unchanged. Incremental job snapshots therefore embed only
new or changed messages plus the existing neighboring chunks needed to keep
chunk boundaries coherent.

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
endpoint. Backend and preload responses expose only redacted availability flags.
The provider store may also hold a key-only override for the built-in OpenAI
provider. Its fixed ID, URL, and Responses protocol cannot be replaced; the
runtime registry applies only the decrypted key and otherwise falls back to the
environment key. The same provider credential is used by chat and embedding
clients selected for that provider.
Custom OpenAI-compatible providers may omit the key for trusted local endpoints;
the backend uses a non-secret SDK placeholder while sending requests only to the
configured base URL. The Electron store also keeps the user-managed provider,
model ID, and display label used to populate the composer selector. These model
records contain no credentials.

For a web workspace, the gateway owns the equivalent provider profiles, chat
defaults, and managed model records. AES-256-GCM ciphertext is stored in the
server-state volume and decrypted only long enough to synchronize the internal
runtime registry. The browser, FastAPI responses, PostgreSQL, and logs receive
only redacted provider views. Losing `CHAT_CONTEXT_SERVER_KEY` makes these
encrypted credentials unrecoverable.
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

## Renderer shell

The renderer is a framework-free three-panel workspace. A narrow navigation rail
opens an overlay drawer for source scope and connector workflows, the center
switches between chat, database detail, and settings, and the right panel renders
grounding sources plus a compact index snapshot. The context panel becomes a
drawer below 1,100 px. Each area owns its scrolling so long source lists and
database results do not move the chat composer.

Controllers share one database-overview snapshot between the right status panel,
the full database view, and indexing controls. Chat response sources are handed
to the context panel and retained on each assistant entry so an older response's
grounding can be selected again. All source content is inserted through DOM text
properties rather than interpreted as HTML.

The chat composer owns a two-level model popover: the first level selects a
configured provider and the second selects one of its persisted chat models.
Changing the selection writes the Electron-owned default and resets visible chat
history so messages generated by different models are not mixed.

The embedded Discord `BrowserView` starts below the custom title bar and to the
right of the locked-open import drawer. This keeps scan controls in the isolated
renderer visible while Discord continues to run in its persistent partition.

The web adapter uses browser file selection and multipart requests for WhatsApp
exports. It hides embedded Discord controls and opens complete Discord source
links in a new browser tab. `/api/events` carries best-effort indexing and bot
progress over SSE; job polling remains authoritative across reconnects.

## Public API

The web gateway exposes `/api/auth/login`, logout, session metadata, runtime
capabilities, and `/api/events`. All workspace routes below are available under
its authenticated `/api` facade. Browser calls use the session and CSRF token;
Electron Remote calls use its bearer token.

- `POST /ingestion/sessions` starts a source-neutral raw ingestion session.
- `POST /messages/import` stores up to 400 normalized source messages.
- `POST /ingestion/sessions/{id}/finish` normally queues per-index jobs and
  returns the compatible first job ID plus all job IDs. Internal migration
  completion may explicitly defer that work.
- `GET /ingestion/sessions/{id}` reports durable session state and
  `POST /ingestion/sessions/{id}/index` explicitly queues deferred jobs.
- `GET /ingestion/conversations` lists raw conversations for a source.
- `GET /integrations/sync-states` and `POST /integrations/sync-state` persist
  connector cursors.
- `POST /imports/whatsapp/preview` validates and previews a multipart export.
- `POST /imports/whatsapp` imports a validated multipart export and queues it.
- `GET /indexing/jobs/{id}`, retry, cancel, and pending endpoints manage jobs.
  Job views include source type plus conversation and container labels so the
  progress UI identifies the imported channel or index-wide maintenance task.
- `GET /chat/scopes` lists searchable source conversations.
- `POST /chat` performs source-scoped hybrid RAG with the active embedding index
  and optional per-conversation chat provider/model.
- `/settings/providers` lists redacted provider metadata and model suggestions.
- `/settings/embedding-indexes` manages independent vector indexes, activation,
  sync, rebuild, and deletion.
- `GET /database/resume-point` remains the embedded Discord resume endpoint.
- `GET /database/overview` reports raw, index, source, and job statistics.
- `DELETE /database` requires `VYMAZAT` and clears stored conversation data.

`/api/migrations`, its message and sync-state children, completion, status, and
index actions are bearer-only gateway routes used by Electron Local. Browser
sessions receive `403` even with a valid CSRF token. Local
`/internal/migration-exports` snapshot, page, and cleanup routes require the
internal token and are not present in the gateway allowlist.

## Extension boundary

New connectors should produce the generic message and session contracts instead
of writing directly to PostgreSQL. Stable source IDs must be namespaced when they
can collide with existing Discord snowflakes. Connector-specific navigation or
metadata belongs in `source_metadata` and chunk metadata; retrieval and chat
scope code must remain source-neutral.
