# Public API

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
- `/integrations/discord-bot` persists the bot model, strict guild permissions,
  answer generation and delivery audit, and paginated history. Its complete
  contract is documented in [Discord bot](discord-bot.md).
- `POST /imports/whatsapp/preview` validates and previews a multipart export.
- `POST /imports/whatsapp` imports a validated multipart export and queues it.
- `GET /indexing/jobs?status=active` returns every queued and running job in one
  bounded query. `GET /indexing/jobs/{id}`, retry, cancel, and pending endpoints
  manage individual jobs. Job views include source type plus conversation and
  container labels.
- `GET /chat/scopes` lists active-index conversations from the persistent UI
  read model.
- `POST /chat` performs source-scoped deterministic or adaptive RAG with an
  optional provider, model, reasoning effort, mode, evidence limit, and
  `session_id`. Adaptive models choose between semantic active-index retrieval
  and direct occurrence search over canonical raw messages inside the server-owned
  scope; the complete tool contract is documented in
  [Chat retrieval and archive tools](chat-retrieval.md).
- `POST /chat/stream` performs the same operation and emits NDJSON tool activity
  before the complete final response. Direct-search activity includes patterns,
  match mode, boolean operator, ordering, result limit, and chronology status.
- `GET /chat/sessions?limit=N` lists recent session summaries.
- `GET /chat/sessions/{id}` returns context, ordered messages, and grounding
  sources. `PATCH` renames and `DELETE` removes one chat. Unknown IDs return
  `404`; continuation with changed context returns `409`.
- `/settings/providers` lists redacted provider metadata and model suggestions.
- `/settings/embedding-indexes` manages independent vector indexes, activation,
  synchronization, rebuild, and deletion.
- `GET` and `PUT /settings/workspace` manage the validated IANA timezone.
- `GET /database/resume-point` remains the local Discord scanner resume endpoint.
- `GET /database/status` combines live database size and jobs with persistent
  projections. `fresh=true` queues active refresh work and returns immediately.
- `POST /database/read-model/refresh` queues an immediate `active` or `all`
  projection refresh without waiting.
- `GET /database/breakdowns/{dimension}?limit=N&offset=N` pages exact raw-message
  counts by conversation or author, or embedding-model counts for the active
  index, with limits from 1 through 200.
- `GET /database/breakdowns` retains the combined counts for compatibility.
- `GET /database/chunks?limit=N&cursor=...` returns active-index chunks with an
  opaque keyset cursor.
- `GET /database/overview` retains the combined offset-paginated response for
  compatibility.
- `DELETE /database` requires `VYMAZAT`, clears source data, and retains chat
  history.

The projection tables, invalidation rules, metadata, bootstrap, and failure
recovery are documented in [Persistent UI read model](ui-read-model.md).

`/api/migrations` and its children are bearer-only gateway routes used by
Electron Local. Browser sessions receive `403` even with valid CSRF.
`/internal/migration-exports` requires the internal token and is absent from the
gateway allowlist.
