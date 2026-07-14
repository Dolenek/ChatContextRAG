# Renderer shell

The framework-free renderer uses a four-region application shell: a left
navigation rail, an 82 px header, a central workspace, and a grounding-context
panel. The expanded rail is 310 px wide and its compact mode is 72 px. The
desktop preference is stored in browser-local storage. The context panel uses
`clamp(360px, 31vw, 508px)`, while chat content is capped at 784 px. The rail,
workspace, context list, drawers, and modal bodies own their scrolling so the
composer remains anchored when content grows.

The rail starts with the Chat Context sparkle mark and its collapse control. It
contains **New chat**, **Sources and imports**, **Database**, the six most recent
persisted chats, the expandable remainder of the 20 loaded summaries, the index
status card, and **Settings**. Compact mode retains the logo, collapse control,
and navigation icons with accessible labels and hover/focus tooltips. Recent
chat rows use `updated_at`: same-day rows show `HH:mm`, yesterday uses a localized
label, and older rows use a short date. Rows restore their ordered messages,
grounding sources, scope, provider, model, and reasoning effort. Rename and
delete actions use dedicated dialogs.

The header owns the native **Search in** scope selector and the archive-ready
status. Scope options carry a source icon and conversation label. The same
selection is exposed in the sources drawer; both controls update one state and
changing it starts a clean conversation. Archive percentage, index metrics,
active jobs, pending-message indexing, and the database dashboard all render
from one shared database-overview snapshot. At widths where context is a drawer,
the header also exposes its message count and open control.

## Conversation and grounding

The conversation view renders saved user turns as timestamped bubbles with a
persisted confirmation and assistant turns as cards with a sparkle avatar. Each
assistant card retains its own complete source array. Its **Answer supported by
N messages** action restores that answer's grounding after the user has selected
or generated a newer answer.

The composer uses an automatically growing textarea. Enter submits and
Shift+Enter inserts a line break. The send button and two-level model selector
sit inside the composer card. Provider and model selection behavior, optional
reasoning effort, unavailable restored-model handling, and context-reset rules
remain unchanged.

The context panel shows the total number of source messages and the largest
leading set of preview cards that fits its measured height, with a maximum of
five and a minimum of one when sources exist. A `ResizeObserver` recalculates the
set after window or card-size changes. The card list scrolls independently from
the fixed **Show complete context (N)** row, so the two never overlap. Each card
includes the source type, conversation, timestamp, deterministically colored
author, shortened text, and a relative match value from `0.00` to `1.00`. Its
accessible tooltip exposes the exact raw RRF, cosine, or legacy score.

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
thinking card with three pulsing dots; success replaces it and failure removes
it while marking the user message as unsaved. Reduced-motion mode keeps the
indicator static. Restoring an older answer opens the drawer first, updates its
sources, briefly highlights the context header, and announces the update to
assistive technology.

## Supporting surfaces

**Sources and imports** opens a 320 px overlay drawer for scope selection and
connector workflows. Database remains a central workspace dashboard. Settings
opens over the current screen as an accessible modal and keeps its provider,
model, embedding-index, indexing-history, workspace-target, and web-session
behavior. Import drawers, confirmation dialogs, indexing controls, and the web
runtime reuse the shell's color, type, radius, button, card, and focus tokens.

Embedded Discord forces the 72 px rail, locks open the 320 px import drawer, and
starts its `BrowserView` 82 px below the top edge and 392 px from the left. This
keeps import controls visible while Discord runs in its persistent isolated
partition. Interactive header elements opt out of Electron drag regions.

## Responsive behavior

At 1,199 px and below the grounding panel becomes a right drawer controlled by
the header count button. At 760 px and below the rail defaults to its icon mode;
expanding it produces a transient overlay and selecting a destination closes it.
The grounding panel remains an independent right drawer. Low-height desktop
windows scroll the full sidebar, preserving access to recent chats, index status,
and settings.

The web adapter uses browser file selection and multipart requests for WhatsApp
exports and hides embedded Discord controls. `/api/events` supplies best-effort indexing and bot
progress over SSE. Adaptive polling of every queued and running job remains the
authoritative fallback across reconnects; running jobs sort before queued jobs,
and terminal records stay available in **Indexing history**.
