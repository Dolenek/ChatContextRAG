# Model and API settings

The built-in **OpenAI** provider initially reads its API key and default model
IDs from `.env`. The same key is used for OpenAI chat and embedding/indexing.
It can also be set in **Settings > Providers and API keys** under **Provider for embedding / indexing**
without editing `.env`; choose OpenAI, paste the project API key, and select
**Save key for indexing**. This encrypted saved override takes precedence for
the running provider and survives application restarts. The renderer never
receives the saved value again.

Use the provider form in **Settings > Providers and API keys** to add other OpenAI-compatible
profiles. A profile supplies a display name, the complete API base URL (normally
ending in `/v1`), an optional API key, and either the Responses or Chat
Completions protocol. Keyless profiles are intended for trusted local
OpenAI-compatible servers such as an Ollama endpoint. Keys are encrypted with
Electron `safeStorage` locally or AES-256-GCM in the server state; PostgreSQL,
API responses, and logs never receive them in plaintext. A platform without a
secure key store cannot persist provider keys.

The chat selector initially shows `OPENAI_CHAT_MODEL`, and the initial embedding
index uses `OPENAI_EMBEDDING_MODEL` plus `OPENAI_EMBEDDING_DIMENSIONS`. These
environment values remain effective until the user explicitly selects another
chat model or activates another ready embedding index. Existing saved choices
are never overwritten during startup.

Add the chat model IDs that should be selectable to the **Chat models** section.
Managed rows can be reopened with **Edit** to change their provider, model ID,
display name, or reasoning effort. Saving replaces the original row atomically;
an edited active model remains the active default under its new identity.
Each saved model may also choose **Reasoning effort**: model default, `none`,
`minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Support depends on the
model and compatible provider. **Model default** is the safest fallback because
it omits the parameter entirely. Explicit effort is sent as `reasoning.effort`
for Responses or `reasoning_effort` for Chat Completions.
Model fields load suggestions from the provider's `/models` endpoint and still
accept a model ID typed by hand, which also supports local servers that do not
list models. The selector at the bottom-right of the chat composer groups saved
models by provider. The chat screen remembers the last selection, and changing
it starts a fresh visible chat history. `OPENAI_CHAT_MODEL` remains available as
an unmanaged fallback even when it has not been added manually.

**Settings > Embedding indexes** can keep multiple indexes over the same canonical raw
messages. Creating an index makes one small embedding request to validate its
dimension, then queues all raw messages. Exactly one ready index is active for
RAG search. **Sync** embeds missing raw messages, **Rebuild** atomically publishes
a complete replacement, and deleting a non-active index removes only its
vectors. Auto-sync applies to future ingestion and is controlled per index.
An embedding index keeps its provider, model, and dimension identity immutable.
A referenced provider cannot be deleted, and its base URL or API protocol cannot
be changed while an index uses it. The active chat model must be changed before
that model or its provider can be removed.
