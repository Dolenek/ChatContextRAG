import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")


@dataclass(frozen=True)
class ApplicationSettings:
    postgres_dsn: str
    openai_api_key: Optional[str]
    embedding_model: str
    embedding_dimensions: int
    embedding_batch_size: int
    chat_model: str
    internal_token: str

    @classmethod
    def from_environment(cls) -> "ApplicationSettings":
        internal_token = os.environ.get("CHAT_CONTEXT_INTERNAL_TOKEN", "").strip()
        if not internal_token:
            raise ValueError("CHAT_CONTEXT_INTERNAL_TOKEN is required.")
        return cls(
            postgres_dsn=os.environ.get(
                "POSTGRES_DSN",
                "postgresql://chat_context:chat_context_dev@127.0.0.1:5433/chat_context",
            ),
            openai_api_key=os.environ.get("OPENAI_API_KEY") or None,
            embedding_model=os.environ.get("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"),
            embedding_dimensions=int(os.environ.get("OPENAI_EMBEDDING_DIMENSIONS", "1536")),
            embedding_batch_size=int(os.environ.get("OPENAI_EMBEDDING_BATCH_SIZE", "64")),
            chat_model=os.environ.get("OPENAI_CHAT_MODEL", "gpt-5.6-luna"),
            internal_token=internal_token,
        )

    def require_openai_api_key(self) -> str:
        if not self.openai_api_key:
            raise ValueError("OPENAI_API_KEY is missing in .env")
        return self.openai_api_key
