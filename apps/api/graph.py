from __future__ import annotations

from typing import Any, TypedDict

from langgraph.graph import END, StateGraph
from langgraph.runtime import Runtime

from apps.api.agent import Input, Session, run


# Temporary compatibility shim for LangGraph Platform runtimes that can call
# Runtime.patch_execution_info() before execution_info has been populated.
_orig_patch_execution_info = Runtime.patch_execution_info


def _safe_patch_execution_info(self: Runtime, **overrides: Any) -> Runtime:
    if getattr(self, "execution_info", None) is None:
        return self
    return _orig_patch_execution_info(self, **overrides)


Runtime.patch_execution_info = _safe_patch_execution_info


class GraphState(TypedDict, total=False):
    message: str
    session: dict[str, Any]
    output: dict[str, Any]


async def assistant_node(state: GraphState) -> GraphState:
    message = (state.get("message") or "").strip()
    session_dict = state.get("session") or {}

    if not message:
        out = {"answer": "Missing message.", "citations": []}
        return {"output": out}

    session = Session(**session_dict) if isinstance(session_dict, dict) else None
    result = await run(Input(message=message, session=session))
    out = result.model_dump()
    return {"output": out}


builder: StateGraph = StateGraph(GraphState)
builder.add_node("assistant", assistant_node)
builder.set_entry_point("assistant")
builder.add_edge("assistant", END)

graph = builder.compile()

