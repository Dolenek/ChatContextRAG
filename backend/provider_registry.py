import threading
from dataclasses import dataclass
from typing import Dict, List, Optional

from openai import OpenAI, OpenAIError

from backend.models import ProviderProfileInput, ProviderProfileView
from backend.openai_gateway import (
    ExternalIntegrationError, IntegrationConfigurationError,
    OpenAIChatCompletionProvider, OpenAIEmbeddingProvider,
)

BUILTIN_OPENAI_URL = "https://api.openai.com/v1"


@dataclass(frozen=True)
class ProviderConfiguration:
    provider_id: str
    name: str
    base_url: str
    api_key: Optional[str]
    chat_api: str
    builtin: bool = False


class ProviderRegistry:
    def __init__(
        self, openai_api_key: Optional[str], embedding_batch_size: int = 64,
    ) -> None:
        self.embedding_batch_size = embedding_batch_size
        self._lock = threading.RLock()
        self._environment_api_key = openai_api_key
        self._builtin = self._builtin_configuration(openai_api_key)
        self._custom: Dict[str, ProviderConfiguration] = {}

    def replace_custom(self, profiles: List[ProviderProfileInput]) -> None:
        configurations = {}
        builtin_api_key = self._environment_api_key
        for profile in profiles:
            if profile.provider_id == "openai":
                self._validate_builtin_override(profile)
                builtin_api_key = profile.api_key or self._environment_api_key
                continue
            configurations[profile.provider_id] = ProviderConfiguration(
                provider_id=profile.provider_id, name=profile.name,
                base_url=profile.base_url.rstrip("/"), api_key=profile.api_key,
                chat_api=profile.chat_api,
            )
        with self._lock:
            self._builtin = self._builtin_configuration(builtin_api_key)
            self._custom = configurations

    def list_views(self) -> List[ProviderProfileView]:
        with self._lock:
            configurations = [self._builtin, *self._custom.values()]
        return [self._to_view(configuration) for configuration in configurations]

    def get(self, provider_id: str) -> ProviderConfiguration:
        with self._lock:
            configuration = (
                self._builtin if provider_id == "openai" else self._custom.get(provider_id)
            )
        if not configuration:
            raise IntegrationConfigurationError(
                f"Provider '{provider_id}' is not configured."
            )
        if configuration.builtin and not configuration.api_key:
            raise IntegrationConfigurationError(
                f"API key for provider '{provider_id}' is missing."
            )
        return configuration

    def create_embedding_provider(
        self, provider_id: str, model: str, dimensions: Optional[int],
    ) -> OpenAIEmbeddingProvider:
        configuration = self.get(provider_id)
        return OpenAIEmbeddingProvider(
            configuration.api_key, model, dimensions, self.embedding_batch_size,
            configuration.base_url,
        )

    def create_chat_provider(
        self, provider_id: str, model: str,
    ) -> OpenAIChatCompletionProvider:
        configuration = self.get(provider_id)
        return OpenAIChatCompletionProvider(
            configuration.api_key, model, configuration.base_url,
            configuration.chat_api, strict_tools=configuration.builtin,
        )

    def list_models(self, provider_id: str) -> List[str]:
        configuration = self.get(provider_id)
        try:
            response = OpenAI(
                api_key=configuration.api_key or "local", base_url=configuration.base_url,
            ).models.list()
        except OpenAIError as error:
            raise ExternalIntegrationError(
                f"Model list request for provider '{provider_id}' failed."
            ) from error
        return sorted({model.id for model in response.data})

    @staticmethod
    def _builtin_configuration(api_key: Optional[str]) -> ProviderConfiguration:
        return ProviderConfiguration(
            provider_id="openai", name="OpenAI", base_url=BUILTIN_OPENAI_URL,
            api_key=api_key, chat_api="responses", builtin=True,
        )

    @staticmethod
    def _validate_builtin_override(profile: ProviderProfileInput) -> None:
        if profile.base_url.rstrip("/") != BUILTIN_OPENAI_URL \
                or profile.chat_api != "responses":
            raise ValueError(
                "Only the API key can be changed for the built-in OpenAI provider."
            )

    @staticmethod
    def _to_view(configuration: ProviderConfiguration) -> ProviderProfileView:
        return ProviderProfileView(
            provider_id=configuration.provider_id, name=configuration.name,
            base_url=configuration.base_url, chat_api=configuration.chat_api,
            has_api_key=bool(configuration.api_key), builtin=configuration.builtin,
            is_available=bool(configuration.api_key) or not configuration.builtin,
        )
