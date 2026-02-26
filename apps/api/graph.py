from __future__ import annotations

from typing import Any, TypedDict, Optional

from langchain_core.messages import AIMessage, BaseMessage
from langgraph.graph import END, StateGraph

from apps.api.agent import Input, Session, run




class GraphState(TypedDict, total=False):
    message: str
    session: dict[str, Any]
    output: dict[str, Any]
    messages: list[BaseMessage]


async def assistant_node(state: GraphState) -> GraphState:
    message = (state.get("message") or "").strip()
    session_dict = state.get("session") or {}

    if not message:
        out = {"answer": "Missing message.", "citations": []}
        return {"output": out, "messages": [AIMessage(content=out["answer"])]}

    session = Session(**session_dict) if isinstance(session_dict, dict) else None
    result = await run(Input(message=message, session=session))
    out = result.model_dump()
    return {"output": out, "messages": [AIMessage(content=out.get("answer", ""))]}


builder: StateGraph = StateGraph(GraphState)
builder.add_node("assistant", assistant_node)
builder.set_entry_point("assistant")
builder.add_edge("assistant", END)

graph = builder.compile()

