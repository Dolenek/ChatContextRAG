def legacy_chunk_table_sql(dimensions: int) -> str:
    return f"""CREATE TABLE IF NOT EXISTS conversation_chunks (
        id TEXT PRIMARY KEY, content TEXT NOT NULL, authors TEXT[] NOT NULL,
        source_message_ids TEXT[] NOT NULL, channel TEXT,
        started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ,
        embedding_model TEXT NOT NULL, embedding vector({dimensions}) NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{{}}', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )"""


def legacy_chunk_index_sql() -> str:
    return """CREATE INDEX IF NOT EXISTS conversation_chunks_embedding_hnsw
        ON conversation_chunks USING hnsw (embedding vector_cosine_ops)"""


def legacy_resume_indexes_sql() -> str:
    return """CREATE INDEX IF NOT EXISTS conversation_chunks_channel_id
        ON conversation_chunks ((metadata->>'channel_id'));
        CREATE INDEX IF NOT EXISTS conversation_chunks_channel_name
        ON conversation_chunks (channel);
        CREATE INDEX IF NOT EXISTS conversation_chunks_chat_scope
        ON conversation_chunks (
          (COALESCE(metadata->>'source_type','discord')),
          (COALESCE(metadata->>'conversation_id',metadata->>'channel_id'))
        )"""


def legacy_chunk_upsert_sql() -> str:
    return """INSERT INTO conversation_chunks
        (id, content, authors, source_message_ids, channel, started_at, ended_at,
         embedding_model, embedding, metadata)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content,
          authors = EXCLUDED.authors, source_message_ids = EXCLUDED.source_message_ids,
          channel = EXCLUDED.channel, started_at = EXCLUDED.started_at,
          ended_at = EXCLUDED.ended_at, embedding = EXCLUDED.embedding,
          embedding_model = EXCLUDED.embedding_model, metadata = EXCLUDED.metadata,
          updated_at = NOW()"""


def legacy_chunk_search_sql() -> str:
    return """SELECT id,content, authors, channel, started_at,
        1 - (embedding <=> %s) AS similarity_score,
        source_message_ids, metadata->>'channel_id', metadata->>'guild_id',
        COALESCE(metadata->>'source_type','discord'),
        COALESCE(metadata->>'conversation_id',metadata->>'channel_id')
        FROM conversation_chunks
        WHERE (%s::text IS NULL OR COALESCE(metadata->>'source_type','discord')=%s)
          AND (%s::text IS NULL OR COALESCE(metadata->>'conversation_id',
                                       metadata->>'channel_id')=%s)
        ORDER BY embedding <=> %s LIMIT %s"""


def oldest_legacy_source_message_sql() -> str:
    return """SELECT source_id FROM conversation_chunks,
        LATERAL UNNEST(source_message_ids) AS source_id
        WHERE source_id ~ '^[0-9]+$' AND (
            metadata->>'channel_id' = %s OR (
                COALESCE(metadata->>'channel_id', '') = '' AND channel = %s
            )
        )
        ORDER BY source_id::numeric ASC LIMIT 1"""
