# Setup and operation

## Prerequisites

- Node.js 20 or newer
- Python 3.9 available through the Windows `py` launcher
- Docker Desktop with Linux containers
- An OpenAI API key

Install application dependencies:

```powershell
npm.cmd install
py -3.9 -m pip install -r backend/requirements.txt
```

## Environment configuration

Copy the safe template and set local secrets:

```powershell
Copy-Item .env.example .env
```

Set `OPENAI_API_KEY` and replace the example PostgreSQL password in both `POSTGRES_PASSWORD` and `POSTGRES_DSN`. Never commit `.env`. Restart FastAPI after any configuration change.

Default AI configuration:

- `OPENAI_EMBEDDING_MODEL=text-embedding-3-small`
- `OPENAI_EMBEDDING_DIMENSIONS=1536`
- `OPENAI_EMBEDDING_BATCH_SIZE=64`
- `OPENAI_CHAT_MODEL=gpt-5.6-luna`

The local PostgreSQL container uses host port `5433` to avoid common conflicts with an existing PostgreSQL installation.

## Start infrastructure and application

On Windows, the simplest option is to run `run.bat` from the repository root. The launcher validates prerequisites, refreshes Node and Python dependencies when application files have changed, starts PostgreSQL through Docker Compose, and then starts the Electron application. The first run is treated as requiring a dependency rebuild. A successful rebuild is recorded under the ignored `node_modules/` directory.

Before using the launcher, create and configure `.env` as described above. Docker Desktop must be running.

For a manual start, start PostgreSQL with pgvector:

```powershell
docker compose up -d
docker compose ps
```

Then start the desktop application:

```powershell
npm.cmd start
```

Electron starts FastAPI automatically on `127.0.0.1:8765`. To run only the API during development, use `npm.cmd run backend`.

## Import flow

1. Choose **Nahrát pomocí Discordu**.
2. Sign in to Discord in the embedded surface and open a chat.
3. Ensure the desired messages are visible in the viewport.
4. Choose **Načíst poslední 4** in the application toolbar.

The app normalizes and chunks up to four visible messages, sends chunk text to the OpenAI embeddings API, and upserts vectors plus source metadata into PostgreSQL. It does not fetch Discord server history or use a Discord bot.

To import channel history automatically, open a channel and choose **Procházet do databáze**. The app scrolls upward while the toolbar shows total elapsed time and the number of messages waiting for storage. Messages are written in batches of up to 400 to reduce OpenAI and PostgreSQL round trips. Choose **Zastavit** to flush the current partial batch and interrupt traversal. Discord messages traversed this way are sent to OpenAI for embedding. Re-running the traversal skips source message IDs already stored in the database.

To continue an earlier traversal, open the same Discord channel and choose **Pokračovat od poslední načtené**. The app jumps to the oldest message already stored for that channel and continues toward the beginning. Existing imports created before stable channel IDs were stored are located by their channel name; future imports use Discord channel IDs.

## Verification

Run isolated tests without consuming OpenAI API credits:

```powershell
npm.cmd test
py -3.9 -m pytest backend -q
```

Inspect PostgreSQL when diagnosing infrastructure:

```powershell
docker compose ps
docker compose logs postgres
```
