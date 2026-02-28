from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo
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


def _waiver_account_address(session: Optional["Session"]) -> str:
    if not session or not isinstance(session.waiver, dict):
        return ""
    v = session.waiver.get("accountAddress")
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


def _day_window_utc_from_local_date(date_iso: str, tz_name: str) -> tuple[str, str]:
    tz = ZoneInfo(tz_name or "UTC")
    d = datetime.fromisoformat(date_iso).date()
    start_local = datetime(d.year, d.month, d.day, 0, 0, 0, tzinfo=tz)
    end_local = start_local + timedelta(days=1) - timedelta(milliseconds=1)
    start_utc = start_local.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    end_utc = end_local.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return start_utc, end_utc


def _tomorrow_date_iso(tz_name: str) -> str:
    tz = ZoneInfo(tz_name or "UTC")
    now_local = datetime.now(tz=tz)
    return (now_local.date() + timedelta(days=1)).isoformat()


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


async def _weather_daily_forecast(lat: float, lon: float, days: int = 8, units: str = "metric") -> Optional[dict[str, Any]]:
    mcp_tools = await load_mcp_tools_from_env()
    tool = next(
        (
            t
            for t in mcp_tools
            if isinstance(getattr(t, "name", None), str)
            and (t.name == "weather_weather_forecast_daily" or t.name.endswith("_weather_forecast_daily"))
        ),
        None,
    )
    if not tool:
        return None
    try:
        raw = await tool.ainvoke({"lat": lat, "lon": lon, "days": days, "units": units})
        txt = raw if isinstance(raw, str) else json.dumps(raw)
        return json.loads(txt) if isinstance(txt, str) else None
    except Exception:
        return None


async def _scheduling_call_json(tool_suffix: str, args: dict[str, Any]) -> Optional[dict[str, Any]]:
    mcp_tools = await load_mcp_tools_from_env()
    tool = next(
        (
            t
            for t in mcp_tools
            if isinstance(getattr(t, "name", None), str)
            and (
                t.name == f"scheduling_{tool_suffix}"
                or t.name.endswith(f"_{tool_suffix}")
                or t.name == tool_suffix
            )
        ),
        None,
    )
    if not tool:
        return None
    try:
        raw = await tool.ainvoke(args if isinstance(args, dict) else {})
        txt = raw if isinstance(raw, str) else json.dumps(raw)
        return json.loads(txt) if isinstance(txt, str) else None
    except Exception:
        return None


async def _core_call_json(tool_suffix: str, args: dict[str, Any]) -> Optional[dict[str, Any]]:
    mcp_tools = await load_mcp_tools_from_env()
    tool = next(
        (
            t
            for t in mcp_tools
            if isinstance(getattr(t, "name", None), str)
            and (
                t.name == f"core_{tool_suffix}"
                or t.name.endswith(f"_{tool_suffix}")
                or t.name == tool_suffix
            )
        ),
        None,
    )
    if not tool:
        return None
    try:
        raw = await tool.ainvoke(args if isinstance(args, dict) else {})
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

    account_address = _waiver_account_address(session)
    participant_email = _waiver_email(session)
    participant_name = _waiver_participant(session)

    if not account_address:
        return Output(
            answer="Reservation requires a saved waiver with accountAddress (canonical).",
            citations=[],
            uiActions=[{"type": "navigate", "to": "/waiver", "reason": "need canonical account address for reservation"}],
        )

    cls_resp = await _scheduling_call_json("schedule_get_class", {"classId": class_id})
    cls = cls_resp.get("gymClass") if isinstance(cls_resp, dict) else None
    if not isinstance(cls, dict):
        return Output(answer="Unknown classId (not found in scheduling).", citations=[])

    reserve_resp = await _scheduling_call_json(
        "schedule_reserve_seat",
        {
            "classId": class_id,
            "customerAccountAddress": account_address,
        },
    )
    reservation_obj = reserve_resp.get("reservation") if isinstance(reserve_resp, dict) else None
    if not isinstance(reservation_obj, dict):
        err = reserve_resp.get("error") if isinstance(reserve_resp, dict) else None
        return Output(answer=str(err or "Reservation failed."), citations=[])

    reservation_id = str(reservation_obj.get("reservationId") or "")

    # Record canonical customer + reservation ledger in gym-core (best effort).
    class_def_id = str(cls.get("classDefId") or "").strip()
    await _core_call_json(
        "core_upsert_customer",
        {
            "canonicalAddress": account_address,
            "displayName": participant_name or None,
            "email": participant_email or None,
        },
    )
    await _core_call_json(
        "core_record_reservation",
        {
            "canonicalAddress": account_address,
            "schedulerClassId": class_id,
            "schedulerReservationId": reservation_id,
            "classDefId": class_def_id or None,
            "status": "active",
        },
    )

    emailed = False
    email_err = ""
    subject = f"Class reservation confirmed: {cls.get('title')}"
    body = "\n".join(
        [
            "Your class reservation is confirmed.",
            f"ReservationId: {reservation_id}",
            f"Class: {cls.get('title')} ({class_id})",
            f"Start: {cls.get('startTimeISO')}",
            f"DurationMinutes: {cls.get('durationMinutes')}",
            f"As of: {_now_iso()}",
        ]
    )
    if participant_email:
        emailed, email_err = await _send_email_via_sendgrid(
            to_email=participant_email,
            subject=subject,
            text=body,
        )

    answer = f"Reserved: {cls.get('title')} at {cls.get('startTimeISO')}."
    if participant_email:
        answer += f" Email {'sent' if emailed else 'failed'} to {participant_email}."
        if email_err and not emailed:
            answer += f" ({email_err})"
    else:
        answer += " No email on file (waiver participantEmail missing)."

    return Output(
        answer=answer,
        citations=[],
        uiActions=[{"type": "navigate", "to": "/calendar", "reason": "reservation complete"}],
        reservation={
            "reservationId": reservation_id,
            "classId": class_id,
            "title": str(cls.get("title") or ""),
            "startTimeISO": str(cls.get("startTimeISO") or ""),
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
    data: Optional[dict[str, Any]] = None
    schedule: Optional[dict[str, Any]] = None


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
            "- For class reservations, reserve seats via the scheduling MCP using canonical account addresses, record a reservation ledger entry in gym-core, then send a confirmation email when possible.",
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
            "  - `UIActionsJSON:` followed by a JSON array of `{ type: \"navigate\", to: \"/waiver\"|\"/cart\"|\"/shop\"|\"/chat\"|\"/calendar\", reason? }`.",
            "- If a waiver must be signed before proceeding, include a UI action to navigate to `/waiver`.",
            "- If you add/remove items via CartActionsJSON, include a UI action to navigate to `/cart`.",
            "- If the user asks to view the class schedule or calendar, include a UI action to navigate to `/calendar`.",
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
        addr = session.waiver.get("accountAddress")
        lines.append(
            f"WaiverOnFile: yes (id={session.waiver.get('id')}, accountAddress={addr}, participant={session.waiver.get('participantName')}, email={email}, minor={session.waiver.get('isMinor')})"
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

    async def ops_class_availability(classId: str) -> str:
        trace.ops_endpoints.add("classes/availability")
        trace.ops_as_of = _now_iso()
        payload = None
        resp = await _scheduling_call_json("schedule_class_availability", {"classId": classId})
        if isinstance(resp, dict) and isinstance(resp.get("capacity"), (int, float)):
            capacity = int(resp.get("capacity") or 0)
            reserved = int(resp.get("reserved") or 0)
            seats_left = int(resp.get("seatsLeft") or max(0, capacity - reserved))
            payload = {"classId": classId, "capacity": capacity, "enrolled": reserved, "seatsLeft": seats_left}
        return json.dumps({"asOfISO": trace.ops_as_of, "endpoint": "classes/availability", "payload": payload}, indent=2)

    ops_class_tool = StructuredTool.from_function(
        name="ops_class_availability",
        description="Get real-time-ish class seat availability by classId.",
        coroutine=ops_class_availability,
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

        # Pull classes from scheduling MCP (D1-backed) for a reasonable window.
        now = datetime.now(timezone.utc)
        from_iso = None
        to_iso = None
        if "today" in q:
            d = now.date()
            from_iso = datetime(d.year, d.month, d.day, 0, 0, 0, tzinfo=timezone.utc).isoformat()
            to_iso = datetime(d.year, d.month, d.day, 23, 59, 59, tzinfo=timezone.utc).isoformat()
        elif "tomorrow" in q:
            d = (now + timedelta(days=1)).date()
            from_iso = datetime(d.year, d.month, d.day, 0, 0, 0, tzinfo=timezone.utc).isoformat()
            to_iso = datetime(d.year, d.month, d.day, 23, 59, 59, tzinfo=timezone.utc).isoformat()
        else:
            from_iso = now.isoformat()
            to_iso = (now + timedelta(days=7)).isoformat()

        sched = await _scheduling_call_json(
            "schedule_list_classes",
            {"fromISO": from_iso, "toISO": to_iso},
        )
        sched_items = []
        if isinstance(sched, dict) and isinstance(sched.get("classes"), list):
            sched_items = [x for x in sched["classes"] if isinstance(x, dict)]

        # Fetch hourly forecast once so we can attach to outdoor classes.
        forecast = await _weather_hourly_forecast(_GYM_LAT, _GYM_LON, hours=48, units="metric")
        hourly = []
        if isinstance(forecast, dict) and isinstance(forecast.get("hourly"), list):
            hourly = [x for x in forecast["hourly"] if isinstance(x, dict)]

        items: list[dict[str, Any]] = []
        for c in sched_items:
            title = str(c.get("title", ""))
            cid = str(c.get("classId", ""))
            if not cid or not title:
                continue
            if not broad and q not in f"{cid} {title}".lower():
                continue
            is_outdoor = bool(c.get("isOutdoor")) or ("outdoor" in cid.lower() or "outdoor" in title.lower())
            out = {
                "id": cid,
                "title": title,
                "type": c.get("type"),
                "skillLevel": c.get("skillLevel") or "beginner",
                "coachId": c.get("instructorAccountAddress") or c.get("instructorId") or "",
                "startTimeISO": c.get("startTimeISO"),
                "durationMinutes": c.get("durationMinutes"),
                "capacity": c.get("capacity"),
                "isOutdoor": is_outdoor,
            }
            if is_outdoor and hourly:
                start_iso = str(out.get("startTimeISO") or "")
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
        accountAddress: str = Field(min_length=3)
        participantEmail: Optional[str] = None
        participantName: Optional[str] = None

    async def ops_reserve_class(
        classId: str,
        accountAddress: str,
        participantEmail: Optional[str] = None,
        participantName: Optional[str] = None,
    ) -> str:
        trace.ops_endpoints.add("classes/reserve")
        trace.ops_as_of = _now_iso()
        addr = accountAddress.strip() if isinstance(accountAddress, str) else ""
        if not addr:
            return json.dumps({"asOfISO": trace.ops_as_of, "endpoint": "classes/reserve", "error": "Missing accountAddress"}, indent=2)
        to_email = participantEmail.strip() if isinstance(participantEmail, str) else ""

        cls_resp = await _scheduling_call_json("schedule_get_class", {"classId": classId})
        gym_class = cls_resp.get("gymClass") if isinstance(cls_resp, dict) else None
        if not isinstance(gym_class, dict):
            return json.dumps({"asOfISO": trace.ops_as_of, "endpoint": "classes/reserve", "error": "Unknown classId"}, indent=2)

        reserve_resp = await _scheduling_call_json(
            "schedule_reserve_seat",
            {"classId": classId, "customerAccountAddress": addr},
        )
        reservation_obj = reserve_resp.get("reservation") if isinstance(reserve_resp, dict) else None
        if not isinstance(reservation_obj, dict):
            err = reserve_resp.get("error") if isinstance(reserve_resp, dict) else None
            return json.dumps({"asOfISO": trace.ops_as_of, "endpoint": "classes/reserve", "error": str(err or "Reserve failed")}, indent=2)

        reservation_id = str(reservation_obj.get("reservationId") or "")

        class_def_id = str(gym_class.get("classDefId") or "").strip()
        await _core_call_json(
            "core_upsert_customer",
            {"canonicalAddress": addr, "displayName": participantName or None, "email": to_email or None},
        )
        await _core_call_json(
            "core_record_reservation",
            {
                "canonicalAddress": addr,
                "schedulerClassId": classId,
                "schedulerReservationId": reservation_id,
                "classDefId": class_def_id or None,
                "status": "active",
            },
        )

        emailed = False
        email_err = ""
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
            "accountAddress": addr,
            "participantEmail": to_email or None,
            "participantName": participantName.strip() if isinstance(participantName, str) and participantName.strip() else None,
            "emailSent": emailed,
            "emailError": email_err or None,
        }
        return json.dumps({"asOfISO": trace.ops_as_of, "endpoint": "classes/reserve", "payload": payload}, indent=2)

    ops_reserve_class_tool = StructuredTool.from_function(
        name="ops_reserve_class",
        description="Reserve a seat in a class by classId using canonical account address. Include participantEmail to send a confirmation email when available.",
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
    msg = input.message.strip()
    mlow = msg.lower()

    # Deterministic helper: avoid "query=tomorrow" text searches returning empty.
    if (
        not msg.startswith("__")
        and ("tomorrow" in mlow)
        and ("class" in mlow or "classes" in mlow or "schedule" in mlow)
    ):
        tz_name = (input.session.timezone if input.session and input.session.timezone else None) or "America/Denver"
        date_iso = _tomorrow_date_iso(tz_name)
        from_iso, to_iso = _day_window_utc_from_local_date(date_iso, tz_name)
        sched = await _scheduling_call_json("schedule_list_classes", {"fromISO": from_iso, "toISO": to_iso})
        classes = sched.get("classes") if isinstance(sched, dict) else []
        items = [c for c in classes if isinstance(c, dict)] if isinstance(classes, list) else []
        if not items:
            return Output(
                answer=f"No classes found for {date_iso}.",
                citations=[],
                uiActions=[{"type": "navigate", "to": "/calendar", "reason": "view schedule"}],
                data={"asOfISO": _now_iso(), "dateISO": date_iso, "fromISO": from_iso, "toISO": to_iso, "classes": []},
            )
        lines = []
        for c in items[:10]:
            lines.append(f"- {c.get('startTimeISO')} • {c.get('title')} ({c.get('classId')})")
        return Output(
            answer="Tomorrow's classes:\n" + "\n".join(lines),
            citations=[],
            uiActions=[{"type": "navigate", "to": "/calendar", "reason": "view schedule"}],
            data={"asOfISO": _now_iso(), "dateISO": date_iso, "fromISO": from_iso, "toISO": to_iso, "classes": items},
        )

    if msg.startswith("__WEATHER_HOURLY__:"):
        try:
            payload = json.loads(msg.split(":", 1)[1].strip())
        except Exception:
            payload = {}
        lat = float(payload.get("lat", _GYM_LAT)) if isinstance(payload, dict) else _GYM_LAT
        lon = float(payload.get("lon", _GYM_LON)) if isinstance(payload, dict) else _GYM_LON
        hours = int(payload.get("hours", 48)) if isinstance(payload, dict) else 48
        units = str(payload.get("units", "metric")) if isinstance(payload, dict) else "metric"
        out = await _weather_hourly_forecast(lat, lon, hours=hours, units=units)
        return Output(answer="", citations=[], data=out or {})

    if msg.startswith("__SCHED_CLASS_AVAIL__:"):
        try:
            payload = json.loads(msg.split(":", 1)[1].strip())
        except Exception:
            payload = {}
        class_id = str(payload.get("classId", "")).strip() if isinstance(payload, dict) else ""
        out = await _scheduling_call_json("schedule_class_availability", {"classId": class_id}) if class_id else None
        return Output(answer="", citations=[], data=out or {"error": "Missing classId"})

    if msg.startswith("__SCHED_INSTRUCTORS_SEARCH__:"):
        try:
            payload = json.loads(msg.split(":", 1)[1].strip())
        except Exception:
            payload = {}
        skill = str(payload.get("skill", "")).strip() if isinstance(payload, dict) else ""
        out = await _core_call_json("core_list_instructors", {})
        instructors = out.get("instructors") if isinstance(out, dict) else None
        data = []
        if isinstance(instructors, list):
            q = skill.lower()
            for it in instructors:
                if not isinstance(it, dict):
                    continue
                skills = it.get("skills")
                if not q:
                    data.append(it)
                elif isinstance(skills, list) and any(isinstance(s, str) and q in s.lower() for s in skills):
                    data.append(it)
        return Output(answer="", citations=[], data={"asOfISO": _now_iso(), "data": data})

    if msg.startswith("__SCHED_CLASSES_SEARCH__:"):
        try:
            payload = json.loads(msg.split(":", 1)[1].strip())
        except Exception:
            payload = {}
        date_iso = str(payload.get("dateISO") or "").strip() if isinstance(payload, dict) else ""
        skill_level = payload.get("skillLevel") if isinstance(payload, dict) else None
        class_type = payload.get("type") if isinstance(payload, dict) else None
        from_iso = f"{date_iso}T00:00:00.000Z" if date_iso else None
        to_iso = f"{date_iso}T23:59:59.999Z" if date_iso else None
        out = await _scheduling_call_json("schedule_list_classes", {"fromISO": from_iso, "toISO": to_iso, "type": class_type})
        classes = out.get("classes") if isinstance(out, dict) else None
        core_defs = await _core_call_json("core_list_class_definitions", {}) or {}
        defs_list = core_defs.get("classDefinitions") if isinstance(core_defs, dict) else None
        defs_map: dict[str, dict[str, Any]] = {}
        if isinstance(defs_list, list):
            for d in defs_list:
                if isinstance(d, dict) and isinstance(d.get("classDefId"), str):
                    defs_map[str(d.get("classDefId"))] = d
        items = []
        if isinstance(classes, list):
            for c in classes:
                if not isinstance(c, dict):
                    continue
                if skill_level and c.get("skillLevel") != skill_level:
                    continue
                class_def_id = str(c.get("classDefId") or "")
                d = defs_map.get(class_def_id) if class_def_id else None
                title = d.get("title") if isinstance(d, dict) and d.get("title") else c.get("title")
                ctype = d.get("type") if isinstance(d, dict) and d.get("type") else c.get("type")
                skl = d.get("skillLevel") if isinstance(d, dict) and d.get("skillLevel") else c.get("skillLevel")
                dur = d.get("durationMinutes") if isinstance(d, dict) and d.get("durationMinutes") else c.get("durationMinutes")
                cap = d.get("defaultCapacity") if isinstance(d, dict) and d.get("defaultCapacity") else c.get("capacity")
                is_outdoor = d.get("isOutdoor") if isinstance(d, dict) and "isOutdoor" in d else c.get("isOutdoor")
                items.append(
                    {
                        "id": c.get("classId"),
                        "title": title,
                        "type": ctype,
                        "skillLevel": skl or "beginner",
                        "coachId": c.get("instructorAccountAddress") or c.get("instructorId") or "",
                        "startTimeISO": c.get("startTimeISO"),
                        "durationMinutes": dur,
                        "capacity": cap,
                        "isOutdoor": is_outdoor,
                    }
                )
        return Output(answer="", citations=[], data={"asOfISO": _now_iso(), "data": items})

    if msg.startswith("__CALENDAR_WEEK__:"):
        start_date = msg.split(":", 1)[1].strip()
        if not start_date:
            start_date = datetime.now(timezone.utc).date().isoformat()
        from_iso = f"{start_date}T00:00:00.000Z"
        end_date = (datetime.fromisoformat(start_date).date() + timedelta(days=6)).isoformat()
        to_iso = f"{end_date}T23:59:59.999Z"
        sched = await _scheduling_call_json("schedule_list_classes", {"fromISO": from_iso, "toISO": to_iso})
        classes = sched.get("classes") if isinstance(sched, dict) else []
        core_defs = await _core_call_json("core_list_class_definitions", {}) or {}
        defs_list = core_defs.get("classDefinitions") if isinstance(core_defs, dict) else None
        defs_map: dict[str, dict[str, Any]] = {}
        if isinstance(defs_list, list):
            for d in defs_list:
                if isinstance(d, dict) and isinstance(d.get("classDefId"), str):
                    defs_map[str(d.get("classDefId"))] = d
        hourly = await _weather_hourly_forecast(_GYM_LAT, _GYM_LON, hours=48, units="metric")
        daily = await _weather_daily_forecast(_GYM_LAT, _GYM_LON, days=8, units="metric")
        hourly_list = hourly.get("hourly") if isinstance(hourly, dict) else None
        daily_list = daily.get("daily") if isinstance(daily, dict) else None
        out_items: list[dict[str, Any]] = []
        for c in classes if isinstance(classes, list) else []:
            if not isinstance(c, dict):
                continue
            class_def_id = str(c.get("classDefId") or "")
            d = defs_map.get(class_def_id) if class_def_id else None
            start_iso = str(c.get("startTimeISO") or "")
            t = _parse_iso_to_unix(start_iso) if start_iso else None
            is_outdoor = bool(d.get("isOutdoor")) if isinstance(d, dict) and "isOutdoor" in d else bool(c.get("isOutdoor"))
            weather = None
            if is_outdoor and isinstance(t, int):
                if isinstance(hourly_list, list):
                    h = _pick_hour([x for x in hourly_list if isinstance(x, dict)], t)
                    if h:
                        weather = {
                            "summary": (h.get("weather")[0].get("description") if isinstance(h.get("weather"), list) and h.get("weather") and isinstance(h.get("weather")[0], dict) else "Hourly forecast"),
                            "temp": h.get("temp"),
                            "wind_speed": h.get("wind_speed"),
                            "wind_gust": h.get("wind_gust"),
                            "pop": h.get("pop"),
                        }
                if weather is None and isinstance(daily_list, list):
                    best = None
                    best_delta = None
                    for d in daily_list:
                        if not isinstance(d, dict):
                            continue
                        dt = d.get("dt")
                        if not isinstance(dt, int):
                            continue
                        delta = abs(dt - t)
                        if best_delta is None or delta < best_delta:
                            best = d
                            best_delta = delta
                    if best:
                        weather = {
                            "summary": (best.get("weather")[0].get("description") if isinstance(best.get("weather"), list) and best.get("weather") and isinstance(best.get("weather")[0], dict) else "Daily forecast"),
                            "temp": (best.get("temp") or {}).get("max") if isinstance(best.get("temp"), dict) else None,
                            "wind_speed": best.get("wind_speed"),
                            "wind_gust": best.get("wind_gust"),
                            "pop": best.get("pop"),
                        }

            out_items.append(
                {
                    "id": c.get("classId"),
                    "title": d.get("title") if isinstance(d, dict) and d.get("title") else c.get("title"),
                    "type": d.get("type") if isinstance(d, dict) and d.get("type") else c.get("type"),
                    "skillLevel": (d.get("skillLevel") if isinstance(d, dict) else None) or c.get("skillLevel") or "beginner",
                    "coachId": c.get("instructorAccountAddress") or c.get("instructorId") or "",
                    "startTimeISO": c.get("startTimeISO"),
                    "durationMinutes": (d.get("durationMinutes") if isinstance(d, dict) else None) or c.get("durationMinutes"),
                    "capacity": (d.get("defaultCapacity") if isinstance(d, dict) else None) or c.get("capacity"),
                    "isOutdoor": is_outdoor,
                    "weatherForecast": weather,
                }
            )
        schedule = {"asOfISO": _now_iso(), "weekStartISO": start_date, "weekEndISO": end_date, "classes": out_items}
        return Output(answer="", citations=[], schedule=schedule)

    if msg == "__CHECKOUT__":
        return await _handle_checkout(input.session)
    if msg.startswith("__RESERVE_CLASS__:"):
        class_id = msg.split(":", 1)[1].strip()
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

