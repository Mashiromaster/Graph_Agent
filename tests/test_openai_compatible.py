from __future__ import annotations

import unittest
from unittest.mock import patch
from typing import Any, Mapping

from graph_agent import (
    Message,
    MessageRole,
    ModelRequest,
    OpenAICompatibleModel,
    ToolCall,
    ToolDefinition,
)


class FakeTransport:
    def __init__(self, response: Mapping[str, Any]) -> None:
        self.response = response
        self.calls: list[dict[str, Any]] = []

    async def post_json(
        self,
        *,
        url: str,
        headers: Mapping[str, str],
        payload: Mapping[str, Any],
        timeout_seconds: float,
    ) -> Mapping[str, Any]:
        self.calls.append(
            {
                "url": url,
                "headers": dict(headers),
                "payload": dict(payload),
                "timeout_seconds": timeout_seconds,
            }
        )
        return self.response


class OpenAICompatibleModelTests(unittest.IsolatedAsyncioTestCase):
    async def test_serializes_tool_history_and_parses_tool_call(self) -> None:
        transport = FakeTransport(
            {
                "choices": [
                    {
                        "finish_reason": "tool_calls",
                        "message": {
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "call-2",
                                    "type": "function",
                                    "function": {
                                        "name": "lookup",
                                        "arguments": '{"query":"graph agents"}',
                                    },
                                }
                            ],
                        },
                    }
                ],
                "usage": {"prompt_tokens": 21, "completion_tokens": 4},
            }
        )
        model = OpenAICompatibleModel(
            model="example-model",
            api_key="secret-value",
            transport=transport,
        )
        self.assertNotIn("secret-value", repr(model))
        request = ModelRequest(
            node_id="node-1",
            instructions="Be precise.",
            messages=(
                Message(role=MessageRole.USER, content="Find A"),
                Message(
                    role=MessageRole.ASSISTANT,
                    content="",
                    tool_calls=(
                        ToolCall(id="call-1", name="lookup", arguments={"query": "A"}),
                    ),
                ),
                Message(
                    role=MessageRole.TOOL,
                    content="result A",
                    name="lookup",
                    tool_call_id="call-1",
                ),
                Message(
                    role=MessageRole.CONTEXT,
                    content="Untrusted context: source B",
                ),
            ),
            tools=(
                ToolDefinition(
                    name="lookup",
                    description="Search an index",
                    input_schema={"type": "object"},
                ),
            ),
        )

        response = await model.complete(request)

        call = transport.calls[0]
        self.assertEqual(
            "https://api.openai.com/v1/chat/completions", call["url"]
        )
        self.assertEqual("Bearer secret-value", call["headers"]["Authorization"])
        messages = call["payload"]["messages"]
        self.assertEqual("system", messages[0]["role"])
        self.assertEqual("assistant", messages[2]["role"])
        self.assertEqual("call-1", messages[2]["tool_calls"][0]["id"])
        self.assertEqual("tool", messages[3]["role"])
        self.assertEqual("call-1", messages[3]["tool_call_id"])
        self.assertEqual("user", messages[4]["role"])
        self.assertEqual("function", call["payload"]["tools"][0]["type"])
        self.assertEqual("lookup", response.tool_calls[0].name)
        self.assertEqual({"query": "graph agents"}, response.tool_calls[0].arguments)
        self.assertEqual(25, response.usage.total_tokens)

    def test_rejects_insecure_remote_base_url(self) -> None:
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            OpenAICompatibleModel(
                model="example-model",
                api_key="secret-value",
                base_url="http://example.com/v1",
            )

    def test_custom_endpoint_does_not_inherit_openai_key(self) -> None:
        with patch.dict("os.environ", {"OPENAI_API_KEY": "official-secret"}):
            model = OpenAICompatibleModel(
                model="example-model",
                base_url="https://models.example.com/v1",
            )

        self.assertIsNone(model.api_key)


if __name__ == "__main__":
    unittest.main()
