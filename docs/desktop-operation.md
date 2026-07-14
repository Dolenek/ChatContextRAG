# Desktop operation

The application opens in the chat workspace. The expanded navigation rail can
be changed to a compact icon-only mode, and the desktop preference is restored
on the next start. Narrow windows and embedded Discord use a temporary compact
layout without overwriting that preference.

**New chat** retains the selected source and model, then chooses Adaptive only
when that model enables archive tools. Adaptive requests have a 120-second
backend deadline and a 130-second Electron/web streaming timeout. Ordinary API
requests retain the shared 30-second timeout.

Recent backend-stored chats appear in the expanded rail. Selecting one restores
ordered messages, sources, source scope, provider, model, reasoning effort,
retrieval mode, evidence limit, and completed archive-tool timeline. Rename and
permanent deletion are available from the row menu. A restored session never
adopts later model-setting changes.

## Settings and workspace timezone

**Settings** contains provider keys, chat models, embedding indexes, indexing
history, and workspace configuration. Electron additionally selects its Local
or Remote backend target. Closing the modal discards unfinished form values.
Remote non-loopback HTTP displays a transport warning and cannot be tested or
saved until it is acknowledged. The acknowledgement applies only to the exact
normalized origin; changing the scheme, host, or port requires a new one.
Loopback HTTP targets do not show the warning.

The searchable IANA timezone field defaults to `UTC` for new and migrated
workspaces. Set it to the archive's intended calendar zone, for example
`Europe/Prague`, before relying on date-bounded adaptive searches. The setting is
stored in the active backend workspace, so Web and Electron Remote share it.
Changing it affects future tool calls; it does not rewrite persisted chat
sessions or message timestamps.

**Sources and imports** opens the source and connector drawer independently of
Settings. Selecting another scope starts a clean conversation. The renderer
never sends scope as a model-controlled tool argument.

## Grounding and live archive steps

The right panel shows every unique original message exposed to the model for the
selected answer. Adaptive thinking cards also show `search_archive` and
`read_message_context` activity as NDJSON records arrive. After the final answer,
the list becomes the collapsed **Archivní kroky (N)** disclosure and is restored
with the assistant message later. Deterministic answers do not show this list.

The panel also reports raw and indexed message counts, chunk count, database
size, pending work, and active indexing jobs. At narrow widths it becomes a
drawer. Live events update running jobs while polling remains the authoritative
fallback. Connector, indexing, and session operation are described in
[Setup and operation](setup.md#indexing-and-chat).
