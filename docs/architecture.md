# Architecture

Chat Context RAG is a local desktop application with two runtime processes:

- Electron owns the desktop window, the isolated Discord browser surface, and IPC boundaries.
- FastAPI owns message persistence and database-backed question answering.

Electron launches FastAPI on `127.0.0.1:8765`. The backend stores messages in the project-local `chat_context.db` SQLite database. The renderer cannot access Node.js or Electron APIs directly; its preload bridge exposes four narrow operations.

## Configuration and secrets

FastAPI loads project configuration from `.env` through `ApplicationSettings`. API keys are never stored in source files or `.env.example`; the example file declares blank placeholders only. The current implementation recognizes `OPENAI_API_KEY` as an optional future integration setting and does not transmit it or require it for local database chat.

## Discord import

The Discord surface uses an Electron `BrowserView` with the persistent `persist:discord` session. Login state stays in that dedicated partition. When the user requests an import, Electron executes a read-only DOM extraction in the current Discord page. It selects visible list items whose identifiers start with `chat-messages-`, keeps the final four, and derives author, timestamp, channel, and Discord message identifier. Plain text, rich embeds, and attachment-only messages have explicit extraction fallbacks.

Only the extracted message fields are sent to the local FastAPI service. Duplicate Discord identifiers are ignored by SQLite.

## Database chat

The chat endpoint extracts meaningful terms from the question and searches stored message content. Its response includes the matching messages as sources. This local baseline does not call an external language model and does not claim to synthesize facts beyond stored messages.

## Extension points

Persistence conforms to the `MessageRepository` protocol. A vector database or remote store can replace SQLite without changing API routes. `DatabaseChatService` is isolated from transport and can later be replaced by an embedding retriever or an LLM-backed answer generator.
