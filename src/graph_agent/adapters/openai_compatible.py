from __future__ import annotations

import asyncio
import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Mapping, Protocol
from urllib.parse import urlparse

from ..models import (
    Message,
    MessageRole,
    ModelRequest,
    ModelResponse,
    ToolCall,
    Usage,
)


class JSONTransport(Protocol):
    async def post_json(
        self,
        *,
        url: str,
        headers: Mapping[str, str],
        payload: Mapping[str, Any],
        timeout_seconds: float,
    ) -> Mapping[str, Any]: ...


class UrllibJSONTransport:
    async def post_json(
        self,
        *,
        url: str,
        headers: Mapping[str, str],
        payload: Mapping[str, Any],
        timeout_seconds: float,
    ) -> Mapping[str, Any]:
        return await asyncio.to_thread(
            self._post_json,
            url=url,
            headers=headers,
            payload=payload,
            timeout_seconds=timeout_seconds,
        )

    def _post_json(
        self,
        *,
        url: str,
        headers: Mapping[str, str],
        payload: Mapping[str, Any],
        timeout_seconds: float,
    ) -> Mapping[str, Any]:
        request = urllib.request.Request(
            url=url,
            data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
            headers=dict(headers),
            method="POST",
        )
        try:
            opener = urllib.request.build_opener(_NoRedirectHandler())
            with opener.open(request, timeout=timeout_seconds) as response:
                parsed = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise ModelTransportError(f"Model endpoint returned HTTP {exc.code}") from exc
        except urllib.error.URLError as exc:
            raise ModelTransportError("Could not reach model endpoint") from exc
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ModelTransportError("Model endpoint returned invalid JSON") from exc
        if not isinstance(parsed, dict):
            raise ModelTransportError("Model endpoint returned a non-object JSON value")
        return parsed


@dataclass(slots=True)
class OpenAICompatibleModel:
    """Dependency-free adapter for OpenAI-compatible Chat Completions APIs."""

    model: str
    api_key: str | None = field(default=None, repr=False)
    base_url: str = "https://api.openai.com/v1"
    timeout_seconds: float = 60.0
    transport: JSONTransport | None = None

    def __post_init__(self) -> None:
        if not self.model.strip():
            raise ValueError("model must not be empty")
        self.base_url = self.base_url.rstrip("/")
        _validate_base_url(self.base_url)
        if self.timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        if self.api_key is None and _is_openai_api(self.base_url):
            self.api_key = os.getenv("OPENAI_API_KEY")
        if self.transport is None:
            self.transport = UrllibJSONTransport()

    async def complete(self, request: ModelRequest) -> ModelResponse:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": request.instructions},
                *[_message_payload(message) for message in request.messages],
            ],
        }
        if request.tools:
            payload["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": dict(tool.input_schema),
                    },
                }
                for tool in request.tools
            ]
            payload["tool_choice"] = "auto"

        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        assert self.transport is not None
        response = await self.transport.post_json(
            url=f"{self.base_url}/chat/completions",
            headers=headers,
            payload=payload,
            timeout_seconds=self.timeout_seconds,
        )
        return _parse_response(response)


class ModelTransportError(RuntimeError):
    pass


class InvalidModelResponse(RuntimeError):
    pass


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


def _message_payload(message: Message) -> dict[str, Any]:
    if message.role is MessageRole.CONTEXT:
        return {"role": "user", "content": message.content}
    payload: dict[str, Any] = {
        "role": message.role.value,
        "content": message.content,
    }
    if message.role is MessageRole.ASSISTANT and message.tool_calls:
        payload["tool_calls"] = [
            {
                "id": call.id,
                "type": "function",
                "function": {
                    "name": call.name,
                    "arguments": json.dumps(
                        dict(call.arguments), separators=(",", ":"), sort_keys=True
                    ),
                },
            }
            for call in message.tool_calls
        ]
    if message.role is MessageRole.TOOL:
        if not message.tool_call_id:
            raise ValueError("tool messages require tool_call_id")
        payload["tool_call_id"] = message.tool_call_id
    elif message.name:
        payload["name"] = message.name
    return payload


def _parse_response(response: Mapping[str, Any]) -> ModelResponse:
    try:
        choice = response["choices"][0]
        message = choice["message"]
    except (KeyError, IndexError, TypeError) as exc:
        raise InvalidModelResponse("Response has no completion choice") from exc
    if not isinstance(message, Mapping):
        raise InvalidModelResponse("Completion message must be an object")

    calls: list[ToolCall] = []
    for raw_call in message.get("tool_calls") or ():
        try:
            if raw_call.get("type") != "function":
                raise InvalidModelResponse("Only function tool calls are supported")
            function = raw_call["function"]
            arguments = json.loads(function.get("arguments") or "{}")
            if not isinstance(arguments, dict):
                raise InvalidModelResponse("Tool arguments must be a JSON object")
            calls.append(
                ToolCall(
                    id=str(raw_call["id"]),
                    name=str(function["name"]),
                    arguments=arguments,
                )
            )
        except (KeyError, TypeError, json.JSONDecodeError) as exc:
            raise InvalidModelResponse("Malformed function tool call") from exc

    usage = response.get("usage") or {}
    content = _text_content(message.get("content"))
    return ModelResponse(
        content=content,
        tool_calls=tuple(calls),
        usage=Usage(
            input_tokens=int(usage.get("prompt_tokens") or 0),
            output_tokens=int(usage.get("completion_tokens") or 0),
        ),
        finish_reason=str(choice.get("finish_reason") or "") or None,
    )


def _text_content(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = [
            str(part.get("text", ""))
            for part in value
            if isinstance(part, Mapping) and part.get("type") == "text"
        ]
        return "".join(parts) or None
    raise InvalidModelResponse("Completion content must be text")


def _validate_base_url(base_url: str) -> None:
    parsed = urlparse(base_url)
    if not parsed.hostname or parsed.scheme not in {"http", "https"}:
        raise ValueError("base_url must be an absolute HTTP(S) URL")
    is_loopback = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if parsed.scheme != "https" and not is_loopback:
        raise ValueError("Remote model endpoints must use HTTPS")
    if parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise ValueError("base_url must not contain credentials, query, or fragment")


def _is_openai_api(base_url: str) -> bool:
    return urlparse(base_url).hostname == "api.openai.com"
