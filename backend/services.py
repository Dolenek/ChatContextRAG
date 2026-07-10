from typing import List

from backend.chunking import ConversationAwareChunker
from backend.models import (
    ChatRequest, ChatResponse, ChatSource, DatabaseOverview, ImportRequest, ImportResponse,
)
from backend.normalization import DiscordMessageNormalizer
from backend.openai_gateway import ChatCompletionProvider, EmbeddingProvider
from backend.repository import VectorRepository
from backend.vector_models import EmbeddedChunk, RetrievedChunk


class MessageIngestionService:
    def __init__(
        self,
        normalizer: DiscordMessageNormalizer,
        chunker: ConversationAwareChunker,
        embedding_provider: EmbeddingProvider,
        repository: VectorRepository,
    ) -> None:
        self.normalizer = normalizer
        self.chunker = chunker
        self.embedding_provider = embedding_provider
        self.repository = repository

    def ingest(self, request: ImportRequest) -> ImportResponse:
        normalized_messages = self.normalizer.normalize(request.messages)
        external_ids = [message.external_id for message in normalized_messages]
        existing_ids = self.repository.existing_source_message_ids(external_ids)
        new_messages = [
            message for message in normalized_messages if message.external_id not in existing_ids
        ]
        if not new_messages:
            return ImportResponse(imported_count=0, chunk_count=0, messages=request.messages)
        chunks = self.chunker.chunk(new_messages)
        embeddings = self.embedding_provider.embed_texts([chunk.content for chunk in chunks])
        if len(embeddings) != len(chunks):
            raise RuntimeError("Embedding provider returned an unexpected result count")
        embedded_chunks = [
            EmbeddedChunk(chunk=chunk, embedding=embedding, embedding_model=self.embedding_provider.model_name)
            for chunk, embedding in zip(chunks, embeddings)
        ]
        stored_count = self.repository.upsert_chunks(embedded_chunks)
        return ImportResponse(
            imported_count=len(new_messages),
            chunk_count=stored_count,
            messages=request.messages,
        )


class DatabaseChatService:
    def __init__(
        self,
        repository: VectorRepository,
        embedding_provider: EmbeddingProvider,
        chat_provider: ChatCompletionProvider,
        retrieval_limit: int = 5,
    ) -> None:
        self.repository = repository
        self.embedding_provider = embedding_provider
        self.chat_provider = chat_provider
        self.retrieval_limit = retrieval_limit

    def answer(self, request: ChatRequest) -> ChatResponse:
        query_embedding = self.embedding_provider.embed_texts([request.question])[0]
        retrieved_chunks = self.repository.search_similar(query_embedding, self.retrieval_limit)
        answer = self.chat_provider.answer(request.question, request.history, retrieved_chunks)
        return ChatResponse(answer=answer, sources=self._to_sources(retrieved_chunks))

    @staticmethod
    def _to_sources(chunks: List[RetrievedChunk]) -> List[ChatSource]:
        return [
            ChatSource(
                author=", ".join(chunk.authors), content=chunk.content,
                timestamp=chunk.started_at, channel=chunk.channel,
                similarity_score=chunk.similarity_score,
            )
            for chunk in chunks
        ]


class DatabaseOverviewService:
    def __init__(self, repository: VectorRepository) -> None:
        self.repository = repository

    def get_overview(self, limit: int, offset: int) -> DatabaseOverview:
        return self.repository.get_overview(limit, offset)

    def clear_database(self) -> int:
        return self.repository.delete_all()
