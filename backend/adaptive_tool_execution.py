import json
import time
from typing import List

from pydantic import ValidationError

from backend.agent_protocol import AgentToolCall, AgentToolOutput
from backend.archive_time import resolve_archive_time_range
from backend.archive_tool_contracts import (
    CONTEXT_TOOL, SEARCH_TOOL, TEXT_SEARCH_TOOL, ReadContextArguments,
    SearchArchiveArguments, SearchTextArguments,
)
from backend.openai_gateway import ExternalIntegrationError


MAX_ADDITIONAL_ARCHIVE_ACTIONS = 2


def check_adaptive_deadline(deadline: float) -> None:
    if time.monotonic() > deadline:
        raise ExternalIntegrationError("Adaptive chat exceeded its 120 second deadline.")


class AdaptiveArchiveToolExecutor:
    def __init__(
        self, archive_tools, recorder, timezone_name: str,
        initial_sources, allow_general_knowledge: bool,
    ) -> None:
        self.archive_tools = archive_tools
        self.recorder = recorder
        self.timezone_name = timezone_name
        self.initial_sources = initial_sources
        self.allow_general_knowledge = allow_general_knowledge
        self.initial_sources_added = False

    def required_first(self, calls, registry, deadline) -> AgentToolOutput:
        allowed_tools = {SEARCH_TOOL.name, TEXT_SEARCH_TOOL.name}
        if len(calls) != 1 or calls[0].name not in allowed_tools:
            raise ExternalIntegrationError(
                "Adaptive provider did not return one required archive retrieval call."
            )
        try:
            if calls[0].name == SEARCH_TOOL.name:
                return self._search_output(calls[0], registry, deadline)
            return self._text_search_output(calls[0], registry, deadline)
        except (ValidationError, ValueError) as error:
            raise ExternalIntegrationError(
                "Provider returned invalid retrieval arguments."
            ) from error
        except ExternalIntegrationError:
            if not self.allow_general_knowledge:
                raise
            return self._error_output(
                calls[0], self._optional_failure_code(calls[0].name),
            )

    def additional_outputs(self, calls, registry, deadline) -> List[AgentToolOutput]:
        outputs = []
        for index, call in enumerate(calls):
            if index >= MAX_ADDITIONAL_ARCHIVE_ACTIONS:
                self.recorder.skip(call.name, "archive_action_limit")
                outputs.append(self._error_output(call, "archive_action_limit"))
                continue
            outputs.append(self._execute_optional(call, registry, deadline))
        return outputs

    def _execute_optional(self, call, registry, deadline) -> AgentToolOutput:
        try:
            if call.name == SEARCH_TOOL.name:
                return self._search_output(call, registry, deadline)
            if call.name == TEXT_SEARCH_TOOL.name:
                return self._text_search_output(call, registry, deadline)
            if call.name == CONTEXT_TOOL.name:
                return self._context_output(call, registry, deadline)
            return self._error_output(call, "unknown_tool")
        except (ValidationError, ValueError):
            self.recorder.skip(call.name, "invalid_arguments")
            return self._error_output(call, "invalid_arguments")
        except ExternalIntegrationError:
            if not self.allow_general_knowledge:
                raise
            return self._error_output(call, self._optional_failure_code(call.name))

    @staticmethod
    def _optional_failure_code(tool_name: str) -> str:
        if tool_name == CONTEXT_TOOL.name:
            return "archive_context_failed"
        if tool_name == TEXT_SEARCH_TOOL.name:
            return "archive_text_search_failed"
        return "archive_tool_failed"

    def _search_output(self, call, registry, deadline) -> AgentToolOutput:
        check_adaptive_deadline(deadline)
        arguments = SearchArchiveArguments.model_validate_json(call.arguments)
        time_range = resolve_archive_time_range(
            arguments.date_from, arguments.date_to, self.timezone_name,
        )
        activity, started_at = self.recorder.start_search(
            arguments.query, time_range, self.timezone_name,
        )
        try:
            sources = self.archive_tools.search(
                arguments.query, deadline, time_range,
            ) if time_range else self.archive_tools.search(arguments.query, deadline)
            payload = self._add_search_evidence(
                registry, sources, time_range, "search",
            )
        except Exception:
            self.recorder.fail(activity, started_at, "archive_search_failed")
            raise
        check_adaptive_deadline(deadline)
        payload["query"] = arguments.query
        payload["time_range"] = time_range.payload() if time_range else None
        self.recorder.complete(activity, started_at, len(sources), payload)
        return self._json_output(call.call_id, payload)

    def _text_search_output(self, call, registry, deadline) -> AgentToolOutput:
        check_adaptive_deadline(deadline)
        arguments = SearchTextArguments.model_validate_json(call.arguments)
        time_range = resolve_archive_time_range(
            arguments.date_from, arguments.date_to, self.timezone_name,
        )
        activity, started_at = self.recorder.start_text_search(
            arguments, time_range, self.timezone_name,
        )
        try:
            result = self.archive_tools.search_text(arguments, time_range)
            payload = self._add_search_evidence(
                registry, result.sources, time_range, "text_search",
            )
        except Exception:
            self.recorder.fail(activity, started_at, "archive_text_search_failed")
            raise
        check_adaptive_deadline(deadline)
        payload.update(self._text_search_metadata(arguments, result, time_range))
        self.recorder.complete(activity, started_at, len(result.sources), payload)
        return self._json_output(call.call_id, payload)

    @staticmethod
    def _text_search_metadata(arguments, result, time_range) -> dict:
        return {
            "patterns": arguments.patterns, "match_mode": arguments.match_mode,
            "operator": arguments.operator, "sort": arguments.sort,
            "chronology_complete": result.chronology_complete,
            "ordering_basis": result.ordering_basis,
            "time_range": time_range.payload() if time_range else None,
        }

    def _add_search_evidence(self, registry, sources, time_range, origin) -> dict:
        recent_payload = {"messages": [], "budget_exhausted": False}
        if not self.initial_sources_added:
            recent_payload = registry.add_sources(self.initial_sources, "recent")
            self.initial_sources_added = True
        search_payload = registry.add_sources(sources, origin, time_range)
        search_payload["messages"] = [
            *recent_payload.get("messages", []), *search_payload.get("messages", []),
        ]
        search_payload["budget_exhausted"] = bool(
            recent_payload.get("budget_exhausted")
            or search_payload.get("budget_exhausted")
        )
        return search_payload

    def _context_output(self, call, registry, deadline) -> AgentToolOutput:
        check_adaptive_deadline(deadline)
        arguments = ReadContextArguments.model_validate_json(call.arguments)
        record = registry.record_for(arguments.evidence_id)
        if not record:
            self.recorder.skip(CONTEXT_TOOL.name, "unknown_evidence_id")
            return self._error_output(call, "unknown_evidence_id")
        activity, started_at = self.recorder.start_context(
            arguments.evidence_id, arguments.before_count, arguments.after_count,
            record.time_range, self.timezone_name,
        )
        try:
            sources = self._read_context(arguments, record)
            payload = registry.add_sources(sources, "context", record.time_range)
        except Exception:
            self.recorder.fail(activity, started_at, "archive_context_failed")
            raise
        check_adaptive_deadline(deadline)
        payload["anchor_evidence_id"] = arguments.evidence_id
        payload["time_range"] = (
            record.time_range.payload() if record.time_range else None
        )
        self.recorder.complete(activity, started_at, len(sources), payload)
        return self._json_output(call.call_id, payload)

    def _read_context(self, arguments, record):
        context_arguments = (
            record.source, arguments.before_count, arguments.after_count,
        )
        if record.time_range:
            return self.archive_tools.read_context(
                *context_arguments, record.time_range,
            )
        return self.archive_tools.read_context(*context_arguments)

    @staticmethod
    def _json_output(call_id: str, payload: dict) -> AgentToolOutput:
        return AgentToolOutput(call_id, json.dumps(payload, ensure_ascii=False))

    def _error_output(self, call: AgentToolCall, code: str) -> AgentToolOutput:
        return self._json_output(call.call_id, {
            "kind": "archive_tool_error", "error": code,
        })
