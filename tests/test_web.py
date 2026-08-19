from __future__ import annotations

import asyncio
import json
import threading
import unittest
from typing import Any, Mapping
from unittest.mock import AsyncMock, patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from graph_agent.adapters.openai_compatible import ModelTransportError
from graph_agent.web import DeepSeekConfig, create_server, run_studio_graph


class FakeDeepSeekTransport:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.responses = [
            {
                "choices": [
                    {
                        "finish_reason": "tool_calls",
                        "message": {
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "spawn-researcher",
                                    "type": "function",
                                    "function": {
                                        "name": "graph__propose_spawn",
                                        "arguments": json.dumps(
                                            {
                                                "role": "researcher",
                                                "objective": "独立分析用户任务",
                                                "instructions": "给出简洁且可验证的分析。",
                                                "priority": 0.8,
                                                "budget_share": 0.3,
                                            }
                                        ),
                                    },
                                }
                            ],
                        },
                    }
                ],
                "usage": {"prompt_tokens": 60, "completion_tokens": 15},
            },
            {
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {"content": "主 Agent 的真实回答。"},
                    }
                ],
                "usage": {"prompt_tokens": 90, "completion_tokens": 20},
            },
            {
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {"content": "子 Agent 的独立分析。"},
                    }
                ],
                "usage": {"prompt_tokens": 70, "completion_tokens": 18},
            },
        ]

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
                "headers": dict(headers),
                "payload": dict(payload),
                "timeout_seconds": timeout_seconds,
                "url": url,
            }
        )
        return self.responses.pop(0)


class FailingDeepSeekTransport:
    async def post_json(self, **kwargs) -> Mapping[str, Any]:
        raise ModelTransportError("HTTP 401 with hidden credentials")


class GraphAgentStudioTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = create_server("127.0.0.1", 0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def test_serves_studio_and_health_with_security_headers(self) -> None:
        with urlopen(f"{self.base_url}/", timeout=2) as response:
            page = response.read().decode("utf-8")
            self.assertEqual(200, response.status)
            self.assertIn("Graph Agent Studio", page)
            self.assertIn("default-src 'self'", response.headers["Content-Security-Policy"])
            self.assertEqual("nosniff", response.headers["X-Content-Type-Options"])
            self.assertIn("camera=()", response.headers["Permissions-Policy"])

        with urlopen(f"{self.base_url}/api/health", timeout=2) as response:
            payload = json.load(response)
            self.assertEqual("ok", payload["status"])
            self.assertIn("deepseek-v4-flash", payload["models"])

    def test_real_graph_uses_deepseek_adapter_and_collects_outputs(self) -> None:
        transport = FakeDeepSeekTransport()
        secret = "test-key-not-a-real-credential"

        payload = asyncio.run(
            run_studio_graph(
                "验证真实图 Agent",
                DeepSeekConfig(api_key=secret, model="deepseek-v4-flash"),
                conversation=(
                    {"role": "user", "content": "记住项目使用 Python。"},
                    {"role": "assistant", "content": "好的，我会记住。"},
                ),
                transport=transport,
            )
        )

        snapshot = payload["snapshot"]
        self.assertEqual("succeeded", snapshot["status"])
        self.assertEqual(2, len(snapshot["nodes"]))
        self.assertEqual(["spawn"], [edge["type"] for edge in snapshot["edges"]])
        self.assertEqual("主 Agent 的真实回答。", payload["primary_output"])
        self.assertEqual("disabled", payload["provider"]["thinking"])
        self.assertEqual(2, len(payload["node_results"]))
        self.assertTrue(payload["controller_event_chain_valid"])
        self.assertTrue(payload["live"])
        self.assertEqual(3, len(transport.calls))
        self.assertTrue(
            all(
                call["url"] == "https://api.deepseek.com/chat/completions"
                for call in transport.calls
            )
        )
        self.assertTrue(
            all(
                call["headers"]["Authorization"] == f"Bearer {secret}"
                for call in transport.calls
            )
        )
        self.assertTrue(
            all(call["payload"]["max_tokens"] == 2_048 for call in transport.calls)
        )
        self.assertTrue(
            all(
                call["payload"]["thinking"] == {"type": "disabled"}
                for call in transport.calls
            )
        )
        self.assertTrue(all("tool_choice" not in call["payload"] for call in transport.calls))
        first_messages = transport.calls[0]["payload"]["messages"]
        self.assertTrue(
            any("记住项目使用 Python" in message["content"] for message in first_messages)
        )
        self.assertEqual("验证真实图 Agent", first_messages[-1]["content"])
        self.assertNotIn(secret, json.dumps(payload, ensure_ascii=False))

    @patch("graph_agent.web.run_studio_graph", new_callable=AsyncMock)
    def test_run_api_validates_provider_without_echoing_key(self, run_graph) -> None:
        run_graph.return_value = {
            "live": True,
            "snapshot": {"status": "succeeded"},
        }
        secret = "test-browser-placeholder-key"
        request = Request(
            f"{self.base_url}/api/runs",
            data=json.dumps(
                {
                    "conversation": [],
                    "task": "运行真实 Agent",
                    "provider": {
                        "type": "deepseek",
                        "api_key": secret,
                        "model": "deepseek-v4-pro",
                    },
                }
            ).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        with urlopen(request, timeout=3) as response:
            body = response.read().decode("utf-8")
            payload = json.loads(body)

        self.assertTrue(payload["live"])
        self.assertNotIn(secret, body)
        passed_config = run_graph.await_args.args[1]
        self.assertEqual("deepseek-v4-pro", passed_config.model)
        self.assertEqual(secret, passed_config.api_key)
        self.assertNotIn(secret, repr(passed_config))
        self.assertEqual((), run_graph.await_args.kwargs["conversation"])

    def test_run_api_rejects_invalid_json_shape_and_cross_site_requests(self) -> None:
        invalid = Request(
            f"{self.base_url}/api/runs",
            data=json.dumps({"task": " ", "extra": True}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with self.assertRaises(HTTPError) as raised:
            urlopen(invalid, timeout=2)
        self.assertEqual(400, raised.exception.code)

        cross_site = Request(
            f"{self.base_url}/api/runs",
            data=b"{}",
            headers={
                "Content-Type": "application/json",
                "Sec-Fetch-Site": "cross-site",
            },
            method="POST",
        )
        with self.assertRaises(HTTPError) as raised:
            urlopen(cross_site, timeout=2)
        self.assertEqual(403, raised.exception.code)

    def test_run_api_rejects_malformed_conversation_history(self) -> None:
        malformed_histories = (
            [{"role": "assistant", "content": "不能从 assistant 开始"}],
            [{"role": "user", "content": "缺少 assistant 结尾"}],
            [
                {"role": "user", "content": "第一轮"},
                {"role": "user", "content": "角色没有交替"},
            ],
            [{"role": "system", "content": "不允许注入 system"}],
        )
        for conversation in malformed_histories:
            with self.subTest(conversation=conversation):
                request = Request(
                    f"{self.base_url}/api/runs",
                    data=json.dumps(
                        {
                            "conversation": conversation,
                            "task": "继续任务",
                            "provider": {
                                "type": "deepseek",
                                "api_key": "test-placeholder-key",
                                "model": "deepseek-v4-flash",
                            },
                        }
                    ).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with self.assertRaises(HTTPError) as raised:
                    urlopen(request, timeout=2)
                self.assertEqual(400, raised.exception.code)

    def test_model_failure_keeps_valid_event_chain_without_echoing_secret(self) -> None:
        secret = "test-failing-placeholder-key"

        payload = asyncio.run(
            run_studio_graph(
                "验证失败路径",
                DeepSeekConfig(api_key=secret, model="deepseek-v4-flash"),
                transport=FailingDeepSeekTransport(),
            )
        )

        self.assertEqual("failed", payload["snapshot"]["status"])
        self.assertEqual("failed", payload["node_results"][0]["status"])
        self.assertIsNotNone(
            payload["snapshot"]["executions"][0]["event_chain_head"]
        )
        self.assertTrue(payload["controller_event_chain_valid"])
        self.assertNotIn(secret, json.dumps(payload, ensure_ascii=False))

    def test_deepseek_config_rejects_unknown_model_and_malformed_key(self) -> None:
        with self.assertRaisesRegex(ValueError, "模型"):
            DeepSeekConfig(api_key="test-placeholder-key", model="deepseek-chat")
        with self.assertRaisesRegex(ValueError, "API Key"):
            DeepSeekConfig(api_key=" short ", model="deepseek-v4-flash")
        with self.assertRaisesRegex(ValueError, "loopback"):
            create_server("0.0.0.0", 0)


if __name__ == "__main__":
    unittest.main()
