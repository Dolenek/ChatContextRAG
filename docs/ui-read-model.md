# Persistent UI read model

The UI read model keeps expensive archive and embedding-index aggregates in
small PostgreSQL projection tables. Interactive GET requests read those tables
instead of scanning the canonical message and chunk relations. PostgreSQL
remains the only source of truth; the projections are disposable, rebuildable
views of canonical data.

This design applies equally to Electron Local, Electron Remote, and Web. It is
especially important for remote workspaces where a full aggregate scan can
otherwise exceed the shared client's 30-second deadline.

## Projected and live values

The following values are persistent projections:

| Projection | Contents |
| --- | --- |
| `workspace_read_summary` | Raw and unique message counts, author and conversation counts, and the archive time range. |
| `embedding_index_read_summary` | Chunk, indexed-message, and pending-message counts for every embedding index. |
| `chat_scope_read_model` | Source conversations represented by each published embedding index. |
| `database_breakdown_read_model` | Per-index channel, author, and embedding-model counts. |
| `read_model_refresh_state` | Projection version, requested and published revisions, state, debounce time, lease, retry, generation time, and private failure detail. |

Chunk pages, active indexing jobs, PostgreSQL database size, provider settings,
and persisted chat history remain live queries. They are bounded or naturally
small and do not require an aggregate projection.

## Invalidation contract

Invalidation is part of the same PostgreSQL transaction as the canonical
mutation. A committed write therefore cannot be followed by a response that
claims its old projection is current.

- A raw import or message edit increments the archive revision and every index
  revision.
- Atomic index publication increments the corresponding index revision.
- Creating an index creates its empty queued projection state.
- Activating an index queues an immediate refresh for that index.
- Deleting an index removes its summary, scope, breakdown, and refresh state by
  foreign-key cascade.
- Clearing the archive publishes zero-valued archive and per-index summaries in
  the clear transaction and removes projected scopes and breakdowns.

Invalidation preserves the last published rows. Readers can therefore return a
useful stale snapshot while a replacement is pending.

## Refresh worker

FastAPI starts the read-model worker from its lifespan without delaying the
health check. Schema creation seeds an archive state and a state for every
existing embedding index, so the first deployment automatically backfills in
the background.

Ordinary writes set `requested_at` to the current time. Repeated writes keep
moving that timestamp, and work becomes claimable five seconds after the last
write. An explicit refresh bypasses this debounce. The five-second target is a
start time, not a promise that a production-sized scan finishes in five
seconds.

Each API process has a worker thread, but a PostgreSQL advisory lock permits
only one aggregate calculation across all API instances. A claimed projection
also records a durable owner and lease. A different process can recover a
`running` item after its lease expires, including after an API crash or restart.

The worker uses a repeatable-read transaction for each projection:

- the archive transaction calculates and publishes the global summary;
- an index transaction calculates its summary, chat scopes, and all breakdown
  dimensions, then publishes them together;
- readers continue seeing the preceding committed generation until the whole
  transaction commits.

The worker records the revision it claimed. If a mutation increments the
requested revision while calculation is running, completion publishes the
claimed revision and leaves the newer revision queued. This prevents a refresh
from losing concurrent writes.

On failure, PostgreSQL rolls back all projection changes and retains the last
valid snapshot. The state stores a private bounded error for diagnostics and
retries after exponential backoff, capped at five minutes. Public responses
contain only a fixed sanitized error message.

## Response metadata

`DatabaseStatus`, `ChatScopeList`, `DatabaseCountPage`, and every
`EmbeddingIndexView` expose the same fields:

| Field | Meaning |
| --- | --- |
| `summary_ready` | At least one generation has been published for every projection required by this response. |
| `summary_generated_at` | Generation time of the oldest required projection, or `null` before the first complete snapshot. |
| `summary_is_stale` | A newer revision is queued/running, the last attempt failed, or no snapshot exists. |
| `summary_refreshing` | The required projection is currently queued or running. |
| `summary_error` | Sanitized failure state, never the stored PostgreSQL or application exception. |

An unavailable initial snapshot returns compatible numeric zero values together
with `summary_ready=false`. Consumers must use the metadata and must not present
those zeros as real archive totals.

## API behavior

- `GET /database/status` reads active archive/index values, reports freshness
  across the workspace projections for centralized polling, and adds live
  database size and recent indexing jobs.
- `GET /database/status?fresh=true` queues an immediate refresh of the archive
  and active index, then returns the current snapshot without waiting.
- `POST /database/read-model/refresh` accepts `{ "scope": "active" }` or
  `{ "scope": "all" }`, queues immediate work, and returns
  `{ "queued": true, "scope": ... }`.
- `GET /chat/scopes` reads `chat_scope_read_model` for the active index.
- `GET /database/breakdowns/{dimension}` pages the active index projection.
- Compatibility endpoints `GET /database/overview` and
  `GET /database/breakdowns` assemble their aggregate fields from the same
  projections. Overview chunk rows remain a live paginated read.
- `GET /settings` reads per-index counts and freshness metadata from the
  embedding-index summary and refresh-state tables.

The web gateway explicitly allows the refresh endpoint. Electron Local and
Electron Remote expose the same `refreshReadModel(scope)` preload method and IPC
handler, so renderer code has one transport-neutral contract.

## Renderer behavior

The renderer keeps its last locally cached snapshot while the server reports a
stale or refreshing projection. It displays the generation time and a compact
freshness label without replacing metric cards or scope rows.

Before the initial backfill, projected values render as em dashes with
**Připravuji souhrn…**. Live database size and live indexing jobs remain
available. A failed refresh leaves the preceding snapshot visible, announces
the failure, and the existing **Obnovit** action can queue another attempt.

Only the overview controller polls projection state. It requests status every
eight seconds while a required projection is missing, stale, or refreshing and
stops after a current generation arrives. Completion invalidates the renderer's
settings, chat-scope, status, and first-breakdown caches and reconciles those
consumers. This avoids independent polling loops for each panel.

Manual refresh keeps visible values in place, queues server work, and exposes
progress through the same metadata. Settings requests an `all` refresh; the
database overview uses the active scope.

## Operational verification

The ordinary Python suite covers schema declarations, metadata, invalidation,
revision races, retry limits, projection-only GET queries, lifecycle startup,
and API models. Node tests cover Local/Remote/Web transport parity, bootstrap
placeholders, stale rendering, centralized polling, and cache reconciliation.

The optional PostgreSQL test uses an isolated schema to verify first backfill,
edit invalidation, transactional rollback on a failed index refresh, preservation
of the previous scope snapshot, and atomic zero publication during archive
clear:

```powershell
$env:POSTGRES_TEST_DSN = "postgresql://user:password@127.0.0.1:5433/chat_context_test"
py -3.12 -m pytest backend/test_read_model_integration.py -q
```

After a production deployment, verify the first backfill through the metadata
and measure `/api/settings`, `/api/chat/scopes`, `/api/database/status`, and the
first page of each breakdown. These routes should remain below one second while
the background worker is calculating. Internal failure details are available in
the API log and `read_model_refresh_state`; they are intentionally absent from
the public response.
