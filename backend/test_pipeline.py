from datetime import datetime, timezone

from backend.indexing_worker import PersistentIndexingWorker
from backend.models import DiscordMessageInput, ImportRequest, IngestionSessionView
from backend.normalization import DiscordMessageNormalizer
from backend.services import MessageIngestionService
from backend.vector_models import NormalizedMessage


class FakeRawRepository:
    def __init__(self) -> None:
        self.messages = []
        self.finished = []

    def create_session(self, _request):
        return IngestionSessionView(session_id="session-1", status="running")

    def store_messages(self, session_id, messages):
        self.session_id = session_id
        self.messages = list(messages)
        return len(messages), len({message.content for message in messages})

    def finish_session(self, session_id, reason):
        self.finished.append((session_id, reason))
        return IngestionSessionView(
            session_id=session_id, status=reason, indexing_job_id="job-1",
        )


class FakeWorker:
    def __init__(self) -> None:
        self.wake_count = 0

    def wake(self):
        self.wake_count += 1


def test_explicit_session_stores_normalized_raw_messages_without_embedding() -> None:
    repository = FakeRawRepository()
    worker = FakeWorker()
    service = MessageIngestionService(DiscordMessageNormalizer(), repository, worker)
    request = ImportRequest(session_id="scan-session", messages=[DiscordMessageInput(
        external_id="1", author=" Ada ", content="  Ahoj   světe ",
        timestamp=datetime(2026, 7, 10, 10, 0, tzinfo=timezone.utc),
        channel="general", channel_id="20", guild_id="10",
    )])

    result = service.ingest(request)

    assert result.raw_stored_count == 1
    assert result.chunk_count == 0
    assert repository.session_id == "scan-session"
    assert repository.messages[0].content == "Ahoj světe"
    assert repository.finished == []


def test_implicit_manual_import_finishes_session_and_wakes_indexer() -> None:
    repository = FakeRawRepository()
    worker = FakeWorker()
    service = MessageIngestionService(DiscordMessageNormalizer(), repository, worker)

    result = service.ingest(ImportRequest(messages=[DiscordMessageInput(
        external_id="2", author="Bob", content="Strategie",
        channel="general", channel_id="20", guild_id="10",
    )]))

    assert result.imported_count == 1
    assert repository.finished == [("session-1", "completed")]
    assert worker.wake_count == 1


def test_indexer_collapses_only_consecutive_identical_messages() -> None:
    messages = [
        _message("1", "Bot", "Stejná odpověď"),
        _message("2", "Bot", "Stejná odpověď"),
        _message("3", "Ada", "Jiný kontext"),
        _message("4", "Bot", "Stejná odpověď"),
    ]

    collapsed = PersistentIndexingWorker._collapse_consecutive_duplicates(messages)

    assert len(collapsed) == 3
    assert collapsed[0].related_external_ids == ("2",)
    assert "Opakováno 2×" in collapsed[0].content
    assert collapsed[2].external_id == "4"


def _message(external_id: str, author: str, content: str) -> NormalizedMessage:
    return NormalizedMessage(
        external_id=external_id, author=author, content=content, timestamp=None,
        channel="general", channel_id="20", guild_id="10",
    )
