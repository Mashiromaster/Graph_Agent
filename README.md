# Graph Agent Node

一个框架无关、可嵌入图运行时的通用 Agent 节点 MVP。它把单个 Agent 的模型调用、工具循环、会话记忆、资源预算和图操作意图封装为稳定协议；图的创建、调度与持久化仍由外部 Graph Controller 掌控。

当前实现借鉴了 `awesome-llm-apps` 中的轻量 Agent、上下文、会话、agents-as-tools、并行编排与信任门控模式，但没有把某个具体 Agent SDK 固化为核心依赖。

## 已实现

- 框架无关的 `AgentNode`、`ModelAdapter`、`Tool` 和结构化结果协议；
- 普通工具调用循环，支持同步与异步 Python 函数；
- `ScriptedModel` 离线适配器和 OpenAI-compatible Chat Completions 适配器；
- 按 `node_id + session_id` 隔离的会话记忆；
- 最大轮次、工具调用数、Token 数和超时预算；
- 三种图操作提议：派生子 Agent、定向消息、跨代上下文请求；
- 子节点代数、数量、工具权限和累计预算份额门控；
- 输入/输出摘要化的 SHA-256 事件哈希链，可验证但不记录明文；
- 结构化失败结果和离线 CLI 演示。

```mermaid
flowchart LR
    GC["Graph Controller"] -->|"AgentInput + ContextPacket"| N["AgentNode"]
    N --> MA["ModelAdapter"]
    MA -->|"文本或 ToolCall"| N
    N --> LT["Local Tools"]
    N --> GM["Graph operation tools"]
    GM -->|"只生成提议"| R["AgentResult"]
    LT --> N
    N --> M["SessionMemory"]
    N --> E["Hash-chained events"]
    R -->|"审批/调度/物化"| GC
```

核心安全边界是：`AgentNode` **不能直接修改图**。模型调用 `graph__propose_spawn`、`graph__send_message` 或 `graph__request_skip_context` 时，只会在 `AgentResult` 中产生提议。Graph Controller 必须再次执行全局预算、权限、目标节点存在性和循环检测，然后才能创建节点或边。

## 快速开始

要求 Python 3.11 或更高版本。核心包没有第三方运行时依赖。

```bash
python3 -m pip install .
graph-agent demo
```

也可以不安装直接运行：

```bash
PYTHONPATH=src python3 -m graph_agent.cli demo
```

演示完全离线，不需要 API Key。输出包含计算结果、一个子 Agent 派生提议以及事件链验证结果。

## 创建通用节点

```python
import asyncio

from graph_agent import (
    AgentIdentity,
    AgentInput,
    AgentNode,
    AgentSpec,
    FunctionTool,
    ModelResponse,
    OpenAICompatibleModel,
)


def search_local(query: str) -> str:
    """Search a trusted local index."""
    return f"local result for: {query}"


async def main() -> None:
    model = OpenAICompatibleModel(model="your-model-name")
    node = AgentNode(
        spec=AgentSpec(
            identity=AgentIdentity(
                node_id="root-1",
                name="Universal Agent",
                role="generalist",
            ),
            instructions=(
                "完成任务；需要独立验证时提出子 Agent 派生提议。"
            ),
        ),
        model=model,
        tools=[FunctionTool.from_callable(search_local)],
    )
    result = await node.run(AgentInput(task="研究图 Agent 的实现模式"))
    print(result.output)
    print(result.spawn_proposals)


asyncio.run(main())
```

官方 OpenAI 端点默认从 `OPENAI_API_KEY` 读取密钥：

```bash
export OPENAI_API_KEY="..."
```

兼容服务可显式配置，非本机远程端点必须使用 HTTPS；为避免密钥误发，自定义端点不会自动继承 `OPENAI_API_KEY`：

```python
model = OpenAICompatibleModel(
    model="your-model",
    base_url="https://models.example.com/v1",
    api_key="service-specific-key",
)
```

适配器采用仍受支持且兼容面较广的 `/v1/chat/completions` 工具调用格式。OpenAI 对新项目更推荐 Responses API，因此后续可增加独立 `OpenAIResponsesModel`，无需改动节点协议。参见 [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat)。

## 节点协议

`AgentNode.run(AgentInput)` 返回 `AgentResult`：

- `output`：节点最终文本；
- `usage`：累计输入/输出 Token；
- `spawn_proposals`：带父节点、代数、优先级、工具白名单和预算份额的派生提议；
- `message_proposals`：带源/目标节点、优先级和 TTL 的定向消息；
- `skip_context_proposals`：带来源节点和上下文门控值的跨代连接请求；
- `events`：只保留内容摘要与元数据的可验证事件链；
- `error`：失败代码、脱敏消息和是否可重试。

建议 Graph Controller 对提议执行以下流程：

1. 验证提议对应的事件链和发起节点身份；
2. 合并节点本地策略与图级全局策略；
3. 检查总成本、并发、深度、工具权限和环路；
4. 为获批提议分配确定性节点 ID，并写入不可变父子边；
5. 调度子节点，把结果作为 `ContextPacket` 回传；
6. 将被拒绝原因作为下一轮上下文返回给发起节点。

## 测试

```bash
PYTHONPATH=src python3 -m unittest discover -s tests -v
```

覆盖率检查：

```bash
python3 -m pip install -e '.[dev]'
python3 -m coverage run -m unittest discover -s tests
python3 -m coverage report
```

## 安全约束

- 模型输出和跨节点上下文均视为不可信输入；
- 子 Agent 只能申请父节点已经拥有的本地工具；
- 子节点预算份额累计不能超过 `1.0`；
- 工具异常与节点异常对模型返回脱敏信息，避免泄漏密钥或内部路径；
- API Key 不进入事件链，且在适配器对象的 `repr` 中隐藏；
- 事件链用于防篡改检测，不等同于数字签名；多机部署应追加 KMS/HMAC 签名；
- 自定义工具仍需自行实现参数范围、网络目的地、文件路径和副作用审批。
- 超时可以取消 Agent 协程，但无法回滚已经开始的外部副作用；有写操作的工具应使用幂等键或补偿事务。

## 目录

```text
src/graph_agent/       通用节点运行时
tests/                 离线单元与端到端测试
awesome-llm-apps/      上游参考项目源码快照
Graph_Agent_开源调研与可行性评估.md
THIRD_PARTY_NOTICES.md
SECURITY_REVIEW.md
```

## 当前边界与下一阶段

本仓库交付的是“通用节点”，还不是完整的动态图调度器。下一阶段优先实现 Graph Controller、持久化图存储、全局预算账本、循环检测、并发调度与回放；待这些基线稳定后，再加入基于运行反馈的边权更新或可学习拓扑，避免一开始把工程可控性和训练问题混在一起。

## 许可证与归属

本项目声明采用 Apache-2.0。上游参考项目的来源、快照版本和许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；其原始许可证保留在 `awesome-llm-apps/LICENSE`。
