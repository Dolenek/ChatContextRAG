import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")


@dataclass(frozen=True)
class ApplicationSettings:
    database_path: Path
    openai_api_key: Optional[str]

    @classmethod
    def from_environment(cls) -> "ApplicationSettings":
        configured_database = os.environ.get("CHAT_CONTEXT_DATABASE", "chat_context.db")
        database_path = Path(configured_database)
        if not database_path.is_absolute():
            database_path = PROJECT_ROOT / database_path
        return cls(
            database_path=database_path,
            openai_api_key=os.environ.get("OPENAI_API_KEY") or None,
        )
