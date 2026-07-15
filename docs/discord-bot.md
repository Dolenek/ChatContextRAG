# Discord bot

The Discord bot is an optional connector and question-answering surface. It can
archive channels through slash commands and answer questions in a guild room
without changing the grounding policy of the application's ordinary chat.

## Runtime and Discord configuration

Electron Local runs the bot in the Electron main process while the application
is open. Web and Electron Remote run the bot in the Node gateway and restore it
when the gateway starts. Only the runtime that owns the selected workspace runs
the bot.

Create a bot in the Discord Developer Portal and enable both privileged gateway
intents:

- **Message Content Intent**, for synchronization, questions, and recent room
  context;
- **Server Members Intent**, for the searchable member picker.

Open **Settings > Discord bot**, enter the token, and connect. Electron Local
encrypts the token with `safeStorage`; the web gateway encrypts it with
`CHAT_CONTEXT_SERVER_KEY`. The renderer cannot read a stored token. The invite
requests `ViewChannel`, `ReadMessageHistory`, `SendMessages`,
`SendMessagesInThreads`, and `AddReactions` together with the bot and application
command scopes.

**Turn off bot** disconnects the Discord client while retaining the encrypted
token. **Turn on bot** reconnects with that stored token, so it does not need to
be entered again. The enabled state persists across application and gateway
restarts. **Disconnect and remove token** remains a separate destructive action
that removes both the credential and its enabled state. Ordinary application
shutdown does not change the configured enabled state.

The **Discord bot** item in **Sources and imports** is a shortcut to this settings
section. It does not contain a second configuration drawer.

## Model configuration

The bot has one workspace-wide model configuration, independent from the model
currently selected in the application chat: provider, model, optional reasoning
effort, deterministic or adaptive retrieval, and the adaptive evidence character
limit. The settings UI selects from managed chat models, and the provider must
be available when an answer is generated. General knowledge means only knowledge
already available to that model. The bot does not perform web searches.

## Guild access policy

Each guild has two independent allowlists:

- **Manage synchronization** controls `/chatcontext sync`, `status`, and `stop`;
- **Ask questions** controls mention and reply questions.

An allowlist is the union of its selected Discord roles and users. Empty means
that nobody is allowed. Guild ownership, `Administrator`, `Manage Channels`, and
other Discord permissions never bypass these lists. A denied slash command gets
an ephemeral response. A denied message question causes no AI request and gets
a 🚫 reaction when the bot can add reactions; otherwise it is ignored.

Each allowlist has one searchable multi-select for both roles and members. Role
names are filtered from the connected guild directory and member matches are
loaded through Discord search. Selected subjects store the Discord ID and
display name. A deleted or inaccessible subject remains visible as unavailable
until an administrator removes it. Member lookup requires the Server Members
intent.

## Synchronization commands

An authorized member runs `/chatcontext sync` in a guild text channel or thread.
The first sync imports accessible history in durable 100-message pages and then
enables live create and edit tracking. `/chatcontext status` reports the room
state, and `/chatcontext stop` disables live tracking.

Every command is acknowledged ephemerally before permission checks or storage
work. Status refreshes the durable state and archive counts instead of relying
only on the runtime cache. Per-room state writes are serialized, so a sync that
finishes after `stop` cannot re-enable tracking; a later explicit `sync` can
enable it again.

Interrupted history import resumes its durable ingestion session from the last
committed page. Startup catches up from the newest stored cursor. Live updates
are deduplicated by Discord message ID and close ordinary ingestion sessions so
ready auto-sync indexes receive durable indexing jobs. Discord deletions are not
propagated because PostgreSQL is an archive.

## Question trigger and admission

Only `MessageCreate` in a guild text room or thread can ask a question. The
message must directly mention the bot or reply to a message sent by the bot.
Direct messages and edits never trigger an answer.

Each room runs one question at a time and queues at most five more. A user has a
10-second cooldown within a guild. A queued question gets ⏳, a cooldown question
gets ⏱️, and a full queue gets 🚫. Queue and access rejections do not call the AI
provider.

## Immutable recent-room snapshot

Admission captures an immutable snapshot before the request is queued. It:

- contains at most ten messages before the trigger;
- excludes the trigger and messages authored by the bot;
- excludes messages more than 30 minutes older than the trigger;
- is chronological after selection, while newest messages receive priority;
- serializes to at most 8,000 characters.

If the newest eligible message alone exceeds the budget, its content is shortened
and marked `[Content truncated]`. A failed Discord history read produces a safe
audit warning and an empty snapshot instead of blocking the answer. Snapshot
content is sent to the selected AI provider even when the room is not synchronized.

## Retrieval and answer policy

The bot never waits for indexing. Historical retrieval uses only the latest ready
active index, is scoped to the current Discord room, has a strict cutoff at the
trigger time, and explicitly excludes the trigger message. Missing or stale
indexing therefore cannot remove the live snapshot from the request.

Both deterministic and adaptive bot requests treat room messages as untrusted
evidence, never as instructions. The model decides whether evidence is relevant;
there is no fixed score threshold. A room fact used in the answer must cite its
evidence ID. Valid citations are converted during delivery to links of the form
`https://discord.com/channels/{guild}/{channel}/{message}`.

When no room evidence is relevant, the bot answers from the selected model's
general knowledge without a prefix, badge, or fallback announcement. Evidence
that was found but not cited remains visible in the audit as unused. A response
without a valid linkable citation is internally classified as general knowledge.

This fallback policy belongs only to the Discord bot. `POST /chat` and the
application composer remain strictly archive-grounded as documented in
[Chat retrieval and archive tools](chat-retrieval.md).

## Reply chains and delivery

Every sent Discord message ID is mapped to its answer audit. A reply to any part
of a split answer loads the same chain and supplies at most the last eight
user/assistant items to the model. Replying to an older bot message without a
mapping starts a new chain. Deleting an audit removes that answer from future
follow-up history.

Answers are split at safe whitespace boundaries below Discord's 2,000-character
message limit. The first part replies to the trigger and later parts are sent to
the same room. All resulting Discord message IDs are persisted. Deleting an
audit never deletes those Discord messages.
If delivery fails, the audit records `delivery_failed`, preserves IDs of any
parts already sent, and adds a safe warning without storing Discord payloads.

## Answer history and deletion

**Show answer history** opens a newest-first paginated audit. It can filter by
guild and room. The detail contains the question and answer, author and trigger,
model configuration, immutable recent snapshot, all found and cited evidence,
normalized match scores, bounded tool activity, safe warnings and errors, and
sent Discord message IDs.

The audit never stores hidden chain-of-thought, provider payloads, credentials,
or raw tool-output messages. An administrator may confirm deletion of one answer,
all answers for a guild, or all Discord answer history. These actions leave the
Discord messages and raw archive untouched.

Bot settings, guild permission subjects, answer audits, and delivery mappings
have no expiry. They are stored in PostgreSQL separately from the raw archive.
The Local-to-Remote archive migration transfers raw messages and synchronization
cursors only; it does not transfer this configuration or answer history.

## Backend and bridge contract

FastAPI exposes the canonical internal contract under
`/integrations/discord-bot`:

- `GET /settings` and `PUT /settings/model`;
- `PUT /guilds/{guild_id}/permissions`;
- `POST /answers` and `PATCH /answers/{answer_id}/delivery`;
- paginated `GET /answers`, `GET /answers/{answer_id}`, and deletion of one,
  one guild, or all answers.

The connected Discord client supplies live guilds, roles, and member search.
Electron IPC, remote IPC, preload, the browser bridge, and the web gateway expose
the same renderer operations. Persistence, model execution, and auditing remain
in FastAPI.

## Verification

Automated tests cover strict access, trigger detection, recent-context limits,
room scope and cutoff, queue and cooldown behavior, citation links, splitting,
model fallback, audit persistence, history operations, and transport parity.
For a real bot, verify Electron Local or the web gateway with:

1. a synchronized and an unsynchronized room;
2. an authorized mention and follow-up reply;
3. an unauthorized member and missing reaction permission;
4. a room-grounded answer with clickable citations;
5. a general question such as “When was Barack Obama born?”;
6. history detail and each deletion scope.
