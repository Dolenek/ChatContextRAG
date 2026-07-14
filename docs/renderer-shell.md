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

The rail starts with the transparent Chat Context brand mark centered without a
text label. The same mark is the Electron and browser favicon. Its
44 px actions list **New chat**, **Sources and imports**, **Database**, and
**Settings** before the six most recent persisted chats, the expandable
remainder of the 20 loaded summaries, and the index status card. Compact mode
shows the logo by default. Hovering the logo or non-action rail space replaces it
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
conversation label. The selector shares the chat content's responsive gutter.
The archive-ready status occupies the centered header column independently of
the selector. The archive progress track spans from the status dot to the
percentage label. The same
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
context** and do not display a synthetic match score.

Cards with retained chunk context expose an inline **Show chunk** control in
both the preview and complete-context modal. Retrieved chunks show the exact
context used for that answer; historical records reconstructed from the active
index are explicitly labeled as current rather than original context. Message
and chunk text is inserted with DOM text properties rather than interpreted as
HTML. There is no source-message navigation action. Discord and WhatsApp
surfaces use local SVG sprite symbols, so brand icons require no runtime request.

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
and loads breakdowns and the first chunk page in parallel. Loading failures keep
the previous snapshot visible. Manual refresh bypasses freshness windows.
Settings opens over the current screen as an accessible modal and keeps its
provider, model, embedding-index, indexing-history, workspace-target, and
web-session behavior. The workspace section also provides a searchable IANA
timezone field shared by web, Electron Local, and Electron Remote. It controls
calendar boundaries for future adaptive searches and defaults to `UTC`.

Workspace reads use an in-memory stale-while-revalidate cache. Database status
is fresh for five seconds, breakdowns and the first chunk page for 30 seconds,
and scopes, settings, and recent chats for 60 seconds. Imports, database clear,
index completion, active-index changes, and chat mutations invalidate their
affected resources. Cached labels and titles are never persisted to browser
storage. Concurrent requests for the same resource share one in-flight promise.

Embedded Discord forces the 72 px rail, locks open the 320 px import drawer, and
starts its `BrowserView` 82 px below the top edge and 392 px from the left. This
keeps import controls visible while Discord runs in its persistent isolated
partition. Interactive header elements opt out of Electron drag regions.

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
other renderer files remain protected. The web adapter
uses browser file selection and multipart requests for WhatsApp exports and hides
embedded Discord controls. Authenticated GET reads start in
parallel with the session request; mutations wait for that request to obtain the
CSRF token. `/api/events` supplies best-effort indexing and bot progress over
SSE. Adaptive polling of every queued and running job remains the authoritative
fallback across reconnects; running jobs sort before queued jobs, and terminal
records stay available in **Indexing history**.
