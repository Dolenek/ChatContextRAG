# Setup and operation

## Prerequisites

- Node.js 20 or newer
- Python 3.9 through the Windows `py` launcher
- Docker Desktop with Linux containers
- An OpenAI API key

Install dependencies and create the private environment file:

```powershell
npm.cmd install
py -3.9 -m pip install -r backend/requirements.txt
Copy-Item .env.example .env
```

Set `OPENAI_API_KEY` and PostgreSQL credentials in `.env`. Discord bot tokens do
not belong in this file; the UI stores them with the operating-system encryption
provided by Electron `safeStorage`.

Run `run.bat` from the repository root. It validates the runtimes, starts the
pgvector Docker service, waits for its health check, starts FastAPI on
`127.0.0.1:8765`, and opens Electron. The first source-schema migration may take
longer than an ordinary start, so Electron waits up to 60 seconds for FastAPI.
If startup fails, `run.bat` keeps the console open and includes the captured
backend error. A manual start is:

```powershell
docker compose up -d --wait --wait-timeout 60
npm.cmd start
```

## Desktop workspace

The application opens directly in the chat workspace. The narrow rail on the
left switches between chat, database detail, and model settings. **Sources and
imports** opens an overlay drawer containing the searchable conversation scope
and all Discord and WhatsApp ingestion controls. The drawer is collapsed again
when the user returns to chat; its open state is not persisted between starts.

Grounding sources for the selected assistant answer appear in the right panel.
The same panel reports raw and indexed message counts, chunks, database size,
pending work, and recent indexing jobs. Below 1,100 px it becomes a drawer opened
from the title bar. The source and context areas scroll independently from the
conversation.

## Model and API settings

The built-in **OpenAI** provider reads its API key and default model IDs from
`.env`. Open **Settings** from the gear button to add OpenAI-compatible provider
profiles. A profile supplies a display name, the complete API base URL (normally
ending in `/v1`), an optional API key, and either the Responses or Chat Completions
protocol. Keyless profiles are intended for trusted local OpenAI-compatible
servers such as an Ollama endpoint. Custom keys are encrypted with Electron `safeStorage`; the renderer,
PostgreSQL, API responses, and logs never receive them in plaintext. A platform
without a secure OS key store cannot persist custom provider keys.

The chat selector initially shows `OPENAI_CHAT_MODEL`, and the initial embedding
index uses `OPENAI_EMBEDDING_MODEL` plus `OPENAI_EMBEDDING_DIMENSIONS`. These
environment values remain effective until the user explicitly selects another
chat model or activates another ready embedding index. Existing saved choices
are never overwritten during startup.

Add the chat model IDs that should be selectable to the **Chat models** section.
Model fields load suggestions from the provider's `/models` endpoint and still
accept a model ID typed by hand, which also supports local servers that do not
list models. The selector at the bottom-right of the chat composer groups saved
models by provider. The chat screen remembers the last selection, and changing
it starts a fresh visible chat history. `OPENAI_CHAT_MODEL` remains available as
an unmanaged fallback even when it has not been added manually.

Settings can keep multiple embedding indexes over the same canonical raw
messages. Creating an index makes one small embedding request to validate its
dimension, then queues all raw messages. Exactly one ready index is active for
RAG search. **Sync** embeds missing raw messages, **Rebuild** atomically publishes
a complete replacement, and deleting a non-active index removes only its
vectors. Auto-sync applies to future ingestion and is controlled per index.

## Embedded Discord import

Open **Sources and imports**, choose **Embedded Discord**, sign in, and open a
channel. **Načíst poslední 4** performs a small import. **Procházet do databáze** traverses loaded history
upward and writes raw batches. **Zastavit** flushes the current batch and queues
indexing. **Pokračovat od poslední načtené** opens the oldest stored Discord
message and continues into older history.

The embedded workflow is independent from the optional bot. Its Discord login,
scan controls, progress, and source deep links retain their original behavior.
While Discord is visible, the source drawer stays open and the embedded browser
is laid out beside it so the scan controls remain accessible.

## Discord bot

1. Create an application and bot in the Discord Developer Portal.
2. Enable the Message Content privileged intent for the bot.
3. Open **Sources and imports**, choose **Discord bot**, and paste the bot token. The renderer never
   receives the token after the connect call.
4. Choose **Pozvat na server** and grant the bot View Channel and Read Message
   History in the channels that should be archived.
5. A server member with Manage Channels runs `/chatcontext sync` in a text
   channel or thread.

The first command imports all accessible history and enables live create/edit
tracking. `/chatcontext status` reports the channel state and `/chatcontext stop`
disables live tracking. If the application or computer stops during the initial
history scan, the next start reuses the same durable session and continues from
the last committed 100-message page. The bot only connects while the desktop
application is running. On the next start it also catches up messages created
while it was offline.

Live messages normally become searchable within 30–60 seconds plus embedding
latency. Closing the application flushes pending raw messages; a queued indexing
job resumes on the next start. Deleted Discord messages remain in the archive.

## WhatsApp export import

Export an individual or group chat from WhatsApp without binary media when
possible. The textual export still contains media placeholders.

1. Open **Sources and imports**, choose **WhatsApp export**, and select a UTF-8
   `.txt` or `.zip` file.
2. Review the detected message, media-placeholder, and system-event counts.
3. If the date is ambiguous, select DMY or MDY.
4. Select an existing WhatsApp conversation for an incremental re-import, or
   enter a name for a new conversation.
5. Choose **Importovat a zaindexovat**.

The import is fully parsed before a database session is created. Re-importing
the same export only adds deterministic new entries. WhatsApp exports have no
stable message IDs, so an edited historical entry may be stored as a new message.
ZIP archives with multiple text entries must identify one entry; binary entries
are ignored. Text over 50 MiB, invalid UTF-8, unknown formats, and suspicious ZIP
compression ratios are rejected.

## Indexing and chat

Every completed connector session creates a durable job for each ready embedding
index with auto-sync enabled. The database
overview shows raw, duplicate, indexed, and pending counts plus recent job state.
Failed jobs can be retried; active jobs can be cancelled. **Zaindexovat čekající**
recovers raw messages not currently covered by an index or active job.

Open the source drawer and select a Discord channel, WhatsApp conversation, or
all stored messages under **Chatovat nad**. Changing the scope clears visible
chat history so turns from different sources cannot influence one another. A
**New chat** action clears the visible conversation without changing the scope.

Changing the chat scope, provider, or model resets visible history. Chat is
disabled when the active embedding index or either required provider is
unavailable.

## Verification

Run tests without OpenAI charges:

```powershell
npm.cmd test
py -3.9 -m pytest backend -q
```

The optional atomic-publication test requires a dedicated empty PostgreSQL
database:

```powershell
$env:POSTGRES_TEST_DSN = "postgresql://user:password@127.0.0.1:5433/chat_context_test"
py -3.9 -m pytest backend/test_postgres_integration.py -q
```

Inspect infrastructure with `docker compose ps` and
`docker compose logs postgres`.
