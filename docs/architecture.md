# Architecture

Chat Context is a self-hosted web and Electron application backed by FastAPI,
PostgreSQL with pgvector, and compatible AI providers. It imports conversations through
independent source connectors and exposes multiple source-neutral embedding
indexes over one canonical raw-message layer. One ready index is globally active
for retrieval.

## Runtime and hosting

The same renderer runs in three explicit runtime modes: Electron Local,
Electron Remote, and Web. `window.chatContext` is the stable renderer boundary.
Electron supplies it through sandbox-compatible preload IPC; the preload imports
only Electron's exposed API and uses browser globals instead of unrestricted Node
built-ins. The browser supplies an HTTP/SSE adapter before the UI controllers load.
At renderer startup, runtime
capabilities expose `electron-local`, `electron-remote`, or `web` plus the
`embeddedDiscord` flag. Desktop-only controls start hidden and are exposed only
after those capabilities confirm that the current runtime supports them. Web
therefore exposes neither the connection-target card nor the local Discord
scanner.

The Electron renderer is restricted by a Content Security Policy, cannot
navigate away from its packaged entry point or create child windows, and every
privileged IPC call validates both the sending `webContents` and main-frame URL.
The isolated Discord view accepts only HTTPS navigation on `discord.com` and
denies browser permission requests by default.

The Linux web profile contains PostgreSQL, an internal FastAPI service, and a
Node.js gateway. Only the gateway publishes a host port. It serves the renderer,
owns browser authentication and the long-running Discord bot, keeps provider and
bot secrets in an encrypted persistent store, and forwards an explicit allowlist
of operations to FastAPI. The internal provider-registry endpoint is never
proxied publicly. The gateway attaches `CHAT_CONTEXT_INTERNAL_TOKEN` to every
FastAPI request. Electron Local uses its own ephemeral token, and FastAPI
requires that credential on every route except the public liveness check at
`/health`. Startup and recovery use the authenticated `/internal/health` route
so a different loopback process cannot impersonate the managed backend. Browser-origin and
cross-site fetches are rejected before request-body parsing. FastAPI remains the
canonical ingestion, retrieval, indexing, and database service.

The gateway caches static file bytes in memory together with file size and
modification time. It returns `ETag` and `Last-Modified` validators, answers
matching conditional requests with `304`, and reloads a file after deployment
when its metadata changes. Renderer assets still revalidate, while frequently
referenced resources such as the shared SVG sprite avoid repeated transfers.

One admin account authenticates browser sessions. Sessions are time limited and
use an HttpOnly SameSite cookie plus a per-session CSRF token. Mutations also
require a same-origin request. Password checks use asynchronous scrypt with at
most four concurrent checks; excess attempts receive `503` and `Retry-After`.
The gateway retains at most 256 sessions and 4,096 login-source buckets, pruning
expired entries before rejecting new capacity. A separately configured bearer
token authenticates Electron Remote requests; it remains in the Electron main
process and is encrypted at rest with `safeStorage`. Behind a trusted reverse
proxy, login limits use the rightmost valid `X-Forwarded-For` address while
origin checks require the exact forwarded HTTPS scheme and host.

Electron stores a Local or Remote `ConnectionTarget`. Local mode starts the
loopback PostgreSQL and FastAPI processes and retains the existing encrypted
desktop provider store. Remote mode skips local infrastructure and routes the
entire workspace through the authenticated Chat Context gateway. Electron never
connects directly to the remote PostgreSQL service. **Settings > Workspace**
shows the target selector only in Electron; remote URL and desktop-token fields
appear only for a Remote selection. A Remote save first verifies the gateway,
then persists the encrypted token and restarts the application. A failed test
does not change the stored target or fall back to Local. Target changes never
migrate or dual-write existing raw messages automatically. Electron Local
additionally offers an explicit, resumable archive migration to a compatible
gateway.

Electron requires an explicit acknowledgement before connecting to a remote
non-loopback HTTP origin. The acknowledgement is stored for that exact
normalized origin and is invalidated by any scheme, host, or port change.
Loopback HTTP targets are exempt.

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
configuration and persisted chat sessions are outside the migration contract.

## Source connectors

The desktop-only importer is available in **Sources and imports** as **Lokální
Discord scanner** in both Electron Local and Electron Remote. Its isolated,
persistent Discord `BrowserView` and login always remain on the desktop. It
extracts only the selected channel and sends normalized ingestion batches
through the active backend client: loopback FastAPI in Local, or the
authenticated gateway in Remote. Manual capture, continuous upward scan,
resume, and cancellation retain their existing behavior. This scanner is
separate from the Discord bot described below.

In an Electron Local workspace, the optional Discord bot runs in the main
process only while the desktop application is running. Its token is encrypted with Electron
`safeStorage` and is never exposed back to the renderer or stored in PostgreSQL,
`.env`, or logs. The bot registers `/chatcontext sync`, `status`, and `stop`.
Commands and questions use separate persisted per-guild role/user allowlists;
Discord ownership and administrator permissions never bypass them.

In Web and Electron Remote modes the bot instead runs in the Node gateway. Its
token is encrypted with `CHAT_CONTEXT_SERVER_KEY`, persisted in the server-state
volume, and restored when the gateway starts. Only one bot runtime is active for
the selected workspace.

The first `sync` walks the complete accessible channel history in 100-message
pages. Durable sync state stores the oldest and newest cursors, backfill state,
tracking state, active ingestion session, and the last error. An interrupted
backfill resumes from its oldest cursor. It reuses the durable ingestion session
only while the backend reports that session as running; a stopped, completed, or
missing session is cleared and replaced. Serialized state updates prevent a
catch-up error from restoring an invalid session ID. Already committed pages are
deduplicated and the final per-index jobs cover the complete scan. Startup catches
up from the newest cursor before listening for live message create and update
events. Discord deletes are intentionally ignored, because the local database is
an archive.

Live synchronization events are deduplicated by Discord message ID and flushed after 30
seconds of inactivity, after a hard 60-second limit, or at 100 messages. Each
flush closes an ingestion session and creates durable per-index jobs. An edited
message uses the same external ID, so its raw content and affected RAG boundary
are replaced rather than duplicated.

The same runtime answers authorized mentions and replies using an immutable live
room snapshot, current-room historical retrieval, and a Discord-only general
knowledge fallback. Settings, permission subjects, answer audits, and sent-message
mappings are normalized PostgreSQL records outside the raw-archive migration.
The complete behavior and API boundary are canonical in
[Discord bot](discord-bot.md).

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
`guild_id`, and channel fields remain for Discord connector identity and importer
navigation.
`message_contents` stores one normalized copy of each exact text, its occurrence
count, and a generated PostgreSQL full-text vector.

The migration and schema creation execute in one database transaction. A failure
therefore prevents application startup without leaving a partially migrated
schema. Clearing the database removes messages, vectors, jobs, and integration
cursors while preserving embedding-index definitions, provider profiles,
encrypted secrets, the Discord bot token, and the local Discord scanner login.
Discord bot model settings, guild permissions, and answer audits are also
independent of raw-archive clearing.

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
transaction. The session total advances by the number of newly inserted links;
an import page never recounts the complete growing session. Cursor-state writes
return their stored fields directly, while aggregate raw and indexed counts are
computed only by the explicit state-list read.

## Indexing

Indexing is deliberately decoupled from collection. Closing an ingestion session
queues a durable job for every ready embedding index whose auto-sync switch is
enabled. The single background worker resolves the provider, model, and dimension
from each job and streams its snapshot in chronological order. Jobs use renewable
leases so an abandoned job can be claimed after its lease expires. Completing a
normal ready-index job never creates another maintenance job. Finishing an
initial build may create one catch-up job for messages accepted while the index
was building, and the database permits only one queued or running catch-up per
index.

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
not expose a partial generation. Incremental publication removes only existing
chunks represented by the job snapshot, never every chunk touched by the wider
ingestion session.

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
Filtered HNSW retrieval uses strict iterative scanning so source and calendar
constraints do not exhaust the initial approximate candidate window.

When a session includes an edited or overlapping message, the job snapshot also
includes all messages from affected published chunks. The combined boundary is
rebuilt and atomically replaces the old chunks.

## Retrieval and sources

Chat supports the backward-compatible deterministic RAG path and a bounded
adaptive path that exposes scoped, read-only archive tools to capable models.
Both paths resolve model-visible evidence to original messages and preserve it in
the chat-session source payload. The complete retrieval flow, security boundary,
provider protocols, evidence limits, API fields, and persistence contract are
documented in [Chat retrieval and archive tools](chat-retrieval.md).

## Renderer shell

The renderer's layout, navigation, model picker, settings behavior, and responsive
web adaptations are documented in [Renderer shell](renderer-shell.md).

## Public API

The authenticated gateway facade, FastAPI route groups, read-model refresh
behavior, compatibility endpoints, and migration boundary are documented in
[Public API](api.md). Expensive UI aggregates use the nonblocking persistent
projection contract in [Persistent UI read model](ui-read-model.md).

## Extension boundary

New connectors should produce the generic message and session contracts instead
of writing directly to PostgreSQL. Stable source IDs must be namespaced when they
can collide with existing Discord snowflakes. Connector-specific navigation or
metadata belongs in `source_metadata` and chunk metadata; retrieval and chat
scope code must remain source-neutral.
