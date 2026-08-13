from __future__ import annotations

import asyncio

from graph_agent import (
    AgentIdentity,
    AgentInput,
    AgentNode,
    AgentSpec,
    FunctionTool,
    OpenAICompatibleModel,
)


def word_count(text: str) -> int:
    """Count whitespace-separated words in text."""
    return len(text.split())


async def main() -> None:
    model = OpenAICompatibleModel(model="your-model-name")
    node = AgentNode(
        spec=AgentSpec(
            identity=AgentIdentity(
                node_id="example-root",
                name="Universal Agent",
                role="generalist",
            ),
            instructions=(
                "Answer precisely. Use tools when useful and propose a reviewer "
                "child when independent verification materially reduces risk."
            ),
        ),
        model=model,
        tools=[FunctionTool.from_callable(word_count)],
    )
    result = await node.run(
        AgentInput(task="Count the words in: graph agents can delegate work")
    )
    print(result)


if __name__ == "__main__":
    asyncio.run(main())
