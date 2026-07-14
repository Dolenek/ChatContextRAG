import secrets
from typing import Optional
from urllib.parse import urlsplit

from starlette.responses import JSONResponse


class InternalApiSecurityMiddleware:
    """Restricts the internal API to trusted non-browser callers."""

    def __init__(self, application, internal_token: str) -> None:
        self.application = application
        self.internal_token = require_internal_token(internal_token)

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.application(scope, receive, send)
            return
        header_pairs = [(name.lower(), value) for name, value in scope.get("headers", [])]
        headers = dict(header_pairs)
        if not self._has_valid_request_target(scope, header_pairs):
            await self._reject(scope, receive, send, 400, "Invalid request target.")
            return
        if scope.get("path") == "/health":
            await self.application(scope, receive, send)
            return
        if self._is_browser_request(headers):
            await self._reject(scope, receive, send, 403, "Browser requests are not allowed.")
            return
        if not self._has_valid_token(header_pairs):
            await self._reject(scope, receive, send, 401, "Internal API token required.")
            return
        if self._is_urlencoded_form(header_pairs):
            await self._reject(scope, receive, send, 415, "URL-encoded forms are not supported.")
            return
        await self.application(scope, receive, send)

    @staticmethod
    def _is_browser_request(headers: dict) -> bool:
        fetch_site = headers.get(b"sec-fetch-site", b"").decode("ascii", "ignore")
        return b"origin" in headers or fetch_site == "cross-site"

    @staticmethod
    def _has_valid_request_target(scope, header_pairs: list[tuple[bytes, bytes]]) -> bool:
        host_values = [value for name, value in header_pairs if name == b"host"]
        path = scope.get("path", "")
        if len(host_values) != 1 or not path.startswith("/") or path.startswith("//"):
            return False
        try:
            host = host_values[0].decode("ascii")
        except UnicodeDecodeError:
            return False
        allowed_host_characters = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-:[]")
        if not host or len(host) > 255 or any(char not in allowed_host_characters for char in host):
            return False
        try:
            parsed = urlsplit(f"//{host}", allow_fragments=False)
            if parsed.port is not None and parsed.port < 1:
                return False
            return bool(
                parsed.hostname and parsed.netloc == host and not parsed.path
                and parsed.username is None and parsed.password is None
            )
        except ValueError:
            return False

    @staticmethod
    def _is_urlencoded_form(header_pairs: list[tuple[bytes, bytes]]) -> bool:
        values = [value for name, value in header_pairs if name == b"content-type"]
        if len(values) > 1:
            return True
        media_type = values[0].split(b";", 1)[0].strip().lower() if values else b""
        return media_type == b"application/x-www-form-urlencoded"

    def _has_valid_token(self, header_pairs: list[tuple[bytes, bytes]]) -> bool:
        values = [value for name, value in header_pairs if name == b"x-chat-context-token"]
        if len(values) != 1:
            return False
        try:
            supplied = values[0].decode("utf-8")
        except UnicodeDecodeError:
            return False
        return has_valid_internal_token(supplied, self.internal_token)

    @staticmethod
    async def _reject(scope, receive, send, status_code: int, detail: str) -> None:
        response = JSONResponse(
            status_code=status_code,
            content={"detail": detail},
            headers={"Cache-Control": "no-store"},
        )
        await response(scope, receive, send)


def require_internal_token(internal_token: Optional[str]) -> str:
    normalized_token = (internal_token or "").strip()
    if not normalized_token:
        raise ValueError("CHAT_CONTEXT_INTERNAL_TOKEN is required.")
    return normalized_token


def has_valid_internal_token(supplied_token: str, internal_token: str) -> bool:
    return secrets.compare_digest(supplied_token, require_internal_token(internal_token))
