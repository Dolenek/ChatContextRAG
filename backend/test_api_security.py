import pytest
from fastapi import FastAPI, File, UploadFile
from fastapi.testclient import TestClient

from backend.api_security import InternalApiSecurityMiddleware
from backend.app import create_app


def _secured_client(token="internal-secret") -> TestClient:
    application = FastAPI()

    @application.get("/health")
    def health() -> dict:
        return {"status": "ok"}

    @application.post("/upload")
    async def upload(export_file: UploadFile = File()) -> dict:
        return {"bytes": len(await export_file.read())}

    application.add_middleware(
        InternalApiSecurityMiddleware, internal_token=token,
    )
    return TestClient(application)


def test_internal_api_requires_token_but_keeps_health_public() -> None:
    client = _secured_client()

    assert client.get("/health").status_code == 200
    assert client.post("/upload", files={"export_file": ("chat.txt", b"safe")}).status_code == 401
    accepted = client.post(
        "/upload", headers={"X-Chat-Context-Token": "internal-secret"},
        files={"export_file": ("chat.txt", b"safe")},
    )
    assert accepted.status_code == 200
    assert accepted.json() == {"bytes": 4}


def test_browser_origin_is_rejected_before_multipart_parsing() -> None:
    client = _secured_client()
    response = client.post(
        "/upload",
        headers={
            "Origin": "https://attacker.example",
            "X-Chat-Context-Token": "internal-secret",
        },
        files={"export_file": ("chat.txt", b"unsafe")},
    )

    assert response.status_code == 403
    assert response.json() == {"detail": "Browser requests are not allowed."}


def test_api_without_token_fails_closed() -> None:
    client = _secured_client(token=None)

    with pytest.raises(ValueError, match="CHAT_CONTEXT_INTERNAL_TOKEN"):
        client.post("/health")


def test_application_factory_rejects_missing_token_before_serving() -> None:
    with pytest.raises(ValueError, match="CHAT_CONTEXT_INTERNAL_TOKEN"):
        create_app(object(), object(), object(), internal_token=" ")


def test_invalid_hosts_and_urlencoded_forms_are_rejected() -> None:
    client = _secured_client()
    headers = {"X-Chat-Context-Token": "internal-secret"}

    assert client.get(
        "/health", headers={"Host": "example.test/path"},
    ).status_code == 400
    assert client.post(
        "/upload", headers={**headers, "Host": "example.test/path"},
        files={"export_file": ("chat.txt", b"unsafe")},
    ).status_code == 400
    assert client.post(
        "/upload", headers={**headers, "Content-Type": "application/x-www-form-urlencoded"},
        content="field=value",
    ).status_code == 415


def test_ambiguous_security_headers_are_rejected() -> None:
    client = _secured_client()
    assert client.get(
        "/health", headers=[("Host", "testserver"), ("Host", "other.test")],
    ).status_code == 400
    response = client.post(
        "/upload",
        headers=[
            ("X-Chat-Context-Token", "wrong"),
            ("X-Chat-Context-Token", "internal-secret"),
        ],
        files={"export_file": ("chat.txt", b"unsafe")},
    )

    assert response.status_code == 401
