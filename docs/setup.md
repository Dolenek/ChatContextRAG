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

## Embedded Discord import

Choose **Nahrát pomocí Discordu**, sign in, and open a channel. **Načíst poslední
4** performs a small import. **Procházet do databáze** traverses loaded history
upward and writes raw batches. **Zastavit** flushes the current batch and queues
indexing. **Pokračovat od poslední načtené** opens the oldest stored Discord
message and continues into older history.

The embedded workflow is independent from the optional bot. Its Discord login,
scan controls, progress, and source deep links retain their original behavior.

## Discord bot

1. Create an application and bot in the Discord Developer Portal.
2. Enable the Message Content privileged intent for the bot.
3. Choose **Přidat Discord bota** and paste the bot token. The renderer never
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

1. Choose **Nahrát WhatsApp export** and select a UTF-8 `.txt` or `.zip` file.
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

Every completed connector session creates a durable indexing job. The database
overview shows raw, duplicate, indexed, and pending counts plus recent job state.
Failed jobs can be retried; active jobs can be cancelled. **Zaindexovat čekající**
recovers raw messages not currently covered by an index or active job.

Choose **Povídat s databází** and select a Discord channel, WhatsApp conversation,
or all stored messages under **Chatovat nad**. Changing the scope clears visible
chat history so turns from different sources cannot influence one another.

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
