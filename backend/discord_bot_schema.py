from typing import List


def discord_bot_schema_statements() -> List[str]:
    return [
        """CREATE TABLE IF NOT EXISTS discord_bot_settings (
            id INTEGER PRIMARY KEY CHECK(id=1),
            chat_provider_id TEXT,chat_model TEXT,reasoning_effort TEXT,
            retrieval_mode TEXT NOT NULL DEFAULT 'deterministic',
            evidence_character_limit INTEGER,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())""",
        """INSERT INTO discord_bot_settings(id) VALUES(1)
            ON CONFLICT(id) DO NOTHING""",
        """CREATE TABLE IF NOT EXISTS discord_bot_guilds (
            guild_id TEXT PRIMARY KEY,guild_name TEXT NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())""",
        """CREATE TABLE IF NOT EXISTS discord_bot_permission_subjects (
            guild_id TEXT NOT NULL REFERENCES discord_bot_guilds(guild_id)
              ON DELETE CASCADE,
            capability TEXT NOT NULL CHECK(capability IN ('sync','ask')),
            subject_type TEXT NOT NULL CHECK(subject_type IN ('role','user')),
            subject_id TEXT NOT NULL,display_name TEXT NOT NULL,
            PRIMARY KEY(guild_id,capability,subject_type,subject_id))""",
        """CREATE TABLE IF NOT EXISTS discord_bot_answers (
            id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,guild_name TEXT NOT NULL,
            channel_id TEXT NOT NULL,channel_name TEXT NOT NULL,
            requester_id TEXT NOT NULL,requester_name TEXT NOT NULL,
            trigger_message_id TEXT NOT NULL,trigger_type TEXT NOT NULL,
            parent_answer_id TEXT REFERENCES discord_bot_answers(id) ON DELETE SET NULL,
            question TEXT NOT NULL,answer TEXT,status TEXT NOT NULL,
            answer_basis TEXT,chat_provider_id TEXT,chat_model TEXT,
            reasoning_effort TEXT,retrieval_mode TEXT,evidence_character_limit INTEGER,
            recent_context JSONB NOT NULL DEFAULT '[]',
            evidence JSONB NOT NULL DEFAULT '[]',
            cited_evidence_ids JSONB NOT NULL DEFAULT '[]',
            tool_activity JSONB NOT NULL DEFAULT '[]',
            warnings JSONB NOT NULL DEFAULT '[]',error_code TEXT,
            trigger_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            completed_at TIMESTAMPTZ)""",
        """CREATE INDEX IF NOT EXISTS discord_bot_answers_recent
            ON discord_bot_answers(created_at DESC,id)""",
        """CREATE INDEX IF NOT EXISTS discord_bot_answers_guild_recent
            ON discord_bot_answers(guild_id,created_at DESC,id)""",
        """CREATE INDEX IF NOT EXISTS discord_bot_answers_channel_recent
            ON discord_bot_answers(channel_id,created_at DESC,id)""",
        """CREATE TABLE IF NOT EXISTS discord_bot_answer_messages (
            answer_id TEXT NOT NULL REFERENCES discord_bot_answers(id) ON DELETE CASCADE,
            message_id TEXT PRIMARY KEY,position INTEGER NOT NULL)""",
    ]
