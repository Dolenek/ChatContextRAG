from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.models import ChatRequest, ChatResponse, HealthResponse, ImportRequest, ImportResponse
from backend.repository import MessageRepository, SQLiteMessageRepository
from backend.services import DatabaseChatService
from backend.settings import ApplicationSettings


def create_app(repository: MessageRepository = None) -> FastAPI:
    application = FastAPI(title="Chat Context RAG API", version="0.1.0")
    application.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost", "file://"],
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )
    message_repository = repository or _create_default_repository()
    chat_service = DatabaseChatService(message_repository)

    @application.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(status="ok")

    @application.post("/messages/import", response_model=ImportResponse)
    def import_messages(request: ImportRequest) -> ImportResponse:
        imported_count = message_repository.save_messages(request.messages)
        return ImportResponse(imported_count=imported_count, messages=request.messages)

    @application.post("/chat", response_model=ChatResponse)
    def chat(request: ChatRequest) -> ChatResponse:
        return chat_service.answer(request.question)

    return application


def _create_default_repository() -> SQLiteMessageRepository:
    settings = ApplicationSettings.from_environment()
    return SQLiteMessageRepository(settings.database_path)


app = create_app()
