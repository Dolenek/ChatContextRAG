from backend.chunk_context_repository import PostgresActiveChunkContextReader


class QueryResult:
    def fetchall(self):
        return [
            ("message-1", "chunk-1", "full chunk", ["message-1", "message-2"]),
        ]


class RecordingConnection:
    def __init__(self):
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *_arguments):
        return False

    def execute(self, statement, parameters):
        self.calls.append((statement, parameters))
        return QueryResult()


def test_active_chunk_contexts_are_loaded_in_one_bulk_query() -> None:
    connection = RecordingConnection()
    schema_calls = []
    reader = PostgresActiveChunkContextReader(
        lambda: schema_calls.append(True), lambda: connection,
    )

    chunks = reader.load(["message-1", "message-2", "message-1"])

    assert len(connection.calls) == 1
    assert connection.calls[0][1] == (["message-1", "message-2"],)
    assert "active_embedding_index_id" in connection.calls[0][0]
    assert chunks["message-1"].origin == "reconstructed"
    assert chunks["message-1"].content == "full chunk"
    assert schema_calls == [True]
