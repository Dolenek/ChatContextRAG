import asyncio

import pytest
from fastapi.testclient import TestClient

from backend.app import _read_import_file, create_app
from backend.openai_gateway import ExternalIntegrationError, IntegrationConfigurationError


TEST_INTERNAL_TOKEN = "backend-test-internal-token"


class RaisingChatService:
    def __init__(self, error) -> None:
        self.error = error

    def answer(self, _request):
        raise self.error


class FakeOversizedPayload:
    def __len__(self):
        return 100 * 1024 * 1024 + 1


class FakeOversizedUpload:
    async def read(self, maximum_bytes):
        assert maximum_bytes == 100 * 1024 * 1024 + 1
        return FakeOversizedPayload()


def test_application_translates_domain_errors_to_stable_http_responses() -> None:
    expected = [
        (ExternalIntegrationError("provider offline"), 503),
        (IntegrationConfigurationError("provider missing"), 503),
        (ValueError("index conflict"), 409),
    ]
    for error, status_code in expected:
        client = TestClient(create_app(
            object(), RaisingChatService(error), object(),
            internal_token=TEST_INTERNAL_TOKEN,
        ), headers={"X-Chat-Context-Token": TEST_INTERNAL_TOKEN})

        response = client.post("/chat", json={"question": "what happened?"})

        assert response.status_code == status_code
        assert response.json() == {"detail": str(error)}


def test_whatsapp_upload_reader_rejects_payloads_over_transport_limit() -> None:
    with pytest.raises(ValueError, match="100 MiB"):
        asyncio.run(_read_import_file(FakeOversizedUpload()))
