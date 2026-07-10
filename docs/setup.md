# Setup and operation

## Prerequisites

- Node.js 20 or newer
- Python 3.9 available through the Windows `py` launcher

Install dependencies:

```powershell
npm.cmd install
py -3.9 -m pip install -r backend/requirements.txt
```

## Environment configuration

Copy `.env.example` to `.env` before adding API credentials:

```powershell
Copy-Item .env.example .env
```

All API keys must be stored only in `.env`. The populated file is ignored by Git; `.env.example` contains variable names and safe defaults only. The current local search implementation does not require an API key, so `OPENAI_API_KEY` may remain blank.

Restart the desktop application after changing `.env`; configuration is loaded when FastAPI starts.

`CHAT_CONTEXT_DATABASE` selects the SQLite file. Relative paths are resolved from the project root.

Start the desktop application:

```powershell
npm.cmd start
```

The app starts FastAPI automatically and loads `.env` from the project root. To run only the API during development, use `npm.cmd run backend`.

## Import flow

1. Choose **Nahrát pomocí Discordu**.
2. Sign in to Discord in the embedded surface and open a chat.
3. Ensure the desired messages are visible in the viewport.
4. Choose **Načíst poslední 4** in the application toolbar.

The app imports up to four currently visible messages. It does not fetch server history, use a Discord bot, or read chats that are not displayed.

## Verification

Run the JavaScript and backend tests:

```powershell
npm.cmd test
py -3.9 -m pytest backend/test_app.py
```
