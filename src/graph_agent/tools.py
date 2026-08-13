from __future__ import annotations

import asyncio
import inspect
import json
from dataclasses import dataclass
from types import UnionType
from typing import (
    Any,
    Callable,
    Mapping,
    Protocol,
    Union,
    get_args,
    get_origin,
    get_type_hints,
)

from .models import ToolDefinition


class Tool(Protocol):
    @property
    def definition(self) -> ToolDefinition: ...

    async def invoke(self, arguments: Mapping[str, Any]) -> str: ...


@dataclass(slots=True)
class FunctionTool:
    name: str
    description: str
    callable: Callable[..., Any]
    input_schema: Mapping[str, Any]
    signature: inspect.Signature

    @classmethod
    def from_callable(
        cls,
        callable: Callable[..., Any],
        *,
        name: str | None = None,
        description: str | None = None,
    ) -> FunctionTool:
        signature = inspect.signature(callable)
        try:
            type_hints = get_type_hints(callable)
        except (NameError, TypeError):
            type_hints = {}
        signature = signature.replace(
            parameters=[
                parameter.replace(
                    annotation=type_hints.get(parameter.name, parameter.annotation)
                )
                for parameter in signature.parameters.values()
            ],
            return_annotation=type_hints.get("return", signature.return_annotation),
        )
        return cls(
            name=name or callable.__name__,
            description=description or inspect.getdoc(callable) or "",
            callable=callable,
            input_schema=_schema_for_signature(signature),
            signature=signature,
        )

    @property
    def definition(self) -> ToolDefinition:
        return ToolDefinition(
            name=self.name,
            description=self.description,
            input_schema=self.input_schema,
        )

    async def invoke(self, arguments: Mapping[str, Any]) -> str:
        try:
            bound = self.signature.bind(**dict(arguments))
        except TypeError as exc:
            raise ToolArgumentError(str(exc)) from exc
        if inspect.iscoroutinefunction(self.callable):
            result = await self.callable(*bound.args, **bound.kwargs)
        else:
            result = await asyncio.to_thread(
                self.callable, *bound.args, **bound.kwargs
            )
        if inspect.isawaitable(result):
            result = await result
        if isinstance(result, str):
            return result
        return json.dumps(result, default=str, sort_keys=True)


class ToolArgumentError(ValueError):
    pass


def _schema_for_signature(signature: inspect.Signature) -> Mapping[str, Any]:
    properties: dict[str, Any] = {}
    required: list[str] = []
    for name, parameter in signature.parameters.items():
        if parameter.kind in (parameter.VAR_POSITIONAL, parameter.VAR_KEYWORD):
            continue
        properties[name] = _json_schema_for_type(parameter.annotation)
        if parameter.default is inspect.Signature.empty:
            required.append(name)
        else:
            properties[name]["default"] = parameter.default
    schema: dict[str, Any] = {
        "type": "object",
        "properties": properties,
        "additionalProperties": False,
    }
    if required:
        schema["required"] = required
    return schema


def _json_schema_for_type(annotation: Any) -> dict[str, Any]:
    if annotation is inspect.Signature.empty or annotation is Any:
        return {}
    origin = get_origin(annotation)
    args = get_args(annotation)
    if origin in (Union, UnionType):
        non_none = [arg for arg in args if arg is not type(None)]
        schema = _json_schema_for_type(non_none[0]) if len(non_none) == 1 else {}
        if len(non_none) != len(args):
            schema = {"anyOf": [schema, {"type": "null"}]}
        return schema
    if origin in (list, tuple):
        item_type = args[0] if args else Any
        return {"type": "array", "items": _json_schema_for_type(item_type)}
    if origin is dict:
        return {"type": "object"}
    mapping = {
        str: "string",
        int: "integer",
        float: "number",
        bool: "boolean",
    }
    return {"type": mapping[annotation]} if annotation in mapping else {}
