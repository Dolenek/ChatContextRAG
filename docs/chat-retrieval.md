# Chat retrieval and archive tools

`POST /chat` supports two retrieval modes. `deterministic` preserves the original
single-pass RAG behavior and remains the API default. `adaptive` is available to
models whose saved configuration enables archive tools. New composer chats use
adaptive mode for those models and deterministic mode for all other models.
Old request payloads and migrated chat sessions remain deterministic.

The application chat remains strictly archive-grounded in both modes. The
Discord bot reuses the retrieval engine with a separate policy that can combine
an immutable recent-room snapshot, room-scoped historical evidence, and the
selected model's general knowledge. That policy does not change `POST /chat` and
is documented in [Discord bot](discord-bot.md).

## Deterministic retrieval

The current question is embedded once. Hybrid retrieval combines candidates from
the active index and PostgreSQL full-text search under the selected source scope.
The selected provider receives the ranked chunks together with at most eight chat
history turns and returns the answer. Chat history does not rewrite or retry the
retrieval query in this mode.

Full-text candidates expand only inside their source conversation, stop at a
20-minute gap, and contain at most 12 messages. Vector and full-text ranks are
combined with reciprocal-rank fusion and a small recency multiplier. If hybrid
retrieval has no results, the legacy vector repository remains the fallback.

## Adaptive retrieval

Adaptive retrieval is a bounded three-turn agent loop:

1. The first model turn must choose exactly one retrieval call. It uses
   `search_archive` for semantic relevance or `search_text_occurrences` for
   direct terms, phrases, and first/last-occurrence questions. Its prompt includes
   the last eight history turns and requires standalone arguments that resolve
   references from chat history.
2. The server attaches the selected source scope and executes the search. The
   second model turn may answer or request up to two more archive actions in their
   received order.
3. If more actions were requested, the third and final model turn receives their
   outputs with tools disabled. A provider that returns another tool call or no
   final text fails with an explicit integration error.

The internal read-only tools are:

- `search_archive(query, date_from, date_to)`: searches at most eight chunks and
  resolves them to original messages before returning evidence. Dates are
  nullable `YYYY-MM-DD` values. They are inclusive calendar dates in the
  workspace timezone and remain separate from the semantic query.
- `search_text_occurrences(patterns, match_mode, operator, sort, limit,
  date_from, date_to)`: searches canonical raw messages without depending on the
  active embedding index. One through eight patterns use whole tokens,
  token-prefix matching, or tokenized phrases; patterns are combined with `all`
  or `any`. Results are ordered oldest or newest and limited from 1 through 20.
  Prefix matching is case-insensitive and uses the existing `simple` PostgreSQL
  text-search index, so `deadlock` matches `deadlocku` and `deadlocky`. Diacritics
  remain significant; the model may provide spelling variants with `any`.
- `read_message_context(evidence_id, before_count, after_count)`: accepts only an
  evidence ID already issued in the loop and reads zero to ten messages on each
  side of its anchor. At least one neighbor is required. This read follows
  `message_order`, ignores the indexing 20-minute boundary, and never leaves the
  anchor's source conversation.

Scope is not a model-controlled tool argument. The executor always attaches the
scope from `ChatRequest`. Direct text search sees every stored raw message inside
that scope, including messages not yet embedded; it cannot cross from a selected
WhatsApp conversation into Discord. A global search can find any source and
conversation, while every context read remains in the conversation of its
selected anchor.

Scoped text results follow canonical `message_order`. Global text results use
`sent_at`, put undated matches last, and return `chronology_complete=false` when
any matching raw message lacks a timestamp. The model is instructed not to claim
a definitive global first or last occurrence in that case. A returned message
without a timestamp cannot support a calendar date.

The workspace timezone is loaded once for each adaptive request. The prompt
receives its IANA name, the current local time, and instructions to express a
calendar constraint through the structured date arguments. New and migrated
workspaces use `UTC`; an administrator may change the shared value through
`GET`/`PUT /settings/workspace`. The value is request-specific and is not pinned
to a chat session.

## Calendar-bounded retrieval

The server converts local dates with the IANA timezone database into a UTC
half-open interval `[start, end)`. `date_to` is implemented as the following
local midnight, so the complete final date is included and daylight-saving
transitions are not assumed to last 24 hours.

The interval is enforced in PostgreSQL at every evidence boundary:

- vector candidates must have a chunk interval overlapping the requested range;
- full-text candidates must have a canonical message timestamp inside it;
- direct text occurrences must have a canonical message timestamp inside it;
- messages projected from a matching chunk are filtered again by timestamp;
- `read_message_context` inherits the anchor evidence's interval and cannot
  cross it, even though it ignores the ordinary 20-minute chunk boundary.

Both candidate paths inspect at most 32 rows. A bounded interval is divided into
at most eight temporal buckets. The best reciprocal-rank candidate from each
non-empty bucket is selected first, then remaining positions are filled by the
global score. The model still receives at most eight chunks and 48 unique
messages. Time-aware chunk and canonical-message indexes support these filters;
retrieval and context statements retain their 10-second timeout. Vector searches
with a source or calendar filter enable pgvector's strict iterative HNSW scan, so
the graph traversal continues past globally close rows rejected by server-owned
filters instead of incorrectly returning an empty candidate set.

## Evidence and security

The evidence registry assigns stable `[E1]`, `[E2]`, and later identifiers in
first-visible order. Original messages are deduplicated by source type,
conversation, and source message ID. A duplicate tool result contains only its
existing evidence ID, not a second copy of the text.

Adaptive evidence has a per-chat character limit from 4,000 through 48,000. A
model configuration defaults to 24,000. At most 48 unique messages are exposed.
The final fitting message may be shortened and carries `content_truncated`; later
results carry `budget_exhausted`. The persisted and returned `sources` array
contains every unique original message whose content was visible to the model,
whether or not the answer cited it. Semantic results use
`evidence_origin="search"`, direct occurrences use `"text_search"`, and
neighboring messages use `"context"`. Direct and context evidence do not display
a synthetic similarity score.

Archive results are serialized only as JSON function outputs. They are never
inserted as system, developer, or user messages. The controlling instruction
labels all archived text as untrusted evidence and forbids it from changing
rules, scope, or function arguments. Tool arguments are also validated on the
server, so archived prompt-injection text cannot expand the read boundary.

## Provider protocols and limits

The shared agent contract follows the [OpenAI function-calling
flow](https://developers.openai.com/api/docs/guides/function-calling) with
separate Responses and Chat Completions adapters.
Responses preserves returned output items and adds `function_call_output` items.
Chat Completions preserves assistant tool-call messages and adds messages with
the `tool` role. Both preserve reasoning effort and the full tool-call state.
Built-in OpenAI tools use strict schemas. Custom OpenAI-compatible profiles use
non-strict schemas and the same server-side argument validation.

Every adaptive model request disables SDK retries. The complete loop has a
120-second deadline, each provider request is capped by the remaining deadline
and 45 seconds, and each retrieval database operation has a 10-second statement
timeout. Electron and the web gateway allow 130 seconds only for adaptive chat
requests; other backend requests retain their ordinary timeout.

## API and persistence

`ChatRequest` adds `retrieval_mode` (`deterministic` or `adaptive`) and optional
`evidence_character_limit`. Omitting both preserves the old deterministic
contract. An adaptive request without a limit resolves to 24,000.

`ChatResponse` and `ChatSessionDetail` expose the effective mode and fixed
evidence limit. `ChatSource.evidence_origin` defaults to `search`, which keeps
old stored source JSON valid. Chat sessions persist scope, provider, model,
reasoning effort, mode, and evidence limit. A continuation must match all six
properties. Restored sessions use their stored mode and limit; changing any of
these composer settings starts a new chat.

`POST /chat/stream` returns NDJSON records named `tool_started`,
`tool_completed`, `tool_failed`, `tool_skipped`, `final`, and `error`. The web
gateway forwards records as they arrive, while Electron correlates IPC progress
by request ID. `POST /chat` remains synchronous and returns the same final audit.
Each assistant message persists `tool_activity`; old rows migrate to `[]`.

The audit contains only the tool order, name, status, typed safe arguments,
workspace timezone, normalized UTC interval, result and new-evidence counts,
text-search ordering and chronology status, budget state, safe error code, and
duration. It never stores model reasoning, provider payloads, tool-output message
content, credentials, or server-owned scope. A disconnected client aborts the
proxy read; the backend loop remains bounded by its deadline.

The source projector resolves retrieved chunks into original messages, keeps
retrieval order, deduplicates messages, and retains exact chunk context. Stored
legacy chunk-shaped sources are expanded when their raw messages remain
available. A missing raw record stays represented by its safe stored fallback.
Raw retrieval scores remain in `similarity_score`; `match_score` normalizes
semantic search results for display. Context and direct-text evidence use explicit
origin labels instead of displaying a synthetic match score.
