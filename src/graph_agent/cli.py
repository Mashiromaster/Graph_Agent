from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import asdict
from typing import Sequence, TextIO

from .controller import GraphController
from .controller_events import verify_controller_event_chain
from .controller_models import ControllerPolicy
from .events import verify_event_chain
from .model import ScriptedModel
from .models import (
    AgentIdentity,
    AgentInput,
    AgentResult,
    AgentSpec,
    ModelResponse,
    ToolCall,
)
from .node import AgentNode
from .tools import FunctionTool


def main(argv: Sequence[str] | None = None, *, stdout: TextIO | None = None) -> int:
    parser = argparse.ArgumentParser(prog="graph-agent")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("demo", help="Run a deterministic offline node demo")
    subparsers.add_parser(
        "controller-demo", help="Run an offline dynamic graph controller demo"
    )
    args = parser.parse_args(argv)
    output = stdout or sys.stdout

    if args.command == "demo":
        result = asyncio.run(_run_demo())
        json.dump(_result_payload(result), output, ensure_ascii=False, indent=2)
        output.write("\n")
        return 0 if result.error is None else 1
    if args.command == "controller-demo":
        result = asyncio.run(_run_controller_demo())
        json.dump(result, output, ensure_ascii=False, indent=2)
        output.write("\n")
        return 0 if result["status"] == "succeeded" else 1
    return 2


async def _run_demo() -> AgentResult:
    model = ScriptedModel(
        [
            ModelResponse(
                tool_calls=(
                    ToolCall(
                        id="calculate-1",
                        name="multiply",
                        arguments={"left": 6, "right": 7},
                    ),
                    ToolCall(
                        id="spawn-1",
                        name="graph__propose_spawn",
                        arguments={
                            "role": "reviewer",
                            "objective": "Verify the result independently",
                            "instructions": "Check the arithmetic and report conflicts.",
                            "tool_names": ["multiply"],
                            "priority": 0.8,
                            "budget_share": 0.2,
                        },
                    ),
                )
            ),
            ModelResponse(content="42"),
        ]
    )
    node = AgentNode(
        spec=AgentSpec(
            identity=AgentIdentity(
                node_id="offline-demo",
                name="Universal Agent",
                role="generalist",
            ),
            instructions="Solve the task and delegate verification when useful.",
        ),
        model=model,
        tools=[FunctionTool.from_callable(_multiply, name="multiply")],
    )
    return await node.run(AgentInput(task="Calculate 6 × 7 and ask for a review."))


def _multiply(left: int, right: int) -> int:
    """Multiply two integers."""
    return left * right


class _DemoFactory:
    def create(self, *, spec: AgentSpec, tool_names: tuple[str, ...]) -> AgentNode:
        return AgentNode(
            spec=spec,
            model=ScriptedModel([ModelResponse(content="Review complete: 42 is correct.")]),
        )


async def _run_controller_demo() -> dict[str, object]:
    root_model = ScriptedModel(
        [
            ModelResponse(
                tool_calls=(
                    ToolCall(
                        id="spawn-reviewer",
                        name="graph__propose_spawn",
                        arguments={
                            "role": "reviewer",
                            "objective": "Verify that 6 × 7 equals 42",
                            "instructions": "Check the arithmetic independently.",
                            "priority": 0.8,
                            "budget_share": 0.25,
                        },
                    ),
                )
            ),
            ModelResponse(content="42"),
        ]
    )
    root = AgentNode(
        spec=AgentSpec(
            identity=AgentIdentity(
                node_id="controller-root",
                name="Controller Root",
                role="orchestrator",
            ),
            instructions="Calculate and delegate an independent review.",
        ),
        model=root_model,
    )
    controller = GraphController(
        factory=_DemoFactory(),
        policy=ControllerPolicy(max_total_tokens=64_000, max_concurrency=2),
    )
    run_id = await controller.create_run(
        root=root,
        agent_input=AgentInput(task="Calculate 6 × 7 and verify the answer."),
        run_id="offline-controller-demo",
    )
    snapshot = await controller.run_until_idle(run_id)
    payload = snapshot.to_dict()
    payload["controller_event_chain_valid"] = verify_controller_event_chain(
        controller.events(run_id)
    )
    return payload


def _result_payload(result: AgentResult) -> dict[str, object]:
    return {
        "node_id": result.node_id,
        "status": result.status.value,
        "output": result.output,
        "usage": asdict(result.usage),
        "spawn_proposals": [asdict(value) for value in result.spawn_proposals],
        "message_proposals": [asdict(value) for value in result.message_proposals],
        "skip_context_proposals": [
            asdict(value) for value in result.skip_context_proposals
        ],
        "event_count": len(result.events),
        "event_chain_valid": verify_event_chain(result.events),
        "error": asdict(result.error) if result.error else None,
    }


if __name__ == "__main__":
    raise SystemExit(main())
