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

Start PostgreSQL with pgvector:

```powershell
docker compose up -d
docker compose ps
```

Start the desktop application:

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

To import channel history automatically, open a channel and choose **Procházet do databáze**. The app scrolls upward and writes new messages continuously. Choose **Zastavit** to interrupt it. Discord messages traversed this way are sent to OpenAI for embedding. Re-running the traversal skips source message IDs already stored in the database.

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
