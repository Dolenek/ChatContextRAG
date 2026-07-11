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

Run `run.bat` from the repository root. It validates dependencies, starts the
pgvector Docker service, and opens Electron. For a manual start:

```powershell
docker compose up -d
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
conversation chunks, and stores `halfvec(1536)` vectors. The database overview
shows raw messages, unique texts, duplicates, indexed and pending messages,
database size, and recent jobs. Failed jobs can be retried and active jobs can
be cancelled there.

Legacy chunks remain available until **Vymazat databázi** is confirmed with
`VYMAZAT`. Clearing removes legacy chunks, raw messages, jobs, and new vectors,
but preserves the Discord login partition and database schema.

## Verification and evaluation

Run tests without OpenAI charges:

```powershell
npm.cmd test
py -3.9 -m pytest backend -q
```

Inspect infrastructure with `docker compose ps` and `docker compose logs postgres`.
