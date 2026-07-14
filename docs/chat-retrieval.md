# Chat retrieval and archive tools

`POST /chat` supports two retrieval modes. `deterministic` preserves the original
single-pass RAG behavior and remains the API default. `adaptive` is available to
models whose saved configuration enables archive tools. New composer chats use
adaptive mode for those models and deterministic mode for all other models.
Old request payloads and migrated chat sessions remain deterministic.

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

1. The first model turn is forced to call `search_archive`. Its prompt includes
   the last eight history turns and requires a standalone query that resolves
   people, events, topics, pronouns, and time references.
2. The server executes the search against the same active index and source scope
   as deterministic retrieval. The second model turn may answer or request up to
   two more archive actions in their received order.
3. If more actions were requested, the third and final model turn receives their
   outputs with tools disabled. A provider that returns another tool call or no
   final text fails with an explicit integration error.

The internal read-only tools are:

- `search_archive(query)`: searches at most eight chunks and resolves them to
  original messages before returning evidence.
- `read_message_context(evidence_id, before_count, after_count)`: accepts only an
  evidence ID already issued in the loop and reads zero to ten messages on each
  side of its anchor. At least one neighbor is required. This read follows
  `message_order`, ignores the indexing 20-minute boundary, and never leaves the
  anchor's source conversation.

Scope is not a model-controlled tool argument. The executor always attaches the
scope from `ChatRequest`. A global search can find any conversation, while every
context read remains in the conversation of its selected anchor.

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
whether or not the answer cited it. Search results use
`evidence_origin="search"`; neighboring messages use `"context"` and do not
pretend to have an independent retrieval score.

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
timeout. Electron and the web gateway allow 130 seconds only for adaptive
`/chat` requests; other backend requests retain their ordinary timeout.

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

The source projector resolves retrieved chunks into original messages, keeps
retrieval order, deduplicates messages, and retains exact chunk context. Stored
legacy chunk-shaped sources are expanded when their raw messages remain
available. A missing raw record stays represented by its safe stored fallback.
Raw retrieval scores remain in `similarity_score`; `match_score` normalizes
search results for display. Context evidence is labeled as neighboring context
instead of displaying a synthetic match score.
