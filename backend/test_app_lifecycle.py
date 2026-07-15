from fastapi.testclient import TestClient

from backend.app import create_app


TEST_INTERNAL_TOKEN = "lifecycle-test-internal-token"


class LifecycleOverviewService:
    def __init__(self) -> None:
        self.events = []

    def start_background_services(self) -> None:
        self.events.append("start")

    def close_background_services(self) -> None:
        self.events.append("close")


class AsyncLifecycleOverviewService(LifecycleOverviewService):
    async def start_background_services(self) -> None:
        self.events.append("async-start")

    async def close_background_services(self) -> None:
        self.events.append("async-close")


def test_read_model_worker_uses_fastapi_lifespan() -> None:
    overview_service = LifecycleOverviewService()
    application = create_app(
        object(), object(), overview_service, internal_token=TEST_INTERNAL_TOKEN,
    )

    with TestClient(application):
        assert overview_service.events == ["start"]

    assert overview_service.events == ["start", "close"]


def test_read_model_lifespan_accepts_async_hooks() -> None:
    overview_service = AsyncLifecycleOverviewService()
    application = create_app(
        object(), object(), overview_service, internal_token=TEST_INTERNAL_TOKEN,
    )

    with TestClient(application):
        assert overview_service.events == ["async-start"]

    assert overview_service.events == ["async-start", "async-close"]
