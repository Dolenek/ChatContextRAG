from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.database_models import (
    DatabaseCount,
    DatabaseCountPage,
    DatabaseStatus,
    IndexingJobView,
)
from backend.database_routes import register_database_routes
from backend.ingestion_routes import _register_job_routes


class OverviewService:
    def __init__(self) -> None:
        self.fresh = None
        self.page_request = None

    def get_status(self, fresh=False):
        self.fresh = fresh
        return DatabaseStatus(
            total_chunks=1, total_source_messages=2, total_channels=1,
            total_authors=1, oldest_message_at=None, newest_message_at=None,
        )

    def get_breakdown_page(self, dimension, limit, offset):
        self.page_request = (dimension, limit, offset)
        return DatabaseCountPage(limit=limit, offset=offset)

    def get_breakdowns(self):
        return {"channels": [], "authors": [], "embedding_models": []}

    def get_chunk_page(self, _limit, _cursor):
        return {"chunks": [], "has_more": False}

    def refresh_read_model(self, scope):
        return {"queued": True, "scope": scope}


class IngestionService:
    def list_active_jobs(self):
        return [IndexingJobView(
            job_id="active", session_id="session", status="running",
        )]


def test_status_force_and_paginated_breakdown_routes() -> None:
    application = FastAPI()
    service = OverviewService()
    register_database_routes(application, service)
    client = TestClient(application)

    status = client.get("/database/status?fresh=true")
    page = client.get("/database/breakdowns/authors?limit=25&offset=50")
    invalid = client.get("/database/breakdowns/authors?limit=201")
    refresh = client.post("/database/read-model/refresh", json={"scope": "all"})

    assert status.status_code == 200
    assert service.fresh is True
    assert page.status_code == 200
    assert service.page_request == ("authors", 25, 50)
    assert invalid.status_code == 422
    assert refresh.json() == {"queued": True, "scope": "all"}


def test_active_jobs_collection_route_precedes_job_identifier_route() -> None:
    application = FastAPI()
    _register_job_routes(application, IngestionService())

    response = TestClient(application).get("/indexing/jobs?status=active")

    assert response.status_code == 200
    assert response.json()[0]["job_id"] == "active"


def test_production_sized_author_page_stays_below_ten_kilobytes() -> None:
    page = DatabaseCountPage(
        items=[
            DatabaseCount(label=f"Production display name {index:02d}", count=938_000 - index)
            for index in range(50)
        ],
        total=6_231,
        limit=50,
        offset=0,
        has_more=True,
        next_offset=50,
    )

    assert len(page.model_dump_json().encode("utf-8")) < 10_000
