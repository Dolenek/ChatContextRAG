# Renderer shell

The framework-free renderer uses a four-region application shell: a left
navigation rail, an 82 px header, a central workspace, and a grounding-context
panel. The expanded rail is 310 px wide and its compact mode is 72 px. The
desktop preference is stored in browser-local storage. The context panel uses
`clamp(324px, 28vw, 457px)`, while chat content is capped at 784 px. The rail,
workspace, context list, drawers, and modal bodies own their scrolling so the
composer remains anchored when content grows. The shell fills the viewport
without a decorative outer border; borders only separate internal regions and
components.

The expanded rail starts with the transparent Chat Context wordmark asset,
centered across the full rail above the first navigation action. The wordmark
and the collapse control share one grid row and therefore one vertical center;
the wordmark spans that grid so its canvas midpoint, optically near the leading
**C**, remains on the rail centerline independently of the control. The
same brand mark without text is the Electron and browser favicon. Its
44 px actions list **New chat**, **Sources and imports**, **Database**, and
**Settings** before the six most recent persisted chats, the expandable
remainder of the 20 loaded summaries, and the index status card. Compact mode
shows the mark without text by default. Hovering the mark or non-action rail space replaces it
with the expand control; clicking either area expands the rail. Navigation action
clicks do not change the rail width. Keyboard focus also reveals the control.
Navigation icons retain accessible labels and hover/focus tooltips. Recent
chat rows use `updated_at`: same-day rows show `HH:mm`, yesterday uses a localized
label, and older rows use a short date. Rows restore their ordered messages,
grounding sources, scope, provider, model, reasoning effort, retrieval mode, and
fixed evidence limit. Rename and delete actions use dedicated dialogs.

The header owns the native **Search in** scope selector and the archive-ready
status. Native selection menus use dark surfaces, light option text, and violet
group labels throughout the renderer. Focusing the scope selector outlines the
complete **Search in** control rather than only the native select. Clicking any
part of that control opens its native menu. Scope options carry a source icon and
conversation label. The selector and archive-ready status share the composer's
centered, capped width: **Search in** starts at the composer's left edge, while
the status label and progress track end at its right edge. At drawer widths, the
context control sits between these two aligned controls. The archive progress
track spans from the status dot to the percentage label. The same
selection is exposed in the sources drawer; both controls update one state and
changing it starts a clean conversation. Startup requests the lightweight
database status, scopes, settings, and recent chats concurrently. It does not
load database breakdowns or chunk content until the database workspace opens.
At widths where context is a drawer, the header also exposes its message count
and open control.

## Conversation and grounding

The conversation view renders saved user turns as timestamped bubbles with a
persisted confirmation and assistant turns as cards with a sparkle avatar. Each
assistant card retains its own complete source array. Its **Answer supported by
N messages** action restores that answer's grounding after the user has selected
or generated a newer answer.

The composer uses an automatically growing textarea. Enter submits and
Shift+Enter inserts a line break. The send button, Adaptive/Deterministic
retrieval selector, and two-level model selector sit inside the composer card.
A new chat defaults to Adaptive only when the selected model enables archive
tools. Changing model, mode, or relevant model configuration starts a new chat.
A restored chat keeps its persisted mode and evidence limit instead of adopting
later model-setting changes.

The context panel shows the total number of source messages and the largest
leading set of preview cards that fits its measured height, with a maximum of
five and a minimum of one when sources exist. A `ResizeObserver` recalculates the
set after window or card-size changes. The card list scrolls independently from
the fixed **Show complete context (N)** row, so the two never overlap. Each card
includes the source type, conversation, timestamp, deterministically colored
author, shortened text, and a relative match value from `0.00` to `1.00`. Its
accessible tooltip exposes the exact raw RRF, cosine, or legacy score.
Messages loaded as neighboring adaptive context are labeled **Neighboring
context** and do not display a synthetic match score. Renderer icons use symbols
from the shared external `assets/icon-sprite.svg` file; static and dynamically
created `<use>` elements include the asset path before their symbol fragment.
The web gateway revalidates that sprite with `ETag` and `Last-Modified`, so an
unchanged sprite receives `304` instead of another body transfer.

Cards with retained chunk context expose an inline **Show chunk** control in
both the preview and complete-context modal. Retrieved chunks show the exact
context used for that answer; historical records reconstructed from the active
index are explicitly labeled as current rather than original context. Message
and chunk text is inserted with DOM text properties rather than interpreted as
HTML. There is no source-message navigation action. Discord and WhatsApp brand
icons use the same local SVG sprite and do not depend on third-party assets.

The context modal has `aria-modal`, an explicit label, a focus trap, and focus
return. It closes from its close button, Escape, or the backdrop. Opening a new
answer automatically opens the context drawer when the fixed panel is not
available. Submitting a question immediately inserts an accessible assistant
thinking card with three pulsing dots. Adaptive requests add live, ordered Czech
status rows for archive search and context reads. All tool arguments are written
through `textContent`. Success replaces the live list with a collapsed
**Archivní kroky (N)** disclosure stored with that assistant turn; restored
sessions reconstruct it. Deterministic requests show no tool timeline. Failure
removes the thinking card while marking the user message as unsaved.
Reduced-motion mode keeps the indicator static. Restoring an older answer opens
the drawer first, updates its
sources, briefly highlights the context header, and announces the update to
assistive technology.

## Supporting surfaces

**Sources and imports** opens a 320 px overlay drawer for scope selection and
connector workflows. Database remains a central workspace dashboard. Selecting
it switches the workspace immediately, renders cached status when available,
and loads the first 50 rows of each breakdown plus the first chunk page in
parallel. Its archive banner combines readiness, pending messages, database
size, and projection freshness. Three compact cards group volume, indexing
quality, and archive time-range values. Readiness is the bounded whole-number
ratio of indexed to raw messages; an empty or unavailable projection displays
an em dash instead of a synthetic percentage.

Conversation and author tables label their projected counts as raw **Messages**,
while the embedding-model table labels its active-index counts as **Chunks**.
Each breakdown has an independent **Show next 50** action that appends rows,
keeps existing rows after failure, and becomes its own retry action. The chunk
detail uses a bounded scrolling table with compact IDs, single-line content,
and `updated_at` as its stored timestamp. Its cursor action appends the next 50
rows and updates the displayed-versus-total label.

Summary rows, their SVG nodes, progress elements, and indexing-job rows are
created once and reconciled in place, preserving identity, focus, and the last
visible snapshot during requests. A subtle banner label announces an initial,
stale, refreshing, failed, or current projection without clearing values.
Manual refresh queues server work without waiting and retains visible data.
Settings opens over the current screen as an accessible modal and keeps its
provider, model, embedding-index, indexing-history, Discord-bot, workspace-target,
and web-session behavior. Runtime capability controls are hidden until startup
identifies Electron Local, Electron Remote, or Web. The connection-target card
is available only in Electron. Its Remote selection is labeled **Vzdálený Chat
Context server** and reveals the server URL and desktop API token fields; the
Local selection keeps those fields hidden. The Discord bot item in **Sources and imports** is a
shortcut to that settings section; there is no duplicate connector drawer. Its
answer-history dialog traps focus, returns focus to its opener, and renders audit
values as text. The complete surface is documented in
[Discord bot](discord-bot.md). The workspace section also provides a searchable IANA
timezone field shared by web, Electron Local, and Electron Remote. Web retains
this Workspace section while omitting only the desktop connection-target card.
The timezone controls calendar boundaries for future adaptive searches and
defaults to `UTC`.
For a non-loopback HTTP remote target, the section shows an acknowledgement
control bound to the exact normalized origin and disables connection actions
until the user accepts it. Loopback and HTTPS targets do not require it.

Workspace reads use an in-memory stale-while-revalidate cache. Database status
is fresh in the renderer for five seconds. First breakdown pages and the
first chunk page are fresh for 30 seconds, and scopes, settings, and recent chats
for 60 seconds. Imports, database clear, index completion, active-index changes,
and chat mutations invalidate their affected resources. Cached labels and titles
are never persisted to browser storage. Concurrent requests for the same
resource share one in-flight promise.

Renderer mutations use a shared hybrid interaction policy. Reversible local
metadata changes—chat-model rows and edits, chat titles, the default model,
workspace timezone, provider metadata, Discord model settings, auto-sync, and
the active embedding index—are projected synchronously and rolled back from an
exact snapshot when the authoritative request fails. Model rows stay out of the
global selector until the server confirms them. Destructive or external work,
including deletes, secrets, connection tests and targets, bot lifecycle,
imports, migrations, and indexing actions, keeps authoritative data unchanged
while the related row or control alone shows a pending label. Confirmations and
progress events remain authoritative; the Settings overlay is never globally
disabled.

The internal `window.interactionCoordinator` supplies two primitives.
`runLatest` assigns a revision to a keyed read and lets only its newest response
or error reach the DOM. `runMutation` applies local state synchronously, blocks
duplicate work for the same key, manages related pending controls, and performs
commit or exact rollback. A successful mutation updates local state and the
workspace cache before starting reconciliation in the background. A failed
reconciliation invalidates the cache and reports a nonblocking warning; it does
not undo the confirmed mutation. Settings refreshes are revisioned so an older
server snapshot cannot replace a newer local commit.

**Lokální Discord scanner** appears under **Sources and imports** only when an
Electron runtime advertises `embeddedDiscord`. It is available for both Local
and Remote targets, writes through the active workspace backend, and remains
distinct from the Discord bot. Opening it forces the 72 px rail, locks open the
320 px import drawer, and starts its `BrowserView` 82 px below the top edge and
392 px from the left. This keeps import controls visible while Discord runs in
its persistent isolated partition. Interactive header elements opt out of
Electron drag regions.

## Responsive behavior

At 1,199 px and below the grounding panel becomes a right drawer capped at
414 px and controlled by the header count button. At 760 px and below the rail
defaults to its icon mode; expanding it produces a transient overlay and
selecting a destination closes it. The grounding panel remains an independent
right drawer. Low-height desktop windows scroll the full sidebar, preserving
access to recent chats, index status, and settings.

The web login presents the full transparent Chat Context lockup, with white
**Chat** and violet **Context**, over its existing dark card background. Brand
assets are available before authentication so the login page can load them;
other renderer files remain protected. The web adapter uses browser file
selection and multipart requests for WhatsApp exports. Its runtime capabilities
keep the local scanner and desktop connection target hidden. Authenticated GET reads start in
parallel with the session request; mutations wait for that request to obtain the
CSRF token. `/api/events` supplies best-effort indexing and bot progress over
SSE, and Electron supplies equivalent indexing progress events. Push is primary:
the renderer records the last event per active job and makes one batched active-
job request every ten seconds only when a queued or running job has been silent
for at least twelve seconds and the document is visible. Polling pauses while
hidden and reconciles immediately on visibility recovery. A job disappearing
from the active response triggers one debounced exact status refresh. During an
active job aggregate status is otherwise requested at most once per minute. When
the read-model projection is missing, stale, or refreshing, one central status
poll follows it every eight seconds. A new generation invalidates settings,
chat scopes, status, and first-breakdown caches before reconciliation. The
complete projection and metadata contract is documented in
[Persistent UI read model](ui-read-model.md). Running jobs
sort before queued jobs, and terminal records stay available in **Indexing
history**.
