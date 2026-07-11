# Architecture

Chat Context RAG is a local Electron application backed by FastAPI, PostgreSQL, pgvector, and the OpenAI API.

- Electron owns the desktop window, isolated Discord browser surface, and narrow IPC bridge.
- FastAPI owns ingestion, retrieval, and RAG orchestration.
- PostgreSQL with pgvector stores conversation chunks, vectors, and source metadata.
- OpenAI creates embeddings and generates grounded chat responses.

## Ingestion pipeline

The canonical Discord ingestion flow is:

```text
selected visible Discord messages
    -> Unicode and whitespace normalization
    -> conversation-aware chunking
    -> batched text inputs
    -> OpenAI embeddings API
    -> pgvector storage with source metadata
```

The normalizer preserves message order and identity while removing formatting noise. The chunker keeps nearby messages from the same channel together, starts a new chunk when the channel changes or the time gap exceeds 20 minutes, and caps chunks at 1,800 characters. Deterministic chunk identifiers make repeated imports idempotent.

`OpenAIEmbeddingProvider` batches chunk texts according to `OPENAI_EMBEDDING_BATCH_SIZE`. The default embedding configuration is `text-embedding-3-small` with 1,536 dimensions, matching the vector column. See the [OpenAI embeddings guide](https://developers.openai.com/api/docs/guides/embeddings).

### Automatic channel traversal

The Electron toolbar can traverse the currently selected Discord channel toward its oldest message. Each step extracts up to 100 rendered `chat-messages-*` items, finds the scrollable ancestor dynamically, and moves upward by 85% of the viewport. Extracted messages accumulate in a deduplicated in-memory queue and are persisted chronologically in batches of up to 400. This avoids waiting for OpenAI and PostgreSQL after every viewport while keeping the queue bounded. A batch is marked as seen only after successful storage, so transient OpenAI or PostgreSQL failures are retried without losing messages.

Traversal uses a short delay between ordinary scroll steps and a longer delay while Discord reports the top of its currently loaded history. It has no step or inactivity limit. Slow loading, unchanged virtualized views, API failures, and temporary navigation away from the selected channel put it into a waiting/retry state. It ends only when the user stops it or the same oldest message remains at scroll position zero for 12 consecutive checks, confirming the actual beginning of the channel. Any queued partial batch is stored before a user-requested stop completes.

The backend checks source message IDs already present in pgvector before embedding, so repeated traversals do not spend API calls or create chunks for previously stored messages.

The toolbar displays elapsed wall-clock time for the full traversal, including retry waits. **Pokračovat od poslední načtené** resolves the oldest stored Discord message for the selected channel, opens its Discord deep link, and resumes traversal toward older history. New chunks store stable Discord guild and channel IDs in metadata; legacy chunks without those IDs are matched by channel name. Source-ID deduplication remains active during resumed traversal.

## Vector storage and retrieval

`PostgresVectorRepository` creates the `vector` extension and a `conversation_chunks` table on first use. Each row contains normalized content, authors, source Discord message IDs, channel, time range, embedding model, JSON metadata, and the vector itself.

An HNSW index using `vector_cosine_ops` serves nearest-neighbor retrieval. The repository is behind the `VectorRepository` protocol so another vector store can replace PostgreSQL without changing orchestration. See the [pgvector project](https://github.com/pgvector/pgvector) and its [Python integration](https://github.com/pgvector/pgvector-python).

## RAG chat

For each question, FastAPI embeds the question, retrieves the five closest chunks by cosine similarity, and sends those chunks plus recent user/assistant turns to the OpenAI Responses API. Retrieved Discord content is explicitly treated as untrusted evidence rather than model instructions. The answer prompt requires source markers such as `[1]` and requires the model to acknowledge missing evidence.

The default generation model is `gpt-5.6-luna` with low reasoning effort. It can be replaced through `OPENAI_CHAT_MODEL`. The implementation uses the [OpenAI Responses API](https://developers.openai.com/api/docs/guides/text).

## Database overview

`GET /database/overview` is a read-only, paginated inspection endpoint. It reports chunk and source-message totals, distinct channels and authors, message date range, channel/author/model distributions, and stored chunk content with source identifiers. The Electron overview screen loads 50 chunks at a time and does not call the OpenAI API.

`GET /database/resume-point` returns the oldest stored Discord source message ID for a channel. It prefers indexed stable channel metadata and falls back to an indexed channel name only for legacy chunks.

`DELETE /database` removes every conversation chunk and vector while leaving the schema and Discord login partition intact. Both the API and Electron confirmation dialog require the exact `VYMAZAT` confirmation token.

## Configuration and secrets

FastAPI loads configuration from `.env` through `ApplicationSettings`. `.env` is ignored and all API credentials and database passwords belong there. `.env.example` contains only variable names and safe placeholders.

Changing `OPENAI_EMBEDDING_DIMENSIONS` requires a fresh compatible vector schema. Existing rows cannot mix vector dimensions.
