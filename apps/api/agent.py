from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any, Optional

from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import StructuredTool
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field

from .knowledge_index import KnowledgeHit, ensure_index, search_kb
from .ops_data import (
    CAMP_ENROLLMENTS,
    CAMPS,
    CLASS_ENROLLMENTS,
    CLASSES,
    PRODUCT_AVAILABILITY,
    catalog_item_by_sku,
    full_catalog,
)
from .weather import get_current_weather


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Session(BaseModel):
    gymName: Optional[str] = None
    timezone: Optional[str] = None
    userName: Optional[str] = None
    userGoals: Optional[str] = None


class Input(BaseModel):
    message: str = Field(min_length=1)
    session: Optional[Session] = None


class CartItemSuggestion(BaseModel):
    sku: str
    quantity: int = 1
    note: Optional[str] = None


class Output(BaseModel):
    answer: str
    citations: list[dict[str, str]] = Field(default_factory=list)
    opsFreshness: Optional[dict[str, Any]] = None
    weatherFreshness: Optional[dict[str, Any]] = None
    suggestedCartItems: Optional[list[CartItemSuggestion]] = None


class _Trace:
    def __init__(self) -> None:
        self.citations: list[dict[str, str]] = []
        self.ops_endpoints: set[str] = set()
        self.ops_as_of: Optional[str] = None
        self.weather_as_of: Optional[str] = None
        self.weather_location: Optional[str] = None


def build_system_prompt() -> str:
    return "\n".join(
        [
            "You are a helpful climbing gym assistant for a climbing gym.",
            "",
            "Rules:",
            "- Be accurate. If you don't know, say so.",
            "- Never invent class times, prices, or inventory.",
            "- When asked about real-time availability (in stock, spots left, open private coaching slots), call the ops tool.",
            "- Outdoor wall access and outdoor classes are weather-dependent. For any outdoor access/class question, call the weather tool and explain the result and safety implications.",
            "- If the user needs to sign a waiver (first visit, waiver questions), direct them to the online waiver page at /waiver. If they are under 18, a parent/guardian must sign.",
            "- When asked about policies, class descriptions, coach bios, or general FAQs, use the knowledge search tool (RAG).",
            "- If you use knowledge search, include a short 'Sources' list at the end with the sourceIds you relied on.",
            "- If you use ops, mention the as-of timestamp returned by the tool.",
            "- If you use weather, mention the as-of timestamp and location used by the tool.",
            "- If the user intent is to buy/book something, include a machine-readable cart suggestion at the end:",
            "  - Put `CartItemsJSON:` on its own line, followed by a JSON array of `{ sku, quantity, note? }`.",
            "  - Use real SKUs (use ops catalog tools if needed).",
            "",
            "Keep responses concise and actionable.",
        ]
    )


def build_session_prompt(session: Optional[Session]) -> str:
    gym_name = (session.gymName if session else None) or "Front Range Climbing (Boulder)"
    tz = (session.timezone if session else None) or "America/Denver"
    lines = [f"Gym: {gym_name}", f"Timezone: {tz}"]
    if session and session.userName:
        lines.append(f"UserName: {session.userName}")
    if session and session.userGoals:
        lines.append(f"UserGoals: {session.userGoals}")
    return "\n".join(lines)


def _extract_cart(answer: str) -> tuple[str, Optional[list[CartItemSuggestion]]]:
    marker = "\nCartItemsJSON:"
    idx = answer.rfind(marker)
    if idx == -1:
        return answer, None
    json_part = answer[idx + len(marker) :].strip()
    clean = answer[:idx].rstrip()
    try:
        parsed = json.loads(json_part)
        if not isinstance(parsed, list):
            return clean, None
        out: list[CartItemSuggestion] = []
        for it in parsed:
            if not isinstance(it, dict):
                continue
            sku = it.get("sku")
            qty = it.get("quantity", 1)
            note = it.get("note")
            if not isinstance(sku, str) or not sku:
                continue
            q = int(qty) if isinstance(qty, (int, float)) else 1
            out.append(CartItemSuggestion(sku=sku, quantity=max(1, q), note=note if isinstance(note, str) else None))
        return clean, out or None
    except Exception:
        return clean, None


def make_tools() -> tuple[list[StructuredTool], Any]:
    if not os.environ.get("OPENAI_API_KEY"):
        raise RuntimeError("Missing OPENAI_API_KEY")

    index = ensure_index()
    trace = _Trace()

    class KnowledgeSearchArgs(BaseModel):
        query: str = Field(min_length=1)
        k: Optional[int] = Field(default=4, ge=1, le=10)

    def knowledge_search(query: str, k: int = 4) -> str:
        tool_text, hits = search_kb(index, query, k=k)
        for h in hits:
            trace.citations.append({"sourceId": h.sourceId, "snippet": h.snippet})
        return tool_text

    knowledge_tool = StructuredTool.from_function(
        name="knowledge_search",
        description="Search the gym knowledge base (policies, hours, class descriptions, coach bios, rentals). Use this for FAQs and policy questions.",
        func=lambda query, k=4: knowledge_search(query=query, k=k),
        args_schema=KnowledgeSearchArgs,
    )

    class OpsCatalogSearchArgs(BaseModel):
        query: str = Field(min_length=1)
        limit: Optional[int] = Field(default=8, ge=1, le=20)

    def ops_search_catalog(query: str, limit: int = 8) -> str:
        trace.ops_endpoints.add("catalog/search")
        trace.ops_as_of = _now_iso()
        q = query.strip().lower()
        items = [
            it.__dict__
            for it in full_catalog()
            if q in f"{it.sku} {it.name} {it.category} {(it.description or '')}".lower()
        ][:limit]
        return json.dumps({"asOfISO": trace.ops_as_of, "endpoint": "catalog/search", "payload": items}, indent=2)

    ops_catalog_search_tool = StructuredTool.from_function(
        name="ops_search_catalog",
        description="Search purchasable catalog items by text query (use this to find SKUs).",
        func=lambda query, limit=8: ops_search_catalog(query=query, limit=limit),
        args_schema=OpsCatalogSearchArgs,
    )

    class OpsCatalogGetArgs(BaseModel):
        sku: str = Field(min_length=1)

    def ops_get_catalog_item(sku: str) -> str:
        trace.ops_endpoints.add("catalog/item")
        trace.ops_as_of = _now_iso()
        item = catalog_item_by_sku(sku)
        payload = item.__dict__ if item else None
        return json.dumps({"asOfISO": trace.ops_as_of, "endpoint": "catalog/item", "payload": payload}, indent=2)

    ops_catalog_get_tool = StructuredTool.from_function(
        name="ops_get_catalog_item",
        description="Get one catalog item by SKU.",
        func=lambda sku: ops_get_catalog_item(sku=sku),
        args_schema=OpsCatalogGetArgs,
    )

    class OpsProductAvailArgs(BaseModel):
        sku: str = Field(min_length=1)
        size: Optional[str] = None

    def ops_product_availability(sku: str, size: Optional[str] = None) -> str:
        trace.ops_endpoints.add("products/availability")
        trace.ops_as_of = _now_iso()
        match = None
        for p in PRODUCT_AVAILABILITY:
            if p.get("sku") != sku:
                continue
            if size is None and p.get("size") is None:
                match = p
                break
            if size is not None and p.get("size") == size:
                match = p
                break
        return json.dumps({"asOfISO": trace.ops_as_of, "endpoint": "products/availability", "payload": match}, indent=2)

    ops_product_tool = StructuredTool.from_function(
        name="ops_product_availability",
        description="Get real-time-ish product availability (inventory). Use for in-stock questions, especially rentals like shoes by size.",
        func=lambda sku, size=None: ops_product_availability(sku=sku, size=size),
        args_schema=OpsProductAvailArgs,
    )

    class OpsClassAvailArgs(BaseModel):
        classId: str = Field(min_length=1)

    def ops_class_availability(classId: str) -> str:
        trace.ops_endpoints.add("classes/availability")
        trace.ops_as_of = _now_iso()
        gym_class = next((c for c in CLASSES if c["id"] == classId), None)
        payload = None
        if gym_class:
            enrolled = int(CLASS_ENROLLMENTS.get(classId, 0))
            seats_left = max(0, int(gym_class["capacity"]) - enrolled)
            payload = {"classId": classId, "capacity": gym_class["capacity"], "enrolled": enrolled, "seatsLeft": seats_left}
        return json.dumps({"asOfISO": trace.ops_as_of, "endpoint": "classes/availability", "payload": payload}, indent=2)

    ops_class_tool = StructuredTool.from_function(
        name="ops_class_availability",
        description="Get real-time-ish class seat availability by classId.",
        func=lambda classId: ops_class_availability(classId=classId),
        args_schema=OpsClassAvailArgs,
    )

    class WeatherArgs(BaseModel):
        lat: Optional[float] = Field(default=None, ge=-90, le=90)
        lon: Optional[float] = Field(default=None, ge=-180, le=180)
        label: Optional[str] = None

    async def weather_current(lat: Optional[float] = None, lon: Optional[float] = None, label: Optional[str] = None) -> str:
        res = await get_current_weather(lat=lat, lon=lon, label=label)
        trace.weather_as_of = res.get("asOfISO")
        trace.weather_location = (res.get("location") or {}).get("label")
        return json.dumps(res, indent=2)

    weather_tool = StructuredTool.from_function(
        name="weather_current",
        description="Get current weather for outdoor wall decisions. Use for outdoor wall access and outdoor classes.",
        coroutine=weather_current,
        args_schema=WeatherArgs,
    )

    tools = [
        knowledge_tool,
        ops_catalog_search_tool,
        ops_catalog_get_tool,
        ops_product_tool,
        ops_class_tool,
        weather_tool,
    ]
    return tools, trace


async def run(input: Input) -> Output:
    tools, trace = make_tools()

    llm = ChatOpenAI(
        api_key=os.environ["OPENAI_API_KEY"],
        model=os.environ.get("OPENAI_MODEL", "gpt-5.2"),
        temperature=0.2,
    )

    model = llm.bind_tools(tools)
    tool_map = {t.name: t for t in tools}

    messages: list[Any] = [
        SystemMessage(content=build_system_prompt()),
        SystemMessage(content=build_session_prompt(input.session)),
        HumanMessage(content=input.message),
    ]

    raw = ""
    for _ in range(6):
        ai = await model.ainvoke(messages)
        messages.append(ai)
        tool_calls = getattr(ai, "tool_calls", None) or []
        if not tool_calls:
            raw = str(getattr(ai, "content", "") or "").strip()
            break

        for call in tool_calls:
            name = str(call.get("name", ""))
            call_id = str(call.get("id", ""))
            args = call.get("args", {})
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except Exception:
                    args = {}

            t = tool_map.get(name)
            if not t:
                messages.append(ToolMessage(tool_call_id=call_id, content=f"Unknown tool: {name}"))
                continue

            try:
                tool_result = await t.ainvoke(args if isinstance(args, dict) else {})
            except Exception as e:
                tool_result = f"Tool error: {e}"

            messages.append(
                ToolMessage(
                    tool_call_id=call_id,
                    content=tool_result if isinstance(tool_result, str) else json.dumps(tool_result),
                )
            )

    answer, suggested = _extract_cart(raw)

    ops_freshness = None
    if trace.ops_as_of and trace.ops_endpoints:
        ops_freshness = {"asOfISO": trace.ops_as_of, "endpoints": sorted(list(trace.ops_endpoints))}

    weather_freshness = None
    if trace.weather_as_of and trace.weather_location:
        weather_freshness = {"asOfISO": trace.weather_as_of, "locationLabel": trace.weather_location}

    return Output(
        answer=answer,
        citations=trace.citations,
        opsFreshness=ops_freshness,
        weatherFreshness=weather_freshness,
        suggestedCartItems=suggested,
    )

