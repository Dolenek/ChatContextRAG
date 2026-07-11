# Setup and operation

## Prerequisites and configuration

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

Set `OPENAI_API_KEY` and matching PostgreSQL credentials in `.env`. Never commit
that file. Defaults use `text-embedding-3-small`, 1,536 dimensions, embedding
batches of 64, and PostgreSQL port 5433.

## Starting the application

Run `run.bat` from the repository root. It verifies Node.js 20 or newer and an
exact Python 3.9 runtime, refreshes dependencies after application files change,
starts the pgvector Docker service, waits up to 60 seconds for its healthcheck,
and opens Electron. A failure in the rebuild or readiness check stops startup
instead of opening the application against unavailable infrastructure. For a
manual start:

```powershell
docker compose up -d --wait --wait-timeout 60
npm.cmd start
```

Electron starts FastAPI on `127.0.0.1:8765`.

## Importing Discord history

1. Choose **Nahrát pomocí Discordu** and open a channel.
2. Use **Načíst poslední 4** for a small import, or **Procházet do databáze** for
   continuous history traversal.
3. Use **Zastavit** to flush the current raw batch. Reaching the channel start
   also closes the scan automatically.
4. The toolbar changes from Discord/raw progress to RAG indexing progress.
   Closing or restarting the application does not lose the queued job.
5. Use **Pokračovat od poslední načtené** to jump to the oldest raw message and
   continue into older history.

Traversal stores raw data only and therefore does not wait for OpenAI. After a
session closes, indexing streams the complete session chronologically, creates
conversation chunks, stages `halfvec(1536)` vectors, and atomically publishes
them only after every embedding batch succeeds. Cancelling or failing a job
keeps the previous searchable index intact. The database overview
shows raw messages, unique texts, duplicates, indexed and pending messages,
database size, and recent jobs. Failed jobs can be retried and active jobs can
be cancelled there. Indexing claims use renewable leases, allowing multiple
backend processes to share the queue without resetting or publishing each
other's jobs; work abandoned by a stopped process becomes claimable after the
90-second lease expires.

Legacy chunks remain available until **Vymazat databázi** is confirmed with
`VYMAZAT`. Clearing removes legacy chunks, raw messages, jobs, and new vectors,
but preserves the Discord login partition and database schema.

## Verification and evaluation

Run tests without OpenAI charges:

```powershell
npm.cmd test
py -3.9 -m pytest backend -q
```

The PostgreSQL atomic-publication test is skipped by default. Run it only
against a dedicated empty test database by setting `POSTGRES_TEST_DSN`; the test
creates isolated rows, verifies the staged replacement, and removes those rows:

```powershell
$env:POSTGRES_TEST_DSN = "postgresql://chat_context:password@127.0.0.1:5433/chat_context_test"
py -3.9 -m pytest backend/test_postgres_integration.py -q
```

Inspect infrastructure with `docker compose ps` and `docker compose logs postgres`.
