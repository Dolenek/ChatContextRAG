from typing import Optional

from fastapi import FastAPI, HTTPException, Query

from backend.models import (
    ChannelResumePoint, ClearDatabaseRequest, ClearDatabaseResponse,
    DatabaseBreakdowns, DatabaseChunkPage, DatabaseOverview, DatabaseStatus,
)


def register_database_routes(application, overview_service) -> None:
    _register_overview_routes(application, overview_service)
    _register_chunk_routes(application, overview_service)


def _register_overview_routes(application: FastAPI, overview_service) -> None:
    @application.get("/database/overview", response_model=DatabaseOverview)
    def database_overview(
        limit: int = Query(default=50, ge=1, le=200),
        offset: int = Query(default=0, ge=0),
    ) -> DatabaseOverview:
        return overview_service.get_overview(limit, offset)

    @application.get("/database/status", response_model=DatabaseStatus)
    def database_status() -> DatabaseStatus:
        return overview_service.get_status()

    @application.get("/database/breakdowns", response_model=DatabaseBreakdowns)
    def database_breakdowns() -> DatabaseBreakdowns:
        return overview_service.get_breakdowns()


def _register_chunk_routes(application: FastAPI, overview_service) -> None:
    @application.get("/database/chunks", response_model=DatabaseChunkPage)
    def database_chunks(
        limit: int = Query(default=50, ge=1, le=200),
        cursor: Optional[str] = Query(default=None, min_length=1, max_length=2000),
    ) -> DatabaseChunkPage:
        try:
            return overview_service.get_chunk_page(limit, cursor)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @application.get("/database/resume-point", response_model=ChannelResumePoint)
    def database_resume_point(
        channel_id: str = Query(min_length=1, max_length=128),
        channel: Optional[str] = Query(default=None, max_length=300),
    ) -> ChannelResumePoint:
        return overview_service.get_resume_point(channel_id, channel)

    @application.delete("/database", response_model=ClearDatabaseResponse)
    def clear_database(_request: ClearDatabaseRequest) -> ClearDatabaseResponse:
        result = overview_service.clear_database()
        if isinstance(result, tuple):
            return ClearDatabaseResponse(
                deleted_chunks=result[0], deleted_messages=result[1],
            )
        return ClearDatabaseResponse(deleted_chunks=result)
