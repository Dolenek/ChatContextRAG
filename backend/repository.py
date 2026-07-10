import sqlite3
from pathlib import Path
from typing import Iterable, List, Protocol

from backend.models import ChatSource, DiscordMessageInput


class MessageRepository(Protocol):
    def save_messages(self, messages: Iterable[DiscordMessageInput]) -> int:
        ...

    def search_messages(self, terms: List[str], limit: int = 4) -> List[ChatSource]:
        ...


class SQLiteMessageRepository:
    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path
        self._initialize_schema()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(str(self.database_path))
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize_schema(self) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS messages (
                    external_id TEXT PRIMARY KEY,
                    author TEXT NOT NULL,
                    content TEXT NOT NULL,
                    timestamp TEXT,
                    channel TEXT,
                    imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )

    def save_messages(self, messages: Iterable[DiscordMessageInput]) -> int:
        message_rows = [self._to_row(message) for message in messages]
        with self._connect() as connection:
            before_changes = connection.total_changes
            connection.executemany(
                """
                INSERT OR IGNORE INTO messages
                (external_id, author, content, timestamp, channel)
                VALUES (?, ?, ?, ?, ?)
                """,
                message_rows,
            )
            return connection.total_changes - before_changes

    def search_messages(self, terms: List[str], limit: int = 4) -> List[ChatSource]:
        query, parameters = self._build_search_query(terms, limit)
        with self._connect() as connection:
            rows = connection.execute(query, parameters).fetchall()
        return [self._to_source(row) for row in rows]

    @staticmethod
    def _to_row(message: DiscordMessageInput) -> tuple:
        timestamp = message.timestamp.isoformat() if message.timestamp else None
        return (
            message.external_id,
            message.author,
            message.content,
            timestamp,
            message.channel,
        )

    @staticmethod
    def _build_search_query(terms: List[str], limit: int) -> tuple:
        if not terms:
            return "SELECT * FROM messages ORDER BY imported_at DESC LIMIT ?", [limit]
        conditions = " OR ".join("LOWER(content) LIKE ?" for _ in terms)
        parameters = [f"%{term.lower()}%" for term in terms] + [limit]
        query = f"SELECT * FROM messages WHERE {conditions} ORDER BY imported_at DESC LIMIT ?"
        return query, parameters

    @staticmethod
    def _to_source(row: sqlite3.Row) -> ChatSource:
        return ChatSource(
            author=row["author"],
            content=row["content"],
            timestamp=row["timestamp"],
            channel=row["channel"],
        )
