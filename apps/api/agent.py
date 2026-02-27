from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import StructuredTool
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field

from .knowledge_index import KnowledgeHit, ensure_index, search_kb
from .mcp_tools import load_mcp_tools_from_env
from .ops_data import (
    CAMP_ENROLLMENTS,
    CAMPS,
    CLASS_ENROLLMENTS,
    CLASSES,
    PRODUCT_AVAILABILITY,
    catalog_item_by_sku,
    full_catalog,
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

_GYM_LAT = 40.015
_GYM_LON = -105.2705


def _format_usd(cents: int) -> str:
    return f"${cents/100:.2f}"


def _waiver_email(session: Optional["Session"]) -> str:
    if not session or not isinstance(session.waiver, dict):
        return ""
    v = session.waiver.get("participantEmail")
    return v.strip() if isinstance(v, str) else ""


def _waiver_participant(session: Optional["Session"]) -> str:
    if not session or not isinstance(session.waiver, dict):
        return ""
    v = session.waiver.get("participantName")
    return v.strip() if isinstance(v, str) else ""


def _is_minor(session: Optional["Session"]) -> Optional[bool]:
    if not session or not isinstance(session.waiver, dict):
        return None
    v = session.waiver.get("isMinor")
    return bool(v) if isinstance(v, bool) else None


def _safe_cart_lines(session: Optional["Session"]) -> list[dict[str, Any]]:
    if not session or not isinstance(session.cartLines, list):
        return []
    out: list[dict[str, Any]] = []
    for it in session.cartLines:
        if not isinstance(it, dict):
            continue
        sku = it.get("sku")
        qty = it.get("quantity", 1)
        if not isinstance(sku, str) or not sku.strip():
            continue
        q = int(qty) if isinstance(qty, (int, float)) else 1
        out.append({"sku": sku.strip(), "quantity": max(1, q)})
    return out


def _parse_iso_to_unix(iso: str) -> Optional[int]:
    try:
        dt = datetime.fromisoformat(iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp())
    except Exception:
        return None


async def _weather_hourly_forecast(lat: float, lon: float, hours: int = 48, units: str = "metric") -> Optional[dict[str, Any]]:
    mcp_tools = await load_mcp_tools_from_env()
    # Prefer the conventional prefixed name, but accept any server prefix.
    tool = next(
        (
            t
            for t in mcp_tools
            if isinstance(getattr(t, "name", None), str)
            and (t.name == "weather_weather_forecast_hourly" or t.name.endswith("_weather_forecast_hourly"))
        ),
        None,
    )
    if not tool:
        return None
    try:
        raw = await tool.ainvoke({"lat": lat, "lon": lon, "hours": hours, "units": units})
        txt = raw if isinstance(raw, str) else json.dumps(raw)
        return json.loads(txt) if isinstance(txt, str) else None
    except Exception:
        return None


def _pick_hour(hourly: list[dict[str, Any]], target_unix: int) -> Optional[dict[str, Any]]:
    best = None
    best_delta = None
    for h in hourly:
        if not isinstance(h, dict):
            continue
        dt = h.get("dt")
        if not isinstance(dt, int):
            continue
        d = abs(dt - target_unix)
        if best_delta is None or d < best_delta:
            best = h
            best_delta = d
    return best


async def _send_email_via_sendgrid(to_email: str, subject: str, text: str) -> tuple[bool, str]:
    to_email = (to_email or "").strip()
    if not to_email:
        return False, "missing recipient email"

    mcp_tools = await load_mcp_tools_from_env()
    tool = next((t for t in mcp_tools if getattr(t, "name", "") == "sendgrid_sendEmail"), None)
    if not tool:
        return False, "sendgrid_sendEmail tool not available (MCP not configured or allowlist blocked it)"

    try:
        await tool.ainvoke({"to": to_email, "subject": subject, "text": text})
        return True, ""
    except Exception as e:
        return False, str(e)


async def _handle_checkout(session: Optional["Session"]) -> "Output":
    cart_lines = _safe_cart_lines(session)
    if not cart_lines:
        return Output(
            answer="Cart is empty.",
            citations=[],
        )

    email = _waiver_email(session)
    participant = _waiver_participant(session) or "Guest"

    line_texts: list[str] = []
    subtotal = 0
    for l in cart_lines:
        sku = str(l.get("sku"))
        qty = int(l.get("quantity", 1))
        item = catalog_item_by_sku(sku)
        if not item:
            line_texts.append(f"- {sku} x{qty} (unknown item)")
            continue
        line_total = int(item.priceCents) * qty
        subtotal += line_total
        line_texts.append(f"- {item.name} ({sku}) x{qty}: {_format_usd(line_total)}")

    receipt = "\n".join(
        [
            f"Receipt for {participant}",
            "",
            *line_texts,
            "",
            f"Total: {_format_usd(subtotal)}",
            f"As of: {_now_iso()}",
        ]
    )

    emailed = False
    email_err = ""
    if email:
        emailed, email_err = await _send_email_via_sendgrid(
            to_email=email,
            subject="Your Climb Gym Copilot receipt",
            text=receipt,
        )

    msg = f"Checkout complete. Total: {_format_usd(subtotal)}."
    if email:
        msg += f" Receipt email {'sent' if emailed else 'failed'} to {email}."
        if email_err and not emailed:
            msg += f" ({email_err})"
    else:
        msg += " No email on file (complete a waiver to add email)."

    return Output(
        answer=msg,
        citations=[],
        cartActions=[{"op": "clear"}],
        uiActions=[{"type": "navigate", "to": "/cart", "reason": "checkout complete"}],
    )


async def _handle_reserve_class(session: Optional["Session"], class_id: str) -> "Output":
    class_id = (class_id or "").strip()
    if not class_id:
        return Output(answer="Missing classId.", citations=[])

    participant_email = _waiver_email(session)
    participant_name = _waiver_participant(session)

    # Reuse the same reservation logic as the tool.
    # (This path avoids LLM variability and returns structured reservation details.)
    gym_class = next((c for c in CLASSES if c["id"] == class_id), None)
    if not gym_class:
        return Output(answer="Unknown classId.", citations=[])

    enrolled = int(CLASS_ENROLLMENTS.get(class_id, 0))
    capacity = int(gym_class.get("capacity", 0) or 0)
    seats_left = max(0, capacity - enrolled)
    if seats_left <= 0:
        return Output(answer="No seats left for that class.", citations=[])

    CLASS_ENROLLMENTS[class_id] = enrolled + 1
    reservation_id = f"res_{uuid.uuid4().hex[:12]}"

    emailed = False
    email_err = ""
    if participant_email:
        subject = f"Class reservation confirmed: {gym_class.get('title')}"
        body = "\n".join(
            [
                "Your class reservation is confirmed.",
                f"ReservationId: {reservation_id}",
                f"Class: {gym_class.get('title')} ({class_id})",
                f"Start: {gym_class.get('startTimeISO')}",
                f"DurationMinutes: {gym_class.get('durationMinutes')}",
                f"As of: {_now_iso()}",
            ]
        )
        emailed, email_err = await _send_email_via_sendgrid(
            to_email=participant_email,
            subject=subject,
            text=body,
        )

    answer = f"Reserved: {gym_class.get('title')} at {gym_class.get('startTimeISO')}."
    if participant_email:
        answer += f" Email {'sent' if emailed else 'failed'} to {participant_email}."
        if email_err and not emailed:
            answer += f" ({email_err})"

    return Output(
        answer=answer,
        citations=[],
        uiActions=[{"type": "navigate", "to": "/calendar", "reason": "reservation complete"}],
        reservation={
            "reservationId": reservation_id,
            "classId": class_id,
            "title": str(gym_class.get("title") or ""),
            "startTimeISO": str(gym_class.get("startTimeISO") or ""),
            "emailSent": emailed,
            "emailError": email_err or None,
        },
    )


class Session(BaseModel):
    gymName: Optional[str] = None
    timezone: Optional[str] = None
    userName: Optional[str] = None
    userGoals: Optional[str] = None
    cartLines: Optional[list[dict[str, Any]]] = None
    waiver: Optional[dict[str, Any]] = None


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
    cartActions: Optional[list[dict[str, Any]]] = None
    uiActions: Optional[list[dict[str, Any]]] = None
    reservation: Optional[dict[str, Any]] = None


class _Trace:
    def __init__(self) -> None:
        self.citations: list[dict[str, str]] = []
        self.ops_endpoints: set[str] = set()
        self.ops_as_of: Optional[str] = None


def build_system_prompt() -> str:
    return "\n".join(
        [
            "You are a helpful climbing gym assistant for a climbing gym.",
            "",
            "Rules:",
            "- Be accurate. If you don't know, say so.",
            "- Never invent class times, prices, or inventory.",
            "- When asked about real-time availability (in stock, spots left, open private coaching slots), call the ops tool.",
            "- Outdoor wall access and outdoor classes are weather-dependent. For any outdoor access/class question, call the weather FORECAST tools (MCP) and explain the result and safety implications.",
            "- For scheduling/booking (classes, camps, private coaching), use the calendar/scheduling tools when available.",
            "- For confirmations and reminders, use the messaging/notifications tools when available.",
            "- For future outdoor planning, prefer a forecast tool when available (not just current conditions).",
            "- For class reservations, search classes then reserve seats via the ops reservation tool, then send a confirmation email when possible.",
            "- For checkout, provide a concise receipt and send an email receipt when possible.",
            "- If discussing a specific outdoor class that is scheduled in the future, include forecast context for that class time when possible.",
            "- If the user needs to sign a waiver (first visit, waiver questions), direct them to the online waiver page at /waiver. If they are under 18, a parent/guardian must sign.",
            "- When asked about policies, class descriptions, coach bios, or general FAQs, use the knowledge search tool (RAG).",
            "- If you use knowledge search, include a short 'Sources' list at the end with the sourceIds you relied on.",
            "- If you use ops, mention the as-of timestamp returned by the tool.",
            "- If you use weather, mention the as-of timestamp and location used by the tool output.",
            "- If the user intent is to buy/book something, include a machine-readable cart suggestion at the end:",
            "  - Put `CartItemsJSON:` on its own line, followed by a JSON array of `{ sku, quantity, note? }`.",
            "  - Use real SKUs (use ops catalog tools if needed).",
            "- For web UI automation, you MAY also include these machine-readable directives at the very end (each on its own line):",
            "  - `CartActionsJSON:` followed by a JSON array of `{ op: \"add\"|\"remove\"|\"clear\", sku?, quantity?, note? }`.",
            "  - `UIActionsJSON:` followed by a JSON array of `{ type: \"navigate\", to: \"/waiver\"|\"/cart\"|\"/shop\"|\"/chat\", reason? }`.",
            "- If a waiver must be signed before proceeding, include a UI action to navigate to `/waiver`.",
            "- If you add/remove items via CartActionsJSON, include a UI action to navigate to `/cart`.",
            "",
            "Keep responses concise and actionable.",
        ]
    )


def build_session_prompt(session: Optional[Session]) -> str:
    gym_name = (session.gymName if session else None) or "Front Range Climbing (Boulder)"
    tz = (session.timezone if session else None) or "America/Denver"
    lines = [f"Gym: {gym_name}", f"Timezone: {tz}"]
    # Default gym coordinates (Boulder, CO) for weather MCP calls.
    lines.append("GymLatLon: 40.015, -105.2705")
    if session and session.userName:
        lines.append(f"UserName: {session.userName}")
    if session and session.userGoals:
        lines.append(f"UserGoals: {session.userGoals}")
    if session and session.waiver and isinstance(session.waiver, dict) and session.waiver.get("id"):
        email = session.waiver.get("participantEmail")
        lines.append(
            f"WaiverOnFile: yes (id={session.waiver.get('id')}, participant={session.waiver.get('participantName')}, email={email}, minor={session.waiver.get('isMinor')})"
        )
    else:
        lines.append("WaiverOnFile: unknown")
    if session and session.cartLines and isinstance(session.cartLines, list) and len(session.cartLines) > 0:
        parts: list[str] = []
        for it in session.cartLines[:25]:
            if not isinstance(it, dict):
                continue
            sku = it.get("sku")
            qty = it.get("quantity")
            if isinstance(sku, str):
                parts.append(f"{sku} x{qty}")
        lines.append("Cart: " + ", ".join(parts) if parts else "Cart: empty")
    else:
        lines.append("Cart: empty")
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


def _extract_json_line(text: str, marker: str) -> tuple[str, Any | None]:
    needle = "\n" + marker
    idx = text.rfind(needle)
    if idx == -1:
        return text, None
    json_part = text[idx + len(needle) :].strip()
    clean = text[:idx].rstrip()
    try:
        return clean, json.loads(json_part)
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

    class OpsClassSearchArgs(BaseModel):
        query: str = Field(min_length=1)
        limit: Optional[int] = Field(default=8, ge=1, le=20)

    async def ops_search_classes(query: str, limit: int = 8) -> str:
        trace.ops_endpoints.add("classes/search")
        trace.ops_as_of = _now_iso()
        q = query.strip().lower()

        # If query is too generic (e.g. "tomorrow classes"), return upcoming classes.
        broad = any(k in q for k in ["tomorrow", "today", "upcoming", "next", "classes"]) or len(q) < 4

        # Fetch hourly forecast once so we can attach to outdoor classes.
        forecast = await _weather_hourly_forecast(_GYM_LAT, _GYM_LON, hours=48, units="metric")
        hourly = []
        if isinstance(forecast, dict) and isinstance(forecast.get("hourly"), list):
            hourly = [x for x in forecast["hourly"] if isinstance(x, dict)]

        items: list[dict[str, Any]] = []
        for c in CLASSES:
            title = str(c.get("title", ""))
            cid = str(c.get("id", ""))
            if not broad and q not in f"{cid} {title}".lower():
                continue
            is_outdoor = "outdoor" in cid.lower() or "outdoor" in title.lower()
            out = {**c, "isOutdoor": is_outdoor}
            if is_outdoor and hourly:
                start_iso = str(c.get("startTimeISO") or "")
                t = _parse_iso_to_unix(start_iso) if start_iso else None
                if isinstance(t, int):
                    h = _pick_hour(hourly, t)
                    if h:
                        out["weatherForecast"] = {
                            "approxForUnixUTC": t,
                            "temp": h.get("temp"),
                            "wind_speed": h.get("wind_speed"),
                            "wind_gust": h.get("wind_gust"),
                            "pop": h.get("pop"),
                            "weather": h.get("weather"),
                            "sourceTool": "weather_forecast_hourly",
                        }
            items.append(out)

        # Sort by time for broad searches.
        def _sort_key(x: dict[str, Any]) -> int:
            t = x.get("startTimeISO")
            if isinstance(t, str):
                u = _parse_iso_to_unix(t)
                return u if isinstance(u, int) else 0
            return 0

        if broad:
            items.sort(key=_sort_key)

        return json.dumps(
            {
                "asOfISO": trace.ops_as_of,
                "endpoint": "classes/search",
                "note": "For any class with isOutdoor=true, include weatherForecast details in your response.",
                "payload": items[:limit],
            },
            indent=2,
        )

    ops_class_search_tool = StructuredTool.from_function(
        name="ops_search_classes",
        description="Search classes by text query (returns classId, title, startTimeISO, capacity, isOutdoor). Use this to find classIds for reservations.",
        coroutine=ops_search_classes,
        args_schema=OpsClassSearchArgs,
    )

    class OpsReserveClassArgs(BaseModel):
        classId: str = Field(min_length=1)
        participantEmail: Optional[str] = None
        participantName: Optional[str] = None

    async def ops_reserve_class(classId: str, participantEmail: Optional[str] = None, participantName: Optional[str] = None) -> str:
        trace.ops_endpoints.add("classes/reserve")
        trace.ops_as_of = _now_iso()
        gym_class = next((c for c in CLASSES if c["id"] == classId), None)
        if not gym_class:
            return json.dumps({"asOfISO": trace.ops_as_of, "endpoint": "classes/reserve", "error": "Unknown classId"}, indent=2)

        enrolled = int(CLASS_ENROLLMENTS.get(classId, 0))
        capacity = int(gym_class.get("capacity", 0) or 0)
        seats_left = max(0, capacity - enrolled)
        if seats_left <= 0:
            return json.dumps(
                {
                    "asOfISO": trace.ops_as_of,
                    "endpoint": "classes/reserve",
                    "error": "No seats left",
                    "payload": {"classId": classId, "capacity": capacity, "enrolled": enrolled, "seatsLeft": seats_left},
                },
                indent=2,
            )

        CLASS_ENROLLMENTS[classId] = enrolled + 1
        next_seats_left = max(0, capacity - (enrolled + 1))
        reservation_id = f"res_{uuid.uuid4().hex[:12]}"

        emailed = False
        email_err = ""
        to_email = participantEmail.strip() if isinstance(participantEmail, str) else ""
        if to_email:
            subject = f"Class reservation confirmed: {gym_class.get('title')}"
            body = "\n".join(
                [
                    "Your class reservation is confirmed.",
                    f"ReservationId: {reservation_id}",
                    f"Class: {gym_class.get('title')} ({classId})",
                    f"Start: {gym_class.get('startTimeISO')}",
                    f"DurationMinutes: {gym_class.get('durationMinutes')}",
                    f"As of: {trace.ops_as_of}",
                ]
            )
            emailed, email_err = await _send_email_via_sendgrid(to_email=to_email, subject=subject, text=body)

        payload = {
            "reservationId": reservation_id,
            "class": gym_class,
            "seatsLeft": next_seats_left,
            "participantEmail": to_email or None,
            "participantName": participantName.strip() if isinstance(participantName, str) and participantName.strip() else None,
            "emailSent": emailed,
            "emailError": email_err or None,
        }
        return json.dumps({"asOfISO": trace.ops_as_of, "endpoint": "classes/reserve", "payload": payload}, indent=2)

    ops_reserve_class_tool = StructuredTool.from_function(
        name="ops_reserve_class",
        description="Reserve a seat in a class by classId. Include participantEmail to send a confirmation email via messaging tools when available.",
        coroutine=ops_reserve_class,
        args_schema=OpsReserveClassArgs,
    )

    tools = [
        knowledge_tool,
        ops_catalog_search_tool,
        ops_catalog_get_tool,
        ops_product_tool,
        ops_class_search_tool,
        ops_class_tool,
        ops_reserve_class_tool,
    ]
    return tools, trace


async def run(input: Input) -> Output:
    if input.message.strip() == "__CHECKOUT__":
        return await _handle_checkout(input.session)
    if input.message.strip().startswith("__RESERVE_CLASS__:"):
        class_id = input.message.strip().split(":", 1)[1].strip()
        return await _handle_reserve_class(input.session, class_id)

    tools, trace = make_tools()
    mcp_tools = await load_mcp_tools_from_env()
    all_tools = tools + mcp_tools

    llm = ChatOpenAI(
        api_key=os.environ["OPENAI_API_KEY"],
        model=os.environ.get("OPENAI_MODEL", "gpt-5.2"),
        temperature=0.2,
    )

    model = llm.bind_tools(all_tools)
    tool_map = {t.name: t for t in all_tools}

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

    # Extract optional UI/cart directives (order: UI, cart actions, legacy cart items)
    txt, ui_actions = _extract_json_line(raw, "UIActionsJSON:")
    txt, cart_actions = _extract_json_line(txt, "CartActionsJSON:")
    answer, suggested = _extract_cart(txt)

    ops_freshness = None
    if trace.ops_as_of and trace.ops_endpoints:
        ops_freshness = {"asOfISO": trace.ops_as_of, "endpoints": sorted(list(trace.ops_endpoints))}

    weather_freshness = None

    return Output(
        answer=answer,
        citations=trace.citations,
        opsFreshness=ops_freshness,
        weatherFreshness=weather_freshness,
        suggestedCartItems=suggested,
        cartActions=cart_actions if isinstance(cart_actions, list) else None,
        uiActions=ui_actions if isinstance(ui_actions, list) else None,
    )

