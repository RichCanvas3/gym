from __future__ import annotations

import copy
import json
import os
import uuid
import re
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo
from typing import Any, Optional
from urllib.parse import quote

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import StructuredTool
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field

from .knowledge_index import KnowledgeHit, ensure_index_with_mcp, search_kb
from .mcp_tools import load_mcp_tools_from_env, load_mcp_tools_with_diagnostics_from_env


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

_GYM_LAT = 40.03781
_GYM_LON = -105.05228


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


def _session_account_address(session: Optional["Session"]) -> str:
    if session and isinstance(getattr(session, "accountAddress", None), str):
        v = str(getattr(session, "accountAddress") or "").strip()
        if v:
            return v
    # legacy
    return _waiver_account_address(session)


def _session_email(session: Optional["Session"]) -> str:
    if session and isinstance(getattr(session, "userEmail", None), str):
        v = str(getattr(session, "userEmail") or "").strip()
        if v:
            return v
    return _waiver_email(session)


def _session_participant(session: Optional["Session"]) -> str:
    if session and isinstance(getattr(session, "userName", None), str):
        v = str(getattr(session, "userName") or "").strip()
        if v:
            return v
    return _waiver_participant(session)


def _session_telegram_user_id(session: Optional["Session"]) -> str:
    if session and isinstance(getattr(session, "telegramUserId", None), str):
        v = str(getattr(session, "telegramUserId") or "").strip()
        if v:
            return v
    return ""


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


_DATE_ISO_RE = re.compile(r"\b(20\d{2}-\d{2}-\d{2})\b")


def _explicit_date_iso_from_text(text: str) -> str:
    if not isinstance(text, str):
        return ""
    m = _DATE_ISO_RE.search(text)
    if not m:
        return ""
    try:
        datetime.fromisoformat(m.group(1)).date()
        return m.group(1)
    except Exception:
        return ""


def _goal_integrations(bundle: dict[str, Any]) -> dict[str, Any]:
    integrations = bundle.get("integrations")
    if not isinstance(integrations, dict):
        integrations = {}
        bundle["integrations"] = integrations
    return integrations


def _set_last_date_context(bundle: dict[str, Any], date_iso: str, tz_name: str) -> None:
    integrations = _goal_integrations(bundle)
    integrations["lastDateContext"] = {"dateISO": date_iso, "tzName": tz_name, "setAtISO": _now_iso()}


def _resolve_date_iso_with_context(msg: str, tz_name: str, bundle: dict[str, Any]) -> str:
    tz = ZoneInfo(tz_name or "UTC")
    explicit = _explicit_date_iso_from_text(msg)
    if explicit:
        return explicit
    mlow = (msg or "").lower()
    base = datetime.now(tz=tz).date()
    if "yesterday" in mlow:
        return (base - timedelta(days=1)).isoformat()
    if "today" in mlow:
        ctx = _goal_integrations(bundle).get("lastDateContext")
        if isinstance(ctx, dict):
            d = ctx.get("dateISO")
            set_at = ctx.get("setAtISO")
            if isinstance(d, str) and d.strip() and isinstance(set_at, str) and set_at.strip():
                try:
                    ts = datetime.fromisoformat(set_at.replace("Z", "+00:00"))
                    if datetime.now(timezone.utc) - ts.astimezone(timezone.utc) < timedelta(minutes=30):
                        return d.strip()
                except Exception:
                    pass
        return base.isoformat()
    return base.isoformat()


async def _router_fitness_intent(msg: str) -> str:
    """
    Lightweight intent router to reduce brittle keyword gates.
    Returns exactly one label from:
      - food_day
      - food_trend
      - calories_day
      - exercise_burn_day
      - food_exercise_day
      - workouts_day
      - workouts_trend
      - exercise_overview_day
      - none
    """
    llm = ChatOpenAI(
        api_key=os.environ["OPENAI_API_KEY"],
        model=os.environ.get("OPENAI_ROUTER_MODEL", os.environ.get("OPENAI_MODEL", "gpt-5.2")),
        temperature=0.0,
    )
    sys = (
        "You route fitness chat intents.\n"
        "Return ONLY one label from this list:\n"
        "food_day, food_trend, calories_day, exercise_burn_day, food_exercise_day, workouts_day, workouts_trend, exercise_overview_day, none\n"
        "\n"
        "Definitions:\n"
        "- food_day: what the user ate / meals / food log for a day (today/yesterday/explicit date or implied).\n"
        "- food_trend: meals/food log over last few days / last week / past 7 days.\n"
        "- calories_day: daily calories intake/exercise/net for a day.\n"
        "- exercise_burn_day: calories burned/spent/out from workouts/exercise (often references like 'these workouts').\n"
        "- food_exercise_day: combined summary of what they ate + workouts + net.\n"
        "- workouts_day: list workouts/exercises done for a day.\n"
        "- workouts_trend: workouts summary over last few days / last week.\n"
        "- exercise_overview_day: deeper calorie overview incl. optional TDEE/BMR context.\n"
        "- none: anything else (booking/classes, profile edits, general Q&A).\n"
        "\n"
        "Prefer specific intents over generic ones. Never return multiple labels.\n"
    )
    out = await llm.ainvoke([SystemMessage(content=sys), HumanMessage(content=(msg or "").strip())])
    txt = str(getattr(out, "content", "") or "").strip().lower()
    allowed = {
        "food_day",
        "food_trend",
        "calories_day",
        "exercise_burn_day",
        "food_exercise_day",
        "workouts_day",
        "workouts_trend",
        "exercise_overview_day",
        "none",
    }
    return txt if txt in allowed else "none"


def _tomorrow_date_iso(tz_name: str) -> str:
    tz = ZoneInfo(tz_name or "UTC")
    now_local = datetime.now(tz=tz)
    return (now_local.date() + timedelta(days=1)).isoformat()


def _tool_raw_to_json(raw: Any) -> Optional[dict[str, Any]]:
    """
    MCP tools (via langchain-mcp-adapters) commonly return a list of content blocks:
      [{"type":"text","text":"{...json...}"}]
    Normalize that into a parsed JSON object.
    """
    try:
        if isinstance(raw, dict):
            content = raw.get("content")
            if isinstance(content, list):
                raw = content
            else:
                return raw

        if isinstance(raw, list):
            for item in raw:
                if isinstance(item, dict) and isinstance(item.get("text"), str):
                    return json.loads(str(item.get("text")))
            return None

        if isinstance(raw, str):
            return json.loads(raw)

        return None
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
        return _tool_raw_to_json(raw)
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
        return _tool_raw_to_json(raw)
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
        return _tool_raw_to_json(raw)
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
        return _tool_raw_to_json(raw)
    except Exception:
        return None


def _fitnesscore_use_graphdb() -> bool:
    return (os.getenv("FITNESSCORE_USE_GRAPHDB", "1") or "").strip() not in ("0", "false", "False", "no", "NO")


def _fitnesscore_graphdb_only() -> bool:
    # When enabled, fitness handlers should not fall back to Strava/Weight MCP.
    return (os.getenv("FITNESSCORE_GRAPHDB_ONLY", "1") or "").strip() in ("1", "true", "True", "yes", "YES", "on")


def _fitnesscore_graph_context_base() -> str:
    return (os.getenv("FITNESSCORE_GRAPH_CONTEXT_BASE", "https://id.fitnesscore.ai/graph/d1") or "").strip().rstrip("/")


def _fitnesscore_graph_iri_for_telegram_user_id(telegram_user_id: str) -> str:
    base = _fitnesscore_graph_context_base()
    tg = (telegram_user_id or "").strip()
    return f"{base}/{quote(f'tg:{tg}', safe='')}"


def _sparql_iso_dt(iso: str) -> str:
    s = str(iso or "").strip()
    return s.replace("+00:00", "Z")


def _sparql_bindings_rows(results_json: Any) -> list[dict[str, Any]]:
    if not isinstance(results_json, dict):
        return []
    r = results_json.get("results")
    if not isinstance(r, dict):
        return []
    b = r.get("bindings")
    return [x for x in b if isinstance(x, dict)] if isinstance(b, list) else []


def _sparql_get_val(binding: dict[str, Any], var: str) -> Optional[str]:
    v = binding.get(var)
    if not isinstance(v, dict):
        return None
    s = v.get("value")
    return str(s) if isinstance(s, (str, int, float)) else None


def _num(v: Any) -> Optional[float]:
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str) and v.strip():
        try:
            return float(v.strip())
        except Exception:
            return None
    return None


def _int(v: Any) -> Optional[int]:
    if isinstance(v, int):
        return int(v)
    if isinstance(v, float):
        return int(v)
    if isinstance(v, str) and v.strip():
        try:
            return int(float(v.strip()))
        except Exception:
            return None
    return None


async def _fitnesscore_graphdb_select(query: str) -> Optional[dict[str, Any]]:
    # tool name in MCP discovery can be either core_graphdb_sparql_select or core_core_graphdb_sparql_select
    return await _core_call_json("graphdb_sparql_select", {"query": query})


async def _strava_call_json(tool_suffix: str, args: dict[str, Any]) -> Optional[dict[str, Any]]:
    mcp_tools = await load_mcp_tools_from_env()
    tool = next(
        (
            t
            for t in mcp_tools
            if isinstance(getattr(t, "name", None), str)
            and (
                t.name == f"strava_{tool_suffix}"
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
        return _tool_raw_to_json(raw)
    except Exception:
        return None


async def _weight_call_json(tool_suffix: str, args: dict[str, Any]) -> Optional[dict[str, Any]]:
    mcp_tools = await load_mcp_tools_from_env()
    tool = next(
        (
            t
            for t in mcp_tools
            if isinstance(getattr(t, "name", None), str)
            and (
                t.name == f"weight_{tool_suffix}"
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
        return _tool_raw_to_json(raw)
    except Exception:
        return None


async def _telegram_call_json(tool_suffix: str, args: dict[str, Any]) -> Optional[dict[str, Any]]:
    mcp_tools = await load_mcp_tools_from_env()
    tool = next(
        (
            t
            for t in mcp_tools
            if isinstance(getattr(t, "name", None), str)
            and (
                t.name == f"telegram_{tool_suffix}"
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
        return _tool_raw_to_json(raw)
    except Exception:
        return None


async def _memory_append(thread_id: str, role: str, content: str) -> None:
    thread_id = (thread_id or "").strip()
    content = (content or "").strip()
    if not thread_id or not content:
        return
    await _core_call_json("core_memory_append_message", {"threadId": thread_id, "role": role, "content": content})


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

    email = _session_email(session)
    participant = _session_participant(session) or "Member"

    core_products = await _core_call_json("core_list_products", {}) or {}
    products_list = core_products.get("products") if isinstance(core_products, dict) else None
    products_map: dict[str, dict[str, Any]] = {}
    if isinstance(products_list, list):
        for p in products_list:
            if not isinstance(p, dict):
                continue
            sku = str(p.get("sku") or "").strip()
            if sku:
                products_map[sku] = p

    line_texts: list[str] = []
    subtotal = 0
    for l in cart_lines:
        sku = str(l.get("sku"))
        qty = int(l.get("quantity", 1))
        p = products_map.get(sku)
        if not isinstance(p, dict):
            line_texts.append(f"- {sku} x{qty} (unknown item)")
            continue
        name = str(p.get("name") or sku)
        price_cents = int(p.get("priceCents") or 0)
        line_total = price_cents * qty
        subtotal += line_total
        line_texts.append(f"- {name} ({sku}) x{qty}: {_format_usd(line_total)}")

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
            subject="Your Erie Rec Center Copilot receipt",
            text=receipt,
        )

    msg = f"Checkout complete. Total: {_format_usd(subtotal)}."
    if email:
        msg += f" Receipt email {'sent' if emailed else 'failed'} to {email}."
        if email_err and not emailed:
            msg += f" ({email_err})"
    else:
        msg += " No email on file."

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

    account_address = _session_account_address(session)
    participant_email = _session_email(session)
    participant_name = _session_participant(session)

    if not account_address:
        return Output(
            answer="Reservation requires an authenticated accountAddress.",
            citations=[],
            uiActions=[],
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
        answer += " No email on file."

    return Output(
        answer=answer,
        citations=[],
              uiActions=[],
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
    userEmail: Optional[str] = None
    accountAddress: Optional[str] = None
    telegramUserId: Optional[str] = None
    userGoals: Optional[str] = None
    """User-defined outcomes + executable checklist; synced from the chat UI (GoalBundleJSON). Domain-agnostic."""
    goalBundle: Optional[dict[str, Any]] = None
    cartLines: Optional[list[dict[str, Any]]] = None
    waiver: Optional[dict[str, Any]] = None
    threadId: Optional[str] = None


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
    goalBundle: Optional[dict[str, Any]] = None


class _Trace:
    def __init__(self) -> None:
        self.citations: list[dict[str, str]] = []
        self.ops_endpoints: set[str] = set()
        self.ops_as_of: Optional[str] = None


def build_system_prompt() -> str:
    return "\n".join(
        [
            "You are a helpful fitness + recreation assistant for the Erie Community Center (Erie, CO).",
            "",
            "Rules:",
            "- Be accurate. If you don't know, say so.",
            "- Never invent class times, prices, or inventory.",
            "- For class seat availability, call scheduling MCP tools (or ops_class_availability wrapper).",
            "- For products/pricing, use gym-core MCP (products/class definitions).",
            "- If asked about retail inventory, be explicit that inventory is not connected unless an inventory MCP tool exists.",
            "- Outdoor wall access and outdoor classes are weather-dependent. For any outdoor access/class question, call the weather FORECAST tools (MCP) and explain the result and safety implications.",
            "- For scheduling/booking (classes, camps, private coaching), use the calendar/scheduling tools when available.",
            "- For confirmations and reminders, use the messaging/notifications tools when available.",
            "- For future outdoor planning, prefer a forecast tool when available (not just current conditions).",
            "- For class reservations, reserve seats via the scheduling MCP using canonical account addresses, record a reservation ledger entry in gym-core, then send a confirmation email when possible.",
            "- For checkout, provide a concise receipt and send an email receipt when possible.",
            "- If discussing a specific outdoor class that is scheduled in the future, include forecast context for that class time when possible.",
            "- When asked about policies, class descriptions, coach bios, or general FAQs, use the knowledge search tool (RAG).",
            "- If you use knowledge search, include a short 'Sources' list at the end with the sourceIds you relied on.",
            "- If you use ops, mention the as-of timestamp returned by the tool.",
            "- If you use weather, mention the as-of timestamp and location used by the tool output.",
            "- If the user intent is to buy/book something, include a machine-readable cart suggestion at the end:",
            "  - Put `CartItemsJSON:` on its own line, followed by a JSON array of `{ sku, quantity, note? }`.",
            "  - Use real SKUs (use gym-core products when possible).",
            "- For web UI automation, you MAY also include these machine-readable directives at the very end (each on its own line):",
            "  - `CartActionsJSON:` followed by a JSON array of `{ op: \"add\"|\"remove\"|\"clear\", sku?, quantity?, note? }`.",
            "  - `UIActionsJSON:` followed by a JSON array of `{ type: \"navigate\", to: \"/cart\"|\"/shop\"|\"/chat\"|\"/calendar\", reason? }`.",
            "- If you add/remove items via CartActionsJSON, include a UI action to navigate to `/cart`.",
            "- Only navigate to `/calendar` if the user explicitly asks for a calendar/week view.",
            "",
            "Goal / outcome execution (domain-agnostic—like a small app state machine):",
            "- The user defines outcomes; you help operationalize them. Do not assume fitness, racing, or any single domain unless the user’s text implies it.",
            "- Session may include UserGoals (free text) and GoalBundle (structured JSON). Treat GoalBundle as the persisted spec the UI and tools can act on.",
            "- If the user's outcomes involve training, exercise, nutrition, or weight, use Strava MCP (workouts) and Weight MCP (day summaries / food logs / weigh-ins) when available to ground updates and progress.",
            "- Prefer FitnessCore GraphDB (via core GraphDB SPARQL tool) for workout/food/weight data when available; fall back to Strava/Weight MCP if GraphDB returns no rows or lacks fields.",
            "- For exercise calorie-burn questions, prefer GraphDB SUM over `fc:activeEnergyKcal` when present; otherwise fall back to Weight MCP `weight_day_summary` `totals.exercise_kcal` (it may be estimated/backfilled).",
            "- When you break work into milestones or a time-ordered checklist, end the reply with `GoalBundleJSON:` then compact JSON (merge with prior bundle when updating):",
            '  {"version":1,"primaryGoal":{"text":"<main outcome>","targetDateISO":"YYYY-MM-DD|null"},"weeklyFocus":["<near-term priorities>"],"trainingPlan":[{"id":"stable-id","dayLabel":"<time bucket or phase>","activity":"<concrete action>","startTimeISO":null,"endTimeISO":null,"completed":false}],"suggestedNext":["<optional next automation hints>"}',
            "- Field `trainingPlan` is a generic checklist of executable items (name is legacy); you may also use `actionPlan` with the same array shape—either is accepted.",
            "- Use dayLabel/activity for whatever fits the domain (e.g. sprint name + task, week + deliverable, date + habit). Fill startTimeISO/endTimeISO when the user’s timezone and timing are known so calendar MCP can run.",
            "- Slash commands: `/goal status` dumps the bundle; `/goal tick` completes the next incomplete checklist item; `/goal tick N` or `/goal tick <substring>` matches row or label. `/goal set …` → merge into primaryGoal / focus via GoalBundleJSON.",
            "- Execution: when the user asks to put “this” or “the plan” on a calendar, use the checklist you or GoalBundle already defined—call Google Calendar MCP (e.g. googlecalendar_create_event) per item with the user’s accountAddress; don’t demand unrelated generic “event details”.",
            "- If Calendar MCP isn’t connected, explain and point to /oauth/start?accountAddress=<their address>.",
            "- Other integrations (email, class booking, scheduling, gym catalog) are tools toward the user’s stated outcomes—pick what fits their ask, not a fixed playbook.",
            "",
            "Keep responses concise and actionable.",
        ]
    )


def build_session_prompt(session: Optional[Session]) -> str:
    gym_name = (session.gymName if session else None) or "Erie Community Center"
    tz = (session.timezone if session else None) or "America/Denver"
    lines = [f"Gym: {gym_name}", f"Timezone: {tz}"]
    # Default gym coordinates (Boulder, CO) for weather MCP calls.
    lines.append("GymLatLon: 40.03781, -105.05228")
    if session and session.userName:
        lines.append(f"UserName: {session.userName}")
    if session and session.userGoals:
        lines.append(f"UserGoals: {session.userGoals}")
    gb = _session_goal_bundle(session)
    if gb.get("primaryGoal") or gb.get("weeklyFocus") or gb.get("trainingPlan") or gb.get("suggestedNext"):
        lines.append("GoalBundle (user outcomes + checklist; update via GoalBundleJSON when the plan changes):\n" + json.dumps(gb, indent=2)[:12000])
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


def _default_goal_bundle() -> dict[str, Any]:
    return {"version": 1, "primaryGoal": None, "weeklyFocus": [], "trainingPlan": [], "suggestedNext": [], "integrations": {}}


def _session_goal_bundle(session: Optional[Session]) -> dict[str, Any]:
    base = _default_goal_bundle()
    raw = getattr(session, "goalBundle", None) if session else None
    if not isinstance(raw, dict):
        return base
    if "primaryGoal" in raw:
        base["primaryGoal"] = raw.get("primaryGoal")
    if isinstance(raw.get("weeklyFocus"), list):
        base["weeklyFocus"] = [str(x) for x in raw["weeklyFocus"] if x is not None][:20]
    plan_src = raw.get("trainingPlan")
    if not isinstance(plan_src, list) and isinstance(raw.get("actionPlan"), list):
        plan_src = raw["actionPlan"]
    if isinstance(plan_src, list):
        plan: list[dict[str, Any]] = []
        for it in plan_src[:31]:
            if not isinstance(it, dict):
                continue
            plan.append(
                {
                    "id": str(it.get("id") or "").strip() or f"row-{len(plan)}",
                    "dayLabel": str(it.get("dayLabel") or it.get("day") or "").strip(),
                    "activity": str(it.get("activity") or "").strip(),
                    "startTimeISO": it.get("startTimeISO") if isinstance(it.get("startTimeISO"), str) else None,
                    "endTimeISO": it.get("endTimeISO") if isinstance(it.get("endTimeISO"), str) else None,
                    "completed": bool(it.get("completed")) if "completed" in it else False,
                }
            )
        base["trainingPlan"] = plan
    if isinstance(raw.get("suggestedNext"), list):
        base["suggestedNext"] = [str(x) for x in raw["suggestedNext"] if x is not None][:12]
    if isinstance(raw.get("integrations"), dict):
        base["integrations"] = raw.get("integrations")
    return base


def _format_goal_status(bundle: dict[str, Any]) -> str:
    lines: list[str] = []
    pg = bundle.get("primaryGoal")
    if isinstance(pg, dict) and pg.get("text"):
        lines.append(f"Primary goal: {pg.get('text')}")
        if pg.get("targetDateISO"):
            lines.append(f"Target date: {pg.get('targetDateISO')}")
    wf = bundle.get("weeklyFocus")
    if isinstance(wf, list) and wf:
        lines.append("Near-term focus: " + "; ".join(str(x) for x in wf[:8]))
    tp = bundle.get("trainingPlan")
    if isinstance(tp, list) and tp:
        lines.append("Checklist (use /goal tick or /goal tick N):")
        for i, it in enumerate(tp, start=1):
            if not isinstance(it, dict):
                continue
            mark = "✓" if it.get("completed") else "○"
            dl = it.get("dayLabel") or "?"
            act = it.get("activity") or ""
            lines.append(f"  {i}. {mark} {dl}: {act}")
    if not lines:
        return "No structured goal data yet. Describe what you want to achieve, or say /goal set … in natural language."
    return "\n".join(lines)


def _looks_like_meal_text(text: str) -> bool:
    t = (text or "").strip().lower()
    if not t or t.startswith("/") or t.startswith("__"):
        return False
    if len(t) < 12:
        return False
    # Strong intents
    if "add that to my meals" in t or "add to my meals" in t or "log this" in t:
        return True
    # Meal markers + likely food nouns
    meal_words = ("breakfast", "lunch", "dinner", "snack", "ate ", "i ate", "had ", "for breakfast", "for lunch", "for dinner")
    if any(w in t for w in meal_words):
        return True
    foodish = ("eggs", "toast", "oatmeal", "coffee", "banana", "apple", "salad", "chicken", "rice", "yogurt", "sandwich", "protein", "calories", "kcal")
    return any(w in t for w in foodish)


def _looks_like_weight_text(text: str) -> bool:
    t = (text or "").strip().lower()
    if not t or t.startswith("/") or t.startswith("__"):
        return False
    # Explicit units are strongest.
    if " lb" in t or " lbs" in t or "kg" in t or "pounds" in t:
        return True
    # "weight 182.4" style
    if "weight" in t:
        # require a plausible numeric token
        import re

        return re.search(r"\b\d{2,3}(\.\d)?\b", t) is not None
    return False


def _parse_weight_from_text(text: str) -> tuple[Optional[float], Optional[float]]:
    """
    Return (weightKg, weightLb). If ambiguous, prefer pounds for US-localized casual logs.
    """
    import re

    t = (text or "").strip().lower()
    if not t:
        return None, None

    m = re.search(r"\b(\d{2,3}(?:\.\d)?)\s*(kg|kgs|kilograms?)\b", t)
    if m:
        try:
            return float(m.group(1)), None
        except Exception:
            return None, None

    m = re.search(r"\b(\d{2,3}(?:\.\d)?)\s*(lb|lbs|pounds?)\b", t)
    if m:
        try:
            return None, float(m.group(1))
        except Exception:
            return None, None

    # If the user says "weight 182.4" without units, assume lb.
    if "weight" in t:
        m = re.search(r"\b(\d{2,3}(?:\.\d)?)\b", t)
        if m:
            try:
                return None, float(m.group(1))
            except Exception:
                return None, None

    return None, None


def _weight_scope_from_session(session: Optional["Session"]) -> Optional[dict[str, Any]]:
    tg_user_id = _session_telegram_user_id(session)
    return {"telegramUserId": tg_user_id} if tg_user_id else None


async def _auto_import_telegram_meal_texts(session: Optional["Session"], bundle: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """
    Scan the Telegram chat titled "Smart Agent" for meal-like texts and import them into weight-mcp as food entries.
    Uses GoalBundle.integrations to remember the last imported message id.
    """
    scope = _weight_scope_from_session(session)
    if not scope:
        return bundle, []

    integrations = bundle.get("integrations") if isinstance(bundle.get("integrations"), dict) else {}
    tg_state = integrations.get("telegramMeals") if isinstance(integrations.get("telegramMeals"), dict) else {}
    last_id = tg_state.get("lastImportedMessageId")
    last_imported = int(last_id) if isinstance(last_id, (int, float)) else 0
    tg_user_id = _session_telegram_user_id(session)
    if not tg_user_id:
        return bundle, []

    chats = await _telegram_call_json("telegram_list_chats", {"limit": 200, "fromUserId": tg_user_id}) or {}
    chat_list = chats.get("chats") if isinstance(chats, dict) else None
    chat_id: Optional[str] = None
    if isinstance(chat_list, list):
        for c in chat_list:
            if not isinstance(c, dict):
                continue
            title = str(c.get("title") or "").strip()
            if title.lower() == "smart agent":
                chat_id = str(c.get("chatId") or "").strip() or None
                break
    if not chat_id:
        return bundle, []

    msgs = await _telegram_call_json(
        "telegram_list_messages",
        {"chatId": chat_id, "fromUserId": tg_user_id, "limit": 50, "includeImageUrls": True, "includeImageBytes": False},
    ) or {}
    items = msgs.get("messages") if isinstance(msgs, dict) else None
    if not isinstance(items, list) or not items:
        return bundle, []

    candidates: list[dict[str, Any]] = []
    for m in items:
        if not isinstance(m, dict):
            continue
        mid = m.get("messageId")
        if not isinstance(mid, (int, float)):
            continue
        mid_i = int(mid)
        if mid_i <= last_imported:
            continue
        txt = m.get("text")
        img_url: Optional[str] = None
        # telegram-mcp returns a single imageUrl string (plus `image.{url,imageUrl}`), not an array.
        u = m.get("imageUrl")
        if isinstance(u, str) and u.strip():
            img_url = u.strip()
        else:
            img = m.get("image")
            if isinstance(img, dict):
                u2 = img.get("url") or img.get("imageUrl")
                if isinstance(u2, str) and u2.strip():
                    img_url = u2.strip()
        is_meal_text = isinstance(txt, str) and _looks_like_meal_text(txt)
        if not is_meal_text and not img_url:
            continue
        candidates.append({"messageId": mid_i, "dateUnix": m.get("dateUnix"), "text": txt if isinstance(txt, str) else "", "imageUrl": img_url})

    if not candidates:
        # Still record chat id so we don't keep scanning chats list if the title changes
        integrations["telegramMeals"] = {**tg_state, "chatTitle": "Smart Agent", "chatId": chat_id, "lastCheckedAtISO": _now_iso()}
        bundle["integrations"] = integrations
        return bundle, []

    candidates.sort(key=lambda x: int(x.get("messageId") or 0))
    tz_name = (session.timezone if session else None) or "UTC"

    imported: list[dict[str, Any]] = []
    for c in candidates[:20]:
        mid_i = int(c["messageId"])
        du = c.get("dateUnix")
        at_ms = int(du) * 1000 if isinstance(du, (int, float)) else int(datetime.now(timezone.utc).timestamp() * 1000)
        text = str(c.get("text") or "").strip()
        image_url = c.get("imageUrl")
        if not text and not (isinstance(image_url, str) and image_url.strip()):
            continue
        res = await _weight_call_json(
            "weight_ingest_telegram_message",
            {
                "scope": scope,
                "tzName": tz_name,
                "chatId": chat_id,
                "messageId": mid_i,
                "dateUnix": du,
                "atMs": at_ms,
                "text": text,
                "imageUrl": image_url,
            },
        )
        if isinstance(res, dict) and res.get("ok") is True:
            kind = str(res.get("kind") or "")
            inner = res.get("result") if isinstance(res.get("result"), dict) else {}
            imported.append(
                {
                    "messageId": mid_i,
                    "atMs": inner.get("at_ms") if isinstance(inner, dict) else res.get("at_ms"),
                    "meal": inner.get("meal") if isinstance(inner, dict) else res.get("meal"),
                    "summary": inner.get("summary") if isinstance(inner, dict) else None,
                    "foodEntryId": (inner.get("foodEntryId") if isinstance(inner, dict) else None) or res.get("foodEntryId"),
                    "kind": kind,
                }
            )
        # advance cursor even if one fails, to prevent repeated attempts on a bad message
        last_imported = max(last_imported, mid_i)

    integrations["telegramMeals"] = {
        **tg_state,
        "chatTitle": "Smart Agent",
        "chatId": chat_id,
        "lastImportedMessageId": last_imported,
        "lastCheckedAtISO": _now_iso(),
    }
    bundle["integrations"] = integrations
    return bundle, imported


async def _auto_import_telegram_weight_texts(session: Optional["Session"], bundle: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """
    Scan the Telegram chat titled "Smart Agent" for weigh-in-like texts and import them into weight-mcp.
    Uses GoalBundle.integrations to remember the last imported message id.
    """
    scope = _weight_scope_from_session(session)
    if not scope:
        return bundle, []

    integrations = bundle.get("integrations") if isinstance(bundle.get("integrations"), dict) else {}
    tg_state = integrations.get("telegramWeights") if isinstance(integrations.get("telegramWeights"), dict) else {}
    last_id = tg_state.get("lastImportedMessageId")
    last_imported = int(last_id) if isinstance(last_id, (int, float)) else 0
    tg_user_id = _session_telegram_user_id(session)
    if not tg_user_id:
        return bundle, []

    chats = await _telegram_call_json("telegram_list_chats", {"limit": 200, "fromUserId": tg_user_id}) or {}
    chat_list = chats.get("chats") if isinstance(chats, dict) else None
    chat_id: Optional[str] = None
    if isinstance(chat_list, list):
        for c in chat_list:
            if not isinstance(c, dict):
                continue
            title = str(c.get("title") or "").strip()
            if title.lower() == "smart agent":
                chat_id = str(c.get("chatId") or "").strip() or None
                break
    if not chat_id:
        return bundle, []

    msgs = await _telegram_call_json(
        "telegram_list_messages",
        {"chatId": chat_id, "fromUserId": tg_user_id, "limit": 50, "includeImageUrls": False, "includeImageBytes": False},
    ) or {}
    items = msgs.get("messages") if isinstance(msgs, dict) else None
    if not isinstance(items, list) or not items:
        return bundle, []

    candidates: list[dict[str, Any]] = []
    for m in items:
        if not isinstance(m, dict):
            continue
        mid = m.get("messageId")
        if not isinstance(mid, (int, float)):
            continue
        mid_i = int(mid)
        if mid_i <= last_imported:
            continue
        txt = m.get("text")
        if not isinstance(txt, str) or not _looks_like_weight_text(txt):
            continue
        kg, lb = _parse_weight_from_text(txt)
        if kg is None and lb is None:
            continue
        candidates.append({"messageId": mid_i, "dateUnix": m.get("dateUnix"), "text": txt, "kg": kg, "lb": lb})

    if not candidates:
        integrations["telegramWeights"] = {**tg_state, "chatTitle": "Smart Agent", "chatId": chat_id, "lastCheckedAtISO": _now_iso()}
        bundle["integrations"] = integrations
        return bundle, []

    candidates.sort(key=lambda x: int(x.get("messageId") or 0))

    imported: list[dict[str, Any]] = []
    for c in candidates[:20]:
        mid_i = int(c["messageId"])
        du = c.get("dateUnix")
        at_ms = int(du) * 1000 if isinstance(du, (int, float)) else int(datetime.now(timezone.utc).timestamp() * 1000)
        text = str(c.get("text") or "").strip()
        res = await _weight_call_json(
            "weight_ingest_telegram_message",
            {
                "scope": scope,
                "tzName": (session.timezone if session else None) or "UTC",
                "chatId": chat_id,
                "messageId": mid_i,
                "dateUnix": du,
                "atMs": at_ms,
                "text": text,
            },
        )
        if isinstance(res, dict) and res.get("ok") is True:
            inner = res.get("result") if isinstance(res.get("result"), dict) else {}
            imported.append(
                {
                    "messageId": mid_i,
                    "atMs": inner.get("at_ms") if isinstance(inner, dict) else res.get("at_ms"),
                    "weightKg": inner.get("weight_kg") if isinstance(inner, dict) else res.get("weight_kg"),
                    "kind": res.get("kind"),
                }
            )
        last_imported = max(last_imported, mid_i)

    integrations["telegramWeights"] = {
        **tg_state,
        "chatTitle": "Smart Agent",
        "chatId": chat_id,
        "lastImportedMessageId": last_imported,
        "lastCheckedAtISO": _now_iso(),
    }
    bundle["integrations"] = integrations
    return bundle, imported


async def _handle_goal_slash_commands(msg: str, session: Optional[Session], thread_id: str) -> Optional[Output]:
    stripped = msg.strip()
    if not stripped.lower().startswith("/goal "):
        return None
    rest = stripped[len("/goal ") :].strip()
    sub = rest.lower()
    bundle = copy.deepcopy(_session_goal_bundle(session))

    if sub.startswith("tick"):
        tick_arg = rest[4:].strip().lower()
        plan = bundle.get("trainingPlan")
        if not isinstance(plan, list) or not plan:
            answer = "Nothing to tick yet—ask me to break your outcome into steps first so we can save a checklist to your goal bundle. Try /goal status."
            if thread_id:
                await _memory_append(thread_id, "user", msg)
                await _memory_append(thread_id, "assistant", answer)
            return Output(answer=answer, citations=[], goalBundle=bundle)

        idx_to_tick = -1
        if tick_arg.isdigit():
            n = int(tick_arg)
            if 1 <= n <= len(plan):
                idx_to_tick = n - 1
        elif tick_arg:
            for i, it in enumerate(plan):
                if isinstance(it, dict):
                    dl = str(it.get("dayLabel") or "").lower()
                    act = str(it.get("activity") or "").lower()
                    if tick_arg in dl or tick_arg in act:
                        idx_to_tick = i
                        break
        else:
            for i, it in enumerate(plan):
                if isinstance(it, dict) and not it.get("completed"):
                    idx_to_tick = i
                    break
            if idx_to_tick < 0:
                idx_to_tick = len(plan) - 1

        if idx_to_tick < 0 or idx_to_tick >= len(plan):
            answer = "Couldn’t match that row. Use /goal status for numbers, then /goal tick 2 (for row 2)."
        else:
            row = plan[idx_to_tick]
            if isinstance(row, dict):
                row["completed"] = True
            item = plan[idx_to_tick] if isinstance(plan[idx_to_tick], dict) else {}
            answer = f"Marked complete: **{item.get('dayLabel', '')}** — {item.get('activity', '')}"
        if thread_id:
            await _memory_append(thread_id, "user", msg)
            await _memory_append(thread_id, "assistant", answer)
        return Output(answer=answer, citations=[], goalBundle=bundle)

    if sub == "status" or sub.startswith("status "):
        answer = _format_goal_status(bundle)
        if thread_id:
            await _memory_append(thread_id, "user", msg)
            await _memory_append(thread_id, "assistant", answer)
        return Output(answer=answer, citations=[], goalBundle=bundle)

    if sub.startswith("reset"):
        arg = sub[len("reset") :].strip()
        if not arg or arg == "all":
            bundle = _empty_goal_bundle()
            answer = "Reset goal bundle."
        else:
            integrations = bundle.get("integrations") if isinstance(bundle.get("integrations"), dict) else {}
            if any(k in arg for k in ["telegram", "meals", "weights"]):
                integrations.pop("telegramMeals", None)
                integrations.pop("telegramWeights", None)
                bundle["integrations"] = integrations
                answer = "Reset Telegram import cursors."
            else:
                answer = "Unknown reset target. Try `/goal reset telegram` or `/goal reset all`."
        if thread_id:
            await _memory_append(thread_id, "user", msg)
            await _memory_append(thread_id, "assistant", answer)
        return Output(answer=answer, citations=[], goalBundle=bundle)

    return None


def make_tools() -> tuple[list[StructuredTool], Any]:
    if not os.environ.get("OPENAI_API_KEY"):
        raise RuntimeError("Missing OPENAI_API_KEY")

    trace = _Trace()

    class KnowledgeSearchArgs(BaseModel):
        query: str = Field(min_length=1)
        k: Optional[int] = Field(default=4, ge=1, le=10)

    async def knowledge_search(query: str, k: int = 4) -> str:
        ttl = int(float(os.environ.get("KB_INDEX_TTL_SECONDS", "300")))
        index = await ensure_index_with_mcp(ttl_seconds=max(10, ttl))
        tool_text, hits = search_kb(index, query, k=k)
        for h in hits:
            trace.citations.append({"sourceId": h.sourceId, "snippet": h.snippet})
        return tool_text

    knowledge_tool = StructuredTool.from_function(
        name="knowledge_search",
        description="Search the gym knowledge base (policies, hours, class descriptions, coach bios, rentals). Use this for FAQs and policy questions.",
        coroutine=knowledge_search,
        args_schema=KnowledgeSearchArgs,
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

    class FitnessSnapshotArgs(BaseModel):
        telegramUserId: str = Field(min_length=3, description="Telegram numeric user id as string (used as weight-management scope id).")
        dateISO: Optional[str] = Field(default=None, description="Local date (YYYY-MM-DD). Defaults to today in tzName.")
        tzName: Optional[str] = Field(default="America/Denver", description="IANA timezone name for date defaulting.")

    async def fitness_snapshot(telegramUserId: str, dateISO: Optional[str] = None, tzName: str = "America/Denver") -> str:
        tz = ZoneInfo(tzName or "UTC")
        if not dateISO or not isinstance(dateISO, str) or not dateISO.strip():
            dateISO = datetime.now(tz=tz).date().isoformat()
        scope = {"telegramUserId": telegramUserId.strip()}
        day = await _weight_call_json("weight_day_summary", {"scope": scope, "dateISO": dateISO, "tzName": tzName}) or {}
        workout = await _strava_call_json("strava_latest_workout", {"telegramUserId": telegramUserId.strip()}) or {}
        return json.dumps(
            {
                "asOfISO": _now_iso(),
                "dateISO": dateISO,
                "weightDaySummary": day,
                "latestWorkout": workout,
            },
            indent=2,
        )

    fitness_snapshot_tool = StructuredTool.from_function(
        name="fitness_snapshot",
        description="Return a combined snapshot: today's weight-management day summary (scoped by telegramUserId) + latest Strava workout.",
        coroutine=fitness_snapshot,
        args_schema=FitnessSnapshotArgs,
    )

    tools = [
        knowledge_tool,
        ops_class_search_tool,
        ops_class_tool,
        ops_reserve_class_tool,
        fitness_snapshot_tool,
    ]
    return tools, trace


async def run(input: Input) -> Output:
    msg = input.message.strip()
    mlow = msg.lower()

    acct = _session_account_address(input.session)
    thread_id = ""
    if input.session and isinstance(input.session.threadId, str) and input.session.threadId.strip():
        thread_id = input.session.threadId.strip()
    elif acct:
        thread_id = f"thr_{acct.replace(':', '_')}"

    if acct and thread_id:
        await _core_call_json("core_memory_ensure_thread", {"canonicalAddress": acct, "threadId": thread_id, "title": "Gym chat"})

    # Chat UI helper: fetch persisted thread history without changing state.
    if msg == "__CHAT_HISTORY__":
        if not thread_id:
            return Output(answer="", citations=[], data={"messages": []})
        mem = await _core_call_json("core_memory_list_messages", {"threadId": thread_id, "limit": 50}) or {}
        msgs = mem.get("messages") if isinstance(mem, dict) else None
        safe: list[dict[str, Any]] = []
        if isinstance(msgs, list):
            for m in msgs:
                if not isinstance(m, dict):
                    continue
                role = m.get("role")
                content = m.get("content")
                if role in {"user", "assistant"} and isinstance(content, str) and content.strip():
                    safe.append({"role": role, "content": content})
        return Output(answer="", citations=[], data={"messages": safe})

    # UI helper: get current weight-management profile for this user.
    if msg == "__WEIGHT_PROFILE_GET__":
        tg_user_id = _session_telegram_user_id(input.session)
        if not tg_user_id:
            return Output(answer="I need you signed in with Telegram to do that.", citations=[], data={"error": "missing_telegram_user_id"})
        prof = await _weight_call_json("weight_profile_get", {"scope": {"telegramUserId": tg_user_id}})
        if prof is None:
            return Output(
                answer="Weight Management MCP profile_get failed.",
                citations=[],
                data={
                    "ok": False,
                    "error": "weight_profile_get_failed",
                    "hint": "Ensure MCP_TOOL_ALLOWLIST includes weight_weight_profile_get and Weight MCP server is healthy.",
                    "telegramUserId": tg_user_id,
                },
            )
        return Output(
            answer="",
            citations=[],
            data={
                "ok": True,
                "telegramUserId": tg_user_id,
                "profile": prof.get("profile") if isinstance(prof, dict) else None,
            },
        )

    if msg.startswith("__WEIGHT_PROFILE_UPSERT__:"):
        tg_user_id = _session_telegram_user_id(input.session)
        if not tg_user_id:
            return Output(answer="I need you signed in with Telegram to do that.", citations=[], data={"error": "missing_telegram_user_id"})
        try:
            payload = json.loads(msg.split(":", 1)[1].strip())
        except Exception:
            payload = {}
        profile = payload.get("profile") if isinstance(payload, dict) else {}
        if not isinstance(profile, dict):
            profile = {}
        out = await _weight_call_json("weight_profile_upsert", {"scope": {"telegramUserId": tg_user_id}, "profile": profile})
        if out is None:
            return Output(
                answer="Weight Management MCP profile_upsert failed.",
                citations=[],
                data={
                    "ok": False,
                    "error": "weight_profile_upsert_failed",
                    "hint": "Ensure MCP_TOOL_ALLOWLIST includes weight_weight_profile_upsert and Weight MCP server is healthy.",
                    "telegramUserId": tg_user_id,
                },
            )
        return Output(
            answer="",
            citations=[],
            data={
                "ok": True,
                "telegramUserId": tg_user_id,
                "updated_at": out.get("updated_at") if isinstance(out, dict) else None,
            },
        )

    # MCP diagnostics (which server/tool discovery is failing).
    if (not msg.startswith("__")) and ("mcp" in mlow) and any(k in mlow for k in ["fail", "failing", "broken", "load", "loading", "tools"]):
        try:
            _tools, diag = await load_mcp_tools_with_diagnostics_from_env()
        except Exception as e:
            return Output(
                answer=f"MCP tool load failed: {type(e).__name__}: {e}",
                citations=[],
                data={"asOfISO": _now_iso()},
            )
        ok = diag.get("okServers") if isinstance(diag, dict) else None
        bad = diag.get("failedServers") if isinstance(diag, dict) else None
        lines = ["MCP tool load status:"]
        if isinstance(ok, list) and ok:
            lines.append("\nOK:")
            for s in ok:
                if isinstance(s, dict):
                    lines.append(f"- {s.get('name')} (tools: {s.get('toolCount')})")
        if isinstance(bad, list) and bad:
            lines.append("\nFAILED:")
            for s in bad:
                if isinstance(s, dict):
                    lines.append(f"- {s.get('name')}: {s.get('error')}")
        if lines == ["MCP tool load status:"]:
            lines.append("\n(no MCP servers configured)")
        return Output(answer="\n".join(lines).strip(), citations=[], data={"asOfISO": _now_iso(), "diag": diag})

    goal_cmd = await _handle_goal_slash_commands(msg, input.session, thread_id)
    if goal_cmd is not None:
        return goal_cmd

    # Telegram->weight ingestion is handled by gym-cron-sync; avoid doing it inline during chat turns.
    had_session_goal_bundle = bool(input.session and isinstance(getattr(input.session, "goalBundle", None), dict))
    base_goal_bundle = copy.deepcopy(_session_goal_bundle(input.session))
    imported_meals: list[dict[str, Any]] = []
    imported_weights: list[dict[str, Any]] = []

    # Deterministic helper: "book/reserve next available" for a class definition mentioned in-thread.
    if (not msg.startswith("__")) and any(k in mlow for k in ["next available", "next opening", "next slot"]) and any(
        k in mlow for k in ["book", "reserve", "schedule"]
    ):
        hint = mlow
        if thread_id and any(k in mlow for k in ["this", "that", "it"]):
            mem = await _core_call_json("core_memory_list_messages", {"threadId": thread_id, "limit": 10}) or {}
            msgs = mem.get("messages") if isinstance(mem, dict) else None
            if isinstance(msgs, list):
                for m in reversed(msgs):
                    if isinstance(m, dict) and m.get("role") == "assistant" and isinstance(m.get("content"), str):
                        hint = hint + "\n" + str(m.get("content") or "").lower()
                        break

        core_defs = await _core_call_json("core_list_class_definitions", {}) or {}
        defs_list = core_defs.get("classDefinitions") if isinstance(core_defs, dict) else None
        best_def: Optional[dict[str, Any]] = None
        best_score = 0
        if isinstance(defs_list, list):
            for d in defs_list:
                if not isinstance(d, dict):
                    continue
                title = str(d.get("title") or "").strip()
                if not title:
                    continue
                t = title.lower()
                if t in hint:
                    score = len(t)
                    if score > best_score:
                        best_score = score
                        best_def = d

        if not best_def and "private coaching" in hint and isinstance(defs_list, list):
            for d in defs_list:
                if isinstance(d, dict) and "private coaching" in str(d.get("title") or "").lower():
                    best_def = d
                    break

        class_def_id = str(best_def.get("classDefId") or "").strip() if isinstance(best_def, dict) else ""
        if not class_def_id:
            answer = "I can book the next available time, but I need the class name (e.g., 'Private Coaching (60 min)')."
            if thread_id:
                await _memory_append(thread_id, "user", msg)
                await _memory_append(thread_id, "assistant", answer)
            return Output(answer=answer, citations=[])

        class_type = str(best_def.get("type") or "").strip() if isinstance(best_def, dict) else ""
        now_utc = datetime.now(timezone.utc)
        from_iso = now_utc.isoformat()
        to_iso = (now_utc + timedelta(days=14)).isoformat()
        sched = await _scheduling_call_json(
            "schedule_list_classes",
            {"fromISO": from_iso, "toISO": to_iso, "type": class_type if class_type in {"group", "private"} else None},
        )
        classes = sched.get("classes") if isinstance(sched, dict) else None
        candidates: list[dict[str, Any]] = []
        if isinstance(classes, list):
            for c in classes:
                if not isinstance(c, dict):
                    continue
                if str(c.get("classDefId") or "").strip() != class_def_id:
                    continue
                candidates.append(c)
        def _start_key(c: dict[str, Any]) -> float:
            s = c.get("startTimeISO")
            if isinstance(s, str) and s.strip():
                try:
                    # Accept "Z" suffix.
                    iso = s.strip().replace("Z", "+00:00")
                    return datetime.fromisoformat(iso).timestamp()
                except Exception:
                    return 10**18
            return 10**18

        candidates.sort(key=_start_key)

        picked: Optional[dict[str, Any]] = None
        for c in candidates[:20]:
            cid = str(c.get("classId") or "").strip()
            if not cid:
                continue
            avail = await _scheduling_call_json("schedule_class_availability", {"classId": cid}) or {}
            seats_left = int(avail.get("seatsLeft") or 0) if isinstance(avail, dict) else 0
            if seats_left > 0:
                picked = c
                break

        if not picked:
            answer = f"No upcoming availability found for {str(best_def.get('title') or 'that class')} in the next 14 days."
            if thread_id:
                await _memory_append(thread_id, "user", msg)
                await _memory_append(thread_id, "assistant", answer)
            return Output(answer=answer, citations=[])

        if not acct:
            return Output(
                answer="Booking requires an authenticated accountAddress.",
                citations=[],
                uiActions=[],
            )

        class_id = str(picked.get("classId") or "").strip()
        reserve_resp = await _scheduling_call_json(
            "schedule_reserve_seat",
            {"classId": class_id, "customerAccountAddress": acct},
        )
        reservation_obj = reserve_resp.get("reservation") if isinstance(reserve_resp, dict) else None
        if not isinstance(reservation_obj, dict):
            err = reserve_resp.get("error") if isinstance(reserve_resp, dict) else None
            answer = str(err or "Reservation failed.")
            if thread_id:
                await _memory_append(thread_id, "user", msg)
                await _memory_append(thread_id, "assistant", answer)
            return Output(answer=answer, citations=[])

        reservation_id = str(reservation_obj.get("reservationId") or "")
        await _core_call_json("core_upsert_customer", {"canonicalAddress": acct})  # best-effort
        await _core_call_json(
            "core_record_reservation",
            {
                "canonicalAddress": acct,
                "schedulerClassId": class_id,
                "schedulerReservationId": reservation_id,
                "classDefId": class_def_id,
                "status": "active",
            },
        )

        wants_cart = "cart" in mlow or "add to cart" in mlow
        cart_actions = None
        ui_actions = None
        if wants_cart:
            links = await _core_call_json("core_list_class_def_products", {"classDefId": class_def_id}) or {}
            items = links.get("items") if isinstance(links, dict) else None
            sku = ""
            if isinstance(items, list) and items and isinstance(items[0], dict):
                sku = str(items[0].get("sku") or "").strip()
            if sku:
                cart_actions = [
                    {
                        "op": "add",
                        "sku": sku,
                        "quantity": 1,
                        "note": f"Reserved session {str(picked.get('startTimeISO') or '').strip()} ({class_id})",
                    }
                ]
                ui_actions = [{"type": "navigate", "to": "/cart", "reason": "added booking to cart"}]

        answer = f"Reserved next available: {str(best_def.get('title') or '').strip()} at {str(picked.get('startTimeISO') or '').strip()}."
        if wants_cart:
            answer += " Added to your cart." if cart_actions else " I couldn't find a matching product SKU to add to cart."

        if thread_id:
            await _memory_append(thread_id, "user", msg)
            await _memory_append(thread_id, "assistant", answer)

        return Output(
            answer=answer,
            citations=[],
            cartActions=cart_actions,
            uiActions=ui_actions,
            reservation={"reservationId": reservation_id, "classId": class_id, "title": str(best_def.get("title") or ""), "startTimeISO": str(picked.get("startTimeISO") or "")},
        )

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
        wants_calendar = "calendar" in mlow or "week view" in mlow or "week" in mlow
        if not items:
            if thread_id:
                await _memory_append(thread_id, "user", msg)
                await _memory_append(thread_id, "assistant", f"No classes found for {date_iso}.")
            return Output(
                answer=f"No classes found for {date_iso}.",
                citations=[],
                uiActions=[{"type": "navigate", "to": "/calendar", "reason": "view schedule"}] if wants_calendar else [],
                data={"asOfISO": _now_iso(), "dateISO": date_iso, "fromISO": from_iso, "toISO": to_iso, "classes": []},
            )
        lines = []
        for c in items[:10]:
            lines.append(f"- {c.get('startTimeISO')} • {c.get('title')} ({c.get('classId')})")
        answer = "Tomorrow's classes:\n" + "\n".join(lines)
        if thread_id:
            await _memory_append(thread_id, "user", msg)
            await _memory_append(thread_id, "assistant", answer)
        return Output(
            answer=answer,
            citations=[],
            uiActions=[{"type": "navigate", "to": "/calendar", "reason": "view schedule"}] if wants_calendar else [],
            data={"asOfISO": _now_iso(), "dateISO": date_iso, "fromISO": from_iso, "toISO": to_iso, "classes": items},
        )

    fitness_intent = "none"
    if (not msg.startswith("__")) and any(
        k in mlow
        for k in [
            "meal",
            "meals",
            "food",
            "eat",
            "eaten",
            "calorie",
            "calories",
            "burn",
            "burned",
            "spent",
            "net",
            "intake",
            "workout",
            "workouts",
            "exercise",
            "exercises",
            "strava",
            "today",
            "yesterday",
            "last week",
            "past week",
            "last 7 days",
            "past 7 days",
            "last few days",
            "past few days",
        ]
    ):
        fitness_intent = await _router_fitness_intent(msg)

    # Deterministic: food log summary (past week / last N days).
    if fitness_intent == "food_trend":
        scope = _weight_scope_from_session(input.session)
        if not scope:
            answer = "I can summarize meals, but I need you signed in with Telegram."
            if thread_id:
                await _memory_append(thread_id, "user", msg)
                await _memory_append(thread_id, "assistant", answer)
            return Output(answer=answer, citations=[], uiActions=[])

        tz_name = (input.session.timezone if input.session and input.session.timezone else None) or "America/Denver"
        tz = ZoneInfo(tz_name or "UTC")
        today_local = datetime.now(tz=tz).date()
        days = 7 if ("week" in mlow or "7" in mlow) else 3
        start_local = (today_local - timedelta(days=days - 1)).isoformat()
        end_local = today_local.isoformat()
        from_iso, _ = _day_window_utc_from_local_date(start_local, tz_name)
        _, to_iso = _day_window_utc_from_local_date(end_local, tz_name)

        data0 = await _weight_call_json("weight_list_food", {"scope": scope, "fromISO": from_iso, "toISO": to_iso, "limit": 500})
        if data0 is None:
            answer = (
                "Weight Management MCP isn't connected in this deployment, so I can't fetch your meal log. "
                "Fix: add the weight worker to MCP_SERVERS_JSON and include weight_weight_list_food in MCP_TOOL_ALLOWLIST."
            )
            if thread_id:
                await _memory_append(thread_id, "user", msg)
                await _memory_append(thread_id, "assistant", answer)
            return Output(answer=answer, citations=[], data={"asOfISO": _now_iso(), "fromISO": from_iso, "toISO": to_iso})

        data = data0 or {}
        items = data.get("items") if isinstance(data, dict) else None
        if not isinstance(items, list) or not items:
            answer = f"No meals logged in the past {days} days."
            if thread_id:
                await _memory_append(thread_id, "user", msg)
                await _memory_append(thread_id, "assistant", answer)
            return Output(
                answer=answer,
                citations=[],
                goalBundle=base_goal_bundle if had_session_goal_bundle else None,
                data={
                    "asOfISO": _now_iso(),
                    "fromISO": from_iso,
                    "toISO": to_iso,
                    "count": 0,
                    "importedMeals": imported_meals,
                    "foodItems": [],
                },
            )

        food_items: list[dict[str, Any]] = []
        for it in items:
            if not isinstance(it, dict):
                continue
            img = it.get("image_url") or it.get("imageUrl")
            food_items.append(
                {
                    "id": it.get("id"),
                    "at_ms": it.get("at_ms"),
                    "meal": it.get("meal"),
                    "text": it.get("text"),
                    "calories": it.get("calories"),
                    "image_url": img,
                }
            )

        by_day: dict[str, dict[str, list[dict[str, Any]]]] = {}
        for it in items:
            if not isinstance(it, dict):
                continue
            at_ms = it.get("at_ms")
            if not isinstance(at_ms, (int, float)):
                continue
            dt_local = datetime.fromtimestamp(float(at_ms) / 1000.0, tz=timezone.utc).astimezone(tz)
            day = dt_local.date().isoformat()
            meal = str(it.get("meal") or "unknown").strip() or "unknown"
            by_day.setdefault(day, {}).setdefault(meal, []).append(it)

        lines = [f"Meals for the past {days} days ({tz_name}):"]
        for day in sorted(by_day.keys(), reverse=True):
            lines.append(f"\n{day}")
            meals = by_day[day]
            for meal in sorted(meals.keys()):
                rows = meals[meal]
                for r in rows[:5]:
                    text = str(r.get("text") or "").strip()
                    kcal = r.get("calories")
                    kcal_s = f" (~{int(round(float(kcal)))} kcal)" if isinstance(kcal, (int, float)) else ""
                    if text:
                        lines.append(f"- {meal}: {text}{kcal_s}")
                if len(rows) > 5:
                    lines.append(f"- {meal}: (+{len(rows) - 5} more)")

        answer = "\n".join(lines).strip()
        if imported_meals:
            answer = f"Imported {len(imported_meals)} new meal(s) from Telegram.\n\n" + answer
        if thread_id:
            await _memory_append(thread_id, "user", msg)
            await _memory_append(thread_id, "assistant", answer)
        return Output(
            answer=answer,
            citations=[],
            goalBundle=base_goal_bundle if had_session_goal_bundle else None,
            data={
                "asOfISO": _now_iso(),
                "fromISO": from_iso,
                "toISO": to_iso,
                "count": len(items),
                "importedMeals": imported_meals,
                "foodItems": food_items,
            },
        )

    # Deterministic: today's (or yesterday's) food summary with consistent totals.
    if fitness_intent == "food_day":
        scope = _weight_scope_from_session(input.session)
        if not scope:
            answer = "I can summarize meals, but I need you signed in with Telegram."
            if thread_id:
                await _memory_append(thread_id, "user", msg)
                await _memory_append(thread_id, "assistant", answer)
            return Output(answer=answer, citations=[], uiActions=[])

        tz_name = (input.session.timezone if input.session and input.session.timezone else None) or "America/Denver"
        date_iso = _resolve_date_iso_with_context(msg, tz_name, base_goal_bundle)
        _set_last_date_context(base_goal_bundle, date_iso, tz_name)
        from_iso, to_iso = _day_window_utc_from_local_date(date_iso, tz_name)

        items: list[dict[str, Any]] = []
        tg_user_id = _session_telegram_user_id(input.session)
        if _fitnesscore_use_graphdb() and tg_user_id:
            g = _fitnesscore_graph_iri_for_telegram_user_id(str(tg_user_id))
            q = f"""
PREFIX fc: <https://ontology.fitnesscore.ai/fc#>
PREFIX prov: <http://www.w3.org/ns/prov#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?t ?desc ?cal ?p ?c ?f WHERE {{
  GRAPH <{g}> {{
    ?e a fc:FoodEntry ;
      prov:generatedAtTime ?t .
    OPTIONAL {{ ?e fc:description ?desc . }}
    OPTIONAL {{ ?e fc:caloriesKcal ?cal . }}
    OPTIONAL {{ ?e fc:proteinGrams ?p . }}
    OPTIONAL {{ ?e fc:carbsGrams ?c . }}
    OPTIONAL {{ ?e fc:fatGrams ?f . }}
    FILTER(?t >= "{_sparql_iso_dt(from_iso)}"^^xsd:dateTime && ?t < "{_sparql_iso_dt(to_iso)}"^^xsd:dateTime)
  }}
}} ORDER BY ?t
""".strip()
            out = await _fitnesscore_graphdb_select(q)
            results = out.get("results") if isinstance(out, dict) else None
            rows = _sparql_bindings_rows(results)
            by_time: dict[str, dict[str, Any]] = {}
            for b in rows:
                t = _sparql_get_val(b, "t")
                if not t:
                    continue
                rec = by_time.setdefault(
                    t,
                    {
                        "id": None,
                        "at_ms": None,
                        "meal": None,
                        "text": None,
                        "calories": None,
                        "protein_g": None,
                        "carbs_g": None,
                        "fat_g": None,
                        "image_url": None,
                    },
                )
                desc = _sparql_get_val(b, "desc")
                if isinstance(desc, str) and desc.startswith("meal:"):
                    rec["meal"] = desc.split(":", 1)[1]
                if isinstance(desc, str) and desc.startswith("text:"):
                    rec["text"] = desc.split(":", 1)[1]
                for (src, dst) in [("cal", "calories"), ("p", "protein_g"), ("c", "carbs_g"), ("f", "fat_g")]:
                    v = _sparql_get_val(b, src)
                    if v is None:
                        continue
                    try:
                        rec[dst] = float(v)
                    except Exception:
                        pass
                try:
                    rec["at_ms"] = int(datetime.fromisoformat(t.replace("Z", "+00:00")).timestamp() * 1000)
                except Exception:
                    pass
            items = list(by_time.values())

        if not items:
            # fallback: Weight MCP
            data0 = await _weight_call_json("weight_list_food", {"scope": scope, "fromISO": from_iso, "toISO": to_iso, "limit": 500})
            if data0 is None:
                answer = (
                    "I can’t fetch your meal log right now. "
                    "Fix: ensure either GraphDB sync is running or Weight MCP is connected (weight_weight_list_food)."
                )
                if thread_id:
                    await _memory_append(thread_id, "user", msg)
                    await _memory_append(thread_id, "assistant", answer)
                return Output(answer=answer, citations=[], data={"asOfISO": _now_iso(), "fromISO": from_iso, "toISO": to_iso})
            items0 = (data0 or {}).get("items") if isinstance(data0, dict) else None
            items = [it for it in items0 if isinstance(it, dict)] if isinstance(items0, list) else []

        if not items:
            answer = f"No meals logged for {date_iso}."
            if thread_id:
                await _memory_append(thread_id, "user", msg)
                await _memory_append(thread_id, "assistant", answer)
            return Output(
                answer=answer,
                citations=[],
                goalBundle=base_goal_bundle if had_session_goal_bundle else None,
                data={"asOfISO": _now_iso(), "dateISO": date_iso, "fromISO": from_iso, "toISO": to_iso, "count": 0, "foodItems": []},
            )

        # Collect items + totals.
        food_items: list[dict[str, Any]] = []
        totals = {"calories": 0.0, "protein_g": 0.0, "carbs_g": 0.0, "fat_g": 0.0}
        by_meal: dict[str, list[dict[str, Any]]] = {}
        for it in items:
            if not isinstance(it, dict):
                continue
            img = it.get("image_url") or it.get("imageUrl")
            food_items.append(
                {
                    "id": it.get("id"),
                    "at_ms": it.get("at_ms"),
                    "meal": it.get("meal"),
                    "text": it.get("text"),
                    "calories": it.get("calories"),
                    "protein_g": it.get("protein_g"),
                    "carbs_g": it.get("carbs_g"),
                    "fat_g": it.get("fat_g"),
                    "image_url": img,
                }
            )
            meal = str(it.get("meal") or "unknown").strip() or "unknown"
            by_meal.setdefault(meal, []).append(it)
            for k in ["calories", "protein_g", "carbs_g", "fat_g"]:
                v = it.get(k)
                if isinstance(v, (int, float)):
                    totals[k] += float(v)

        def fmt_tot(label: str, d: dict[str, float]) -> str:
            return (
                f"**{label}:** **{int(round(d['calories']))} kcal** "
                f"(Protein **{d['protein_g']:.1f}g** / Carbs **{d['carbs_g']:.1f}g** / Fat **{d['fat_g']:.1f}g**)"
            )

        # Build answer. Show all items (up to 30) but totals always match all items we used.
        if "yesterday" in mlow:
            header = f"Yesterday ({date_iso}, {tz_name}), you've logged:"
        elif "today" in mlow:
            header = f"Today ({date_iso}, {tz_name}), you've logged:"
        else:
            header = f"For {date_iso} ({tz_name}), you've logged:"
        lines = [header]
        for meal in sorted(by_meal.keys()):
            rows = by_meal[meal]
            lines.append(f"\n- **{meal.title()}**:")
            for r in rows[:10]:
                text = str(r.get("text") or "").strip()
                kcal = r.get("calories")
                p = r.get("protein_g")
                c = r.get("carbs_g")
                f = r.get("fat_g")
                kcal_s = f" **{int(round(float(kcal)))} kcal**" if isinstance(kcal, (int, float)) else ""
                macro_s = ""
                if isinstance(p, (int, float)) and isinstance(c, (int, float)) and isinstance(f, (int, float)):
                    macro_s = f" (P **{float(p):.1f}g** / C **{float(c):.1f}g** / F **{float(f):.1f}g**)"
                if text:
                    lines.append(f"  - {text} —{kcal_s}{macro_s}")
            if len(rows) > 10:
                lines.append(f"  - (+{len(rows) - 10} more)")

        lines.append("\n" + fmt_tot("Total so far", totals))
        answer = "\n".join(lines).strip()
        if thread_id:
            await _memory_append(thread_id, "user", msg)
            await _memory_append(thread_id, "assistant", answer)
        return Output(
            answer=answer,
            citations=[],
            goalBundle=base_goal_bundle,
            data={"asOfISO": _now_iso(), "dateISO": date_iso, "fromISO": from_iso, "toISO": to_iso, "count": len(food_items), "foodItems": food_items},
        )

    # Deterministic: daily calories (intake / exercise burn / net) for "today" or an explicit date.
    if fitness_intent == "calories_day":
        scope = _weight_scope_from_session(input.session)
        if not scope:
            answer = "I can summarize calories, but I need you signed in with Telegram."
            if thread_id:
                await _memory_append(thread_id, "user", msg)
                await _memory_append(thread_id, "assistant", answer)
            return Output(answer=answer, citations=[], uiActions=[])

        tz_name = (input.session.timezone if input.session and input.session.timezone else None) or "America/Denver"
        date_iso = _resolve_date_iso_with_context(msg, tz_name, base_goal_bundle)
        _set_last_date_context(base_goal_bundle, date_iso, tz_name)

        from_iso, to_iso = _day_window_utc_from_local_date(date_iso, tz_name)

        tg_user_id = _session_telegram_user_id(input.session)
        graph_mode = _fitnesscore_use_graphdb() and bool(tg_user_id)
        g_intake_kcal = 0.0
        g_ex_kcal = 0.0
        workouts_today: list[dict[str, Any]] = []

        if graph_mode:
            g = _fitnesscore_graph_iri_for_telegram_user_id(str(tg_user_id))
            q = f"""
PREFIX fc: <https://ontology.fitnesscore.ai/fc#>
PREFIX prov: <http://www.w3.org/ns/prov#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?workout ?activityType ?started ?activeEnergyKcal ?durationSeconds ?distanceMeters WHERE {{
  GRAPH <{g}> {{
    ?workout a fc:Workout ;
      prov:startedAtTime ?started .
    OPTIONAL {{ ?workout fc:activityType ?activityType . }}
    OPTIONAL {{ ?workout fc:activeEnergyKcal ?activeEnergyKcal . }}
    OPTIONAL {{ ?workout fc:durationSeconds ?durationSeconds . }}
    OPTIONAL {{ ?workout fc:distanceMeters ?distanceMeters . }}
    FILTER(?started >= "{_sparql_iso_dt(from_iso)}"^^xsd:dateTime && ?started < "{_sparql_iso_dt(to_iso)}"^^xsd:dateTime)
  }}
}} ORDER BY ?started
""".strip()
            out = await _fitnesscore_graphdb_select(q)
            results = out.get("results") if isinstance(out, dict) else None
            rows = _sparql_bindings_rows(results)
            for b in rows:
                kcal = _sparql_get_val(b, "activeEnergyKcal")
                if kcal is not None:
                    try:
                        g_ex_kcal += float(kcal)
                    except Exception:
                        pass
                workouts_today.append(
                    {
                        "workout": _sparql_get_val(b, "workout"),
                        "activity_type": _sparql_get_val(b, "activityType"),
                        "started_at_iso": _sparql_get_val(b, "started"),
                        "active_energy_kcal": kcal,
                        "duration_seconds": _sparql_get_val(b, "durationSeconds"),
                        "distance_meters": _sparql_get_val(b, "distanceMeters"),
                    }
                )

            q_food = f"""
PREFIX fc: <https://ontology.fitnesscore.ai/fc#>
PREFIX prov: <http://www.w3.org/ns/prov#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT (SUM(?k) AS ?kcalTotal) WHERE {{
  GRAPH <{g}> {{
    ?e a fc:FoodEntry ;
      prov:generatedAtTime ?t ;
      fc:caloriesKcal ?k .
    FILTER(?t >= "{_sparql_iso_dt(from_iso)}"^^xsd:dateTime && ?t < "{_sparql_iso_dt(to_iso)}"^^xsd:dateTime)
  }}
}}
""".strip()
            out_food = await _fitnesscore_graphdb_select(q_food)
            results_food = out_food.get("results") if isinstance(out_food, dict) else None
            rows_food = _sparql_bindings_rows(results_food)
            if rows_food:
                v = _sparql_get_val(rows_food[0], "kcalTotal")
                if v is not None:
                    try:
                        g_intake_kcal = float(v)
                    except Exception:
                        g_intake_kcal = 0.0

        totals = {}
        if _fitnesscore_graphdb_only() and graph_mode:
            intake_kcal = g_intake_kcal
            ex_kcal = g_ex_kcal
            net_kcal = intake_kcal - ex_kcal
        else:
            # fallback to Weight MCP if graph disabled / empty / missing burn estimates
            day0 = await _weight_call_json("weight_day_summary", {"scope": scope, "dateISO": date_iso, "tzName": tz_name}) or {}
            totals0 = day0.get("totals") if isinstance(day0, dict) else None
            totals0 = totals0 if isinstance(totals0, dict) else {}
            w_intake_kcal = float(totals0.get("calories") or 0) if isinstance(totals0.get("calories"), (int, float)) else 0.0
            w_ex_kcal = float(totals0.get("exercise_kcal") or 0) if isinstance(totals0.get("exercise_kcal"), (int, float)) else 0.0
            totals = totals0

            intake_kcal = g_intake_kcal if (graph_mode and g_intake_kcal > 0.0) else w_intake_kcal
            ex_kcal = g_ex_kcal if (graph_mode and g_ex_kcal > 0.0) else w_ex_kcal
            net_kcal = intake_kcal - ex_kcal

        # If we didn't get workouts from GraphDB, fall back to Strava list for display.
        if (not workouts_today) and tg_user_id and not (_fitnesscore_graphdb_only() and graph_mode):
            str0 = await _strava_call_json("strava_list_workouts", {"telegramUserId": tg_user_id, "limit": 200}) or {}
            workouts = str0.get("workouts") if isinstance(str0, dict) else None
            wlist = [w for w in workouts if isinstance(w, dict)] if isinstance(workouts, list) else []
            tz = ZoneInfo(tz_name or "UTC")

            def _parse_iso(s: Any) -> Optional[datetime]:
                if not isinstance(s, str) or not s.strip():
                    return None
                try:
                    return datetime.fromisoformat(s.strip().replace("Z", "+00:00")).astimezone(timezone.utc)
                except Exception:
                    return None

            for w in wlist:
                started = _parse_iso(w.get("started_at_iso")) or _parse_iso(w.get("ended_at_iso"))
                if not started:
                    continue
                if started.astimezone(tz).date().isoformat() != date_iso:
                    continue
                workouts_today.append(w)

        # If Strava has workouts but weight-mcp shows 0 burn, attempt a lightweight ingest
        # (no Telegram sync; just ensure workouts exist in wm_exercise_entries).
        if tg_user_id and workouts_today and ex_kcal <= 0.0 and not (_fitnesscore_graphdb_only() and graph_mode):
            for w in workouts_today[:10]:
                try:
                    await _weight_call_json(
                        "weight_ingest_workout",
                        {
                            "scope": scope,
                            "source": "strava",
                            "workoutId": str(w.get("workout_id") or w.get("id") or "").strip(),
                            "startedAtISO": w.get("started_at_iso") or w.get("ended_at_iso"),
                            "activityType": w.get("activity_type"),
                            "durationSeconds": w.get("duration_seconds"),
                            "distanceMeters": w.get("distance_meters"),
                            "activeEnergyKcal": w.get("active_energy_kcal"),
                            "raw": {"metadata_json": w.get("metadata_json")},
                        },
                    )
                except Exception:
                    pass
            day1 = await _weight_call_json("weight_day_summary", {"scope": scope, "dateISO": date_iso, "tzName": tz_name}) or {}
            totals1 = day1.get("totals") if isinstance(day1, dict) else None
            totals1 = totals1 if isinstance(totals1, dict) else {}
            ex_w = float(totals1.get("exercise_kcal") or 0) if isinstance(totals1.get("exercise_kcal"), (int, float)) else 0.0
            ex_kcal = ex_kcal if ex_kcal > 0.0 else ex_w
            net_kcal = intake_kcal - ex_kcal
            totals = totals1 or totals

        lines = [
            f"Daily calories ({date_iso}, {tz_name}):",
            f"- Intake: **{int(round(intake_kcal))} kcal**",
            f"- Exercise burn: **{int(round(ex_kcal))} kcal**",
            f"- Net (intake − exercise): **{int(round(net_kcal))} kcal**",
        ]
        if workouts_today:
            lines.append("\nWorkouts:")
            for w in workouts_today[:6]:
                typ = str(w.get("activity_type") or "Workout").strip() or "Workout"
                lines.append(f"- {typ}")

        answer = "\n".join(lines).strip()
        if thread_id:
            await _memory_append(thread_id, "user", msg)
            await _memory_append(thread_id, "assistant", answer)
        return Output(answer=answer, citations=[], goalBundle=base_goal_bundle, data={"asOfISO": _now_iso(), "dateISO": date_iso, "totals": totals})

    # Exercise calories burned: compute deterministically from Weight MCP day summary.
    if fitness_intent == "exercise_burn_day":
        scope = _weight_scope_from_session(input.session)
        if not scope:
            answer = "I can estimate exercise calories, but I need you signed in with Telegram."
            if thread_id:
                await _memory_append(thread_id, "user", msg)
                await _memory_append(thread_id, "assistant", answer)
            return Output(answer=answer, citations=[], uiActions=[])

        tz_name = (input.session.timezone if input.session and input.session.timezone else None) or "America/Denver"
        date_iso = _resolve_date_iso_with_context(msg, tz_name, base_goal_bundle)
        _set_last_date_context(base_goal_bundle, date_iso, tz_name)
        from_iso, to_iso = _day_window_utc_from_local_date(date_iso, tz_name)

        tg_user_id = _session_telegram_user_id(input.session)
        ex_out = 0.0
        if _fitnesscore_use_graphdb() and tg_user_id:
            g = _fitnesscore_graph_iri_for_telegram_user_id(str(tg_user_id))
            q = f"""
PREFIX fc: <https://ontology.fitnesscore.ai/fc#>
PREFIX prov: <http://www.w3.org/ns/prov#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT (SUM(?k) AS ?exerciseKcal) (COUNT(?w) AS ?workouts) WHERE {{
  GRAPH <{g}> {{
    ?w a fc:Workout ;
      prov:startedAtTime ?t .
    OPTIONAL {{ ?w fc:activeEnergyKcal ?k . }}
    FILTER(?t >= "{_sparql_iso_dt(from_iso)}"^^xsd:dateTime && ?t < "{_sparql_iso_dt(to_iso)}"^^xsd:dateTime)
  }}
}}
""".strip()
            out = await _fitnesscore_graphdb_select(q)
            results = out.get("results") if isinstance(out, dict) else None
            rows = _sparql_bindings_rows(results)
            if rows:
                v = _sparql_get_val(rows[0], "exerciseKcal")
                if v is not None:
                    try:
                        ex_out = float(v)
                    except Exception:
                        ex_out = 0.0

        if ex_out <= 0.0 and not (_fitnesscore_graphdb_only() and _fitnesscore_use_graphdb() and tg_user_id):
            day0 = await _weight_call_json("weight_day_summary", {"scope": scope, "dateISO": date_iso, "tzName": tz_name}) or {}
            totals = day0.get("totals") if isinstance(day0, dict) else None
            totals = totals if isinstance(totals, dict) else {}
            ex_kcal = totals.get("exercise_kcal")
            ex_out = float(ex_kcal) if isinstance(ex_kcal, (int, float)) else 0.0

        if ex_out <= 0.0 and not (_fitnesscore_graphdb_only() and _fitnesscore_use_graphdb() and tg_user_id):
            if tg_user_id:
                str0 = await _strava_call_json("strava_list_workouts", {"telegramUserId": tg_user_id, "limit": 200}) or {}
                workouts = str0.get("workouts") if isinstance(str0, dict) else None
                wlist = [w for w in workouts if isinstance(w, dict)] if isinstance(workouts, list) else []
                tz = ZoneInfo(tz_name or "UTC")

                def _parse_iso2(s: Any) -> Optional[datetime]:
                    if not isinstance(s, str) or not s.strip():
                        return None
                    try:
                        return datetime.fromisoformat(s.strip().replace("Z", "+00:00")).astimezone(timezone.utc)
                    except Exception:
                        return None

                day_workouts: list[dict[str, Any]] = []
                for w in wlist:
                    started = _parse_iso2(w.get("started_at_iso")) or _parse_iso2(w.get("ended_at_iso"))
                    if not started:
                        continue
                    if started.astimezone(tz).date().isoformat() != date_iso:
                        continue
                    day_workouts.append(w)

                for w in day_workouts[:10]:
                    try:
                        await _weight_call_json(
                            "weight_ingest_workout",
                            {
                                "scope": scope,
                                "source": "strava",
                                "workoutId": str(w.get("workout_id") or w.get("id") or "").strip(),
                                "startedAtISO": w.get("started_at_iso") or w.get("ended_at_iso"),
                                "activityType": w.get("activity_type"),
                                "durationSeconds": w.get("duration_seconds"),
                                "distanceMeters": w.get("distance_meters"),
                                "activeEnergyKcal": w.get("active_energy_kcal"),
                                "raw": {"metadata_json": w.get("metadata_json")},
                            },
                        )
                    except Exception:
                        pass
                day1 = await _weight_call_json("weight_day_summary", {"scope": scope, "dateISO": date_iso, "tzName": tz_name}) or {}
                totals1 = day1.get("totals") if isinstance(day1, dict) else None
                totals1 = totals1 if isinstance(totals1, dict) else {}
                ex2 = totals1.get("exercise_kcal")
                if isinstance(ex2, (int, float)):
                    ex_out = float(ex2)

        answer = f"For **{date_iso}** ({tz_name}), your **exercise burn** is **{int(round(ex_out))} kcal**."
        if thread_id:
            await _memory_append(thread_id, "user", msg)
            await _memory_append(thread_id, "assistant", answer)
        return Output(answer=answer, citations=[], goalBundle=base_goal_bundle, data={"asOfISO": _now_iso(), "dateISO": date_iso, "exercise_kcal": ex_out})

    # Deterministic: today's food + exercise summary (consistent intake + spent + net).
    if fitness_intent == "food_exercise_day":
        scope = _weight_scope_from_session(input.session)
        if not scope:
            answer = "I can summarize meals + exercise, but I need you signed in with Telegram."
            if thread_id:
                await _memory_append(thread_id, "user", msg)
                await _memory_append(thread_id, "assistant", answer)
            return Output(answer=answer, citations=[], uiActions=[])

        tz_name = (input.session.timezone if input.session and input.session.timezone else None) or "America/Denver"
        tz = ZoneInfo(tz_name or "UTC")
        date_iso = _resolve_date_iso_with_context(msg, tz_name, base_goal_bundle)
        _set_last_date_context(base_goal_bundle, date_iso, tz_name)
        from_iso, to_iso = _day_window_utc_from_local_date(date_iso, tz_name)

        intake = {"calories": 0.0, "protein_g": 0.0, "carbs_g": 0.0, "fat_g": 0.0}
        tg_user_id = _session_telegram_user_id(input.session)

        # Prefer GraphDB for intake (food)
        if _fitnesscore_use_graphdb() and tg_user_id:
            g = _fitnesscore_graph_iri_for_telegram_user_id(str(tg_user_id))
            q_food = f"""
PREFIX fc: <https://ontology.fitnesscore.ai/fc#>
PREFIX prov: <http://www.w3.org/ns/prov#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?cal ?p ?c ?f WHERE {{
  GRAPH <{g}> {{
    ?e a fc:FoodEntry ;
      prov:generatedAtTime ?t .
    OPTIONAL {{ ?e fc:caloriesKcal ?cal . }}
    OPTIONAL {{ ?e fc:proteinGrams ?p . }}
    OPTIONAL {{ ?e fc:carbsGrams ?c . }}
    OPTIONAL {{ ?e fc:fatGrams ?f . }}
    FILTER(?t >= "{_sparql_iso_dt(from_iso)}"^^xsd:dateTime && ?t < "{_sparql_iso_dt(to_iso)}"^^xsd:dateTime)
  }}
}}
""".strip()
            out_food = await _fitnesscore_graphdb_select(q_food)
            results_food = out_food.get("results") if isinstance(out_food, dict) else None
            rows_food = _sparql_bindings_rows(results_food)
            for b in rows_food:
                for (var, key) in [("cal", "calories"), ("p", "protein_g"), ("c", "carbs_g"), ("f", "fat_g")]:
                    v = _sparql_get_val(b, var)
                    if v is None:
                        continue
                    try:
                        intake[key] += float(v)
                    except Exception:
                        pass

        # Fallback to Weight MCP for intake
        if intake["calories"] <= 0.0:
            food0 = await _weight_call_json("weight_list_food", {"scope": scope, "fromISO": from_iso, "toISO": to_iso, "limit": 500}) or {}
            items = food0.get("items") if isinstance(food0, dict) else None
            items_list = [it for it in items if isinstance(it, dict)] if isinstance(items, list) else []
            for it in items_list:
                for k in ["calories", "protein_g", "carbs_g", "fat_g"]:
                    v = it.get(k)
                    if isinstance(v, (int, float)):
                        intake[k] += float(v)

        # Latest weight (for burn estimate) is stored in profile (wm_profiles.profile_json).
        prof0 = await _weight_call_json("weight_profile_get", {"scope": scope}) or {}
        prof = prof0.get("profile") if isinstance(prof0, dict) else None
        prof = prof if isinstance(prof, dict) else {}
        latest_kg: Optional[float] = None
        if isinstance(prof.get("weight_kg"), (int, float)):
            latest_kg = float(prof.get("weight_kg"))
        elif isinstance(prof.get("weight_lb"), (int, float)):
            latest_kg = float(prof.get("weight_lb")) * 0.45359237

        # If user provided "220 lb" etc, use that.
        kg_from_text, lb_from_text = _parse_weight_from_text(msg)
        if kg_from_text is not None:
            latest_kg = float(kg_from_text)
        elif lb_from_text is not None:
            latest_kg = float(lb_from_text) * 0.45359237

        # Exercise (today) - prefer GraphDB, fallback Strava MCP
        if not tg_user_id:
            answer = "I can list workouts, but I need you signed in with Telegram."
            if thread_id:
                await _memory_append(thread_id, "user", msg)
                await _memory_append(thread_id, "assistant", answer)
            return Output(answer=answer, citations=[], uiActions=[])
        wlist: list[dict[str, Any]] = []
        if _fitnesscore_use_graphdb():
            g = _fitnesscore_graph_iri_for_telegram_user_id(str(tg_user_id))
            q_w = f"""
PREFIX fc: <https://ontology.fitnesscore.ai/fc#>
PREFIX prov: <http://www.w3.org/ns/prov#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?activityType ?started ?activeEnergyKcal ?durationSeconds ?distanceMeters WHERE {{
  GRAPH <{g}> {{
    ?w a fc:Workout ;
      prov:startedAtTime ?started .
    OPTIONAL {{ ?w fc:activityType ?activityType . }}
    OPTIONAL {{ ?w fc:activeEnergyKcal ?activeEnergyKcal . }}
    OPTIONAL {{ ?w fc:durationSeconds ?durationSeconds . }}
    OPTIONAL {{ ?w fc:distanceMeters ?distanceMeters . }}
    FILTER(?started >= "{_sparql_iso_dt(from_iso)}"^^xsd:dateTime && ?started < "{_sparql_iso_dt(to_iso)}"^^xsd:dateTime)
  }}
}} ORDER BY ?started
""".strip()
            out_w = await _fitnesscore_graphdb_select(q_w)
            results_w = out_w.get("results") if isinstance(out_w, dict) else None
            rows_w = _sparql_bindings_rows(results_w)
            for b in rows_w:
                wlist.append(
                    {
                        "activity_type": _sparql_get_val(b, "activityType"),
                        "started_at_iso": _sparql_get_val(b, "started"),
                        "active_energy_kcal": _sparql_get_val(b, "activeEnergyKcal"),
                        "duration_seconds": _sparql_get_val(b, "durationSeconds"),
                        "distance_meters": _sparql_get_val(b, "distanceMeters"),
                    }
                )

        if not wlist:
            str0 = await _strava_call_json("strava_list_workouts", {"telegramUserId": tg_user_id, "limit": 200}) or {}
            workouts = str0.get("workouts") if isinstance(str0, dict) else None
            wlist = [w for w in workouts if isinstance(w, dict)] if isinstance(workouts, list) else []

        def _parse_iso(s: Any) -> Optional[datetime]:
            if not isinstance(s, str) or not s.strip():
                return None
            try:
                return datetime.fromisoformat(s.strip().replace("Z", "+00:00")).astimezone(timezone.utc)
            except Exception:
                return None

        today_workouts: list[dict[str, Any]] = []
        burn_kcal = 0.0
        for w in wlist:
            started = _parse_iso(w.get("started_at_iso")) or _parse_iso(w.get("ended_at_iso"))
            if not started:
                continue
            if started.astimezone(tz).date().isoformat() != date_iso:
                continue
            today_workouts.append(w)
            kcal = _num(w.get("active_energy_kcal"))
            if kcal is not None:
                burn_kcal += float(kcal)
            else:
                # Recalc using ~1.0 kcal/kg/km if distance available.
                dist_m = _num(w.get("distance_meters"))
                if latest_kg is not None and dist_m is not None and float(dist_m) > 0:
                    km = float(dist_m) / 1000.0
                    burn_kcal += latest_kg * km * 1.0

        net = intake["calories"] - burn_kcal
        lines = [
            f"Today ({date_iso}, {tz_name}) summary:",
            f"- Intake: **{int(round(intake['calories']))} kcal** (P {intake['protein_g']:.1f}g / C {intake['carbs_g']:.1f}g / F {intake['fat_g']:.1f}g)",
            f"- Exercise burn (today): **{int(round(burn_kcal))} kcal**" + (f" (using {latest_kg:.1f} kg)" if latest_kg is not None else ""),
            f"- Net (intake − exercise): **{int(round(net))} kcal**",
        ]
        if today_workouts:
            lines.append("\nWorkouts today:")
            for w in today_workouts[:6]:
                typ = str(w.get("activity_type") or "Workout").strip() or "Workout"
                started = _parse_iso(w.get("started_at_iso"))
                started_local = started.astimezone(tz).strftime("%H:%M") if started else ""
                dist_m = w.get("distance_meters")
                dist_m_num = _num(dist_m)
                dist_s = f"{float(dist_m_num)/1609.34:.1f} mi" if dist_m_num is not None and float(dist_m_num) > 0 else ""
                dur_s = w.get("duration_seconds")
                dur_out = ""
                try:
                    s = int(_int(dur_s) or 0)
                    m = s // 60
                    dur_out = f"{m}m" if m < 60 else f"{m//60}h{m%60:02d}m"
                except Exception:
                    dur_out = ""
                bits = " • ".join([b for b in [started_local, dist_s, dur_out] if b])
                lines.append(f"- {typ}" + (f" ({bits})" if bits else ""))
        answer = "\n".join(lines).strip()
        if thread_id:
            await _memory_append(thread_id, "user", msg)
            await _memory_append(thread_id, "assistant", answer)
        return Output(
            answer=answer,
            citations=[],
            goalBundle=base_goal_bundle,
            data={
                "asOfISO": _now_iso(),
                "dateISO": date_iso,
                "fromISO": from_iso,
                "toISO": to_iso,
                "intake": intake,
                "burn_kcal": burn_kcal,
                "net_kcal": net,
                "workoutsTodayCount": len(today_workouts),
            },
        )

    # Deterministic: exercise-focused "today overview" still includes intake for consistency.
    if fitness_intent == "exercise_overview_day":
        scope = _weight_scope_from_session(input.session)
        if not scope:
            answer = "I can summarize meals + exercise, but I need you signed in with Telegram."
            if thread_id:
                await _memory_append(thread_id, "user", msg)
                await _memory_append(thread_id, "assistant", answer)
            return Output(answer=answer, citations=[], uiActions=[])

        tz_name = (input.session.timezone if input.session and input.session.timezone else None) or "America/Denver"
        tz = ZoneInfo(tz_name or "UTC")
        date_iso = _resolve_date_iso_with_context(msg, tz_name, base_goal_bundle)
        _set_last_date_context(base_goal_bundle, date_iso, tz_name)
        from_iso, to_iso = _day_window_utc_from_local_date(date_iso, tz_name)

        # Pull profile for TDEE inputs (age/sex/height/activity_level).
        prof_raw = await _weight_call_json("weight_profile_get", {"scope": scope})
        profile_tool_ok = prof_raw is not None
        prof0 = prof_raw or {}
        prof = prof0.get("profile") if isinstance(prof0, dict) else None
        prof = prof if isinstance(prof, dict) else {}

        age = int(_num(prof.get("age")) or 0) if _num(prof.get("age")) is not None else None
        sex = str(prof.get("sex") or "").strip().lower()
        height_in = _num(prof.get("height_in"))
        activity = str(prof.get("activity_level") or "").strip().lower()

        tg_user_id = _session_telegram_user_id(input.session)

        # Intake (food) - prefer GraphDB
        intake_kcal = 0.0
        if _fitnesscore_use_graphdb() and tg_user_id:
            g = _fitnesscore_graph_iri_for_telegram_user_id(str(tg_user_id))
            q_in = f"""
PREFIX fc: <https://ontology.fitnesscore.ai/fc#>
PREFIX prov: <http://www.w3.org/ns/prov#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT (SUM(?k) AS ?kcalTotal) WHERE {{
  GRAPH <{g}> {{
    ?e a fc:FoodEntry ;
      prov:generatedAtTime ?t ;
      fc:caloriesKcal ?k .
    FILTER(?t >= "{_sparql_iso_dt(from_iso)}"^^xsd:dateTime && ?t < "{_sparql_iso_dt(to_iso)}"^^xsd:dateTime)
  }}
}}
""".strip()
            out_in = await _fitnesscore_graphdb_select(q_in)
            results_in = out_in.get("results") if isinstance(out_in, dict) else None
            rows_in = _sparql_bindings_rows(results_in)
            if rows_in:
                v = _sparql_get_val(rows_in[0], "kcalTotal")
                n = _num(v)
                if n is not None:
                    intake_kcal = float(n)

        if intake_kcal <= 0.0:
            food0 = await _weight_call_json("weight_list_food", {"scope": scope, "fromISO": from_iso, "toISO": to_iso, "limit": 500}) or {}
            items = food0.get("items") if isinstance(food0, dict) else None
            items_list = [it for it in items if isinstance(it, dict)] if isinstance(items, list) else []
            intake_kcal = sum(float(_num(it.get("calories")) or 0.0) for it in items_list if _num(it.get("calories")) is not None)

        # Body weight (kg) for workout burn estimate (from profile; wm_weights removed).
        prof0 = await _weight_call_json("weight_profile_get", {"scope": scope}) or {}
        prof = prof0.get("profile") if isinstance(prof0, dict) else None
        prof = prof if isinstance(prof, dict) else {}
        kg: Optional[float] = None
        if isinstance(prof.get("weight_kg"), (int, float)):
            kg = float(prof.get("weight_kg"))
        elif isinstance(prof.get("weight_lb"), (int, float)):
            kg = float(prof.get("weight_lb")) * 0.45359237
        kg_from_text, lb_from_text = _parse_weight_from_text(msg)
        if kg_from_text is not None:
            kg = float(kg_from_text)
        elif lb_from_text is not None:
            kg = float(lb_from_text) * 0.45359237
        assumed_weight = False
        if kg is None:
            # Fall back to a default if we have distance but no weight available.
            # We will explicitly label this as an assumption in the answer.
            kg = 99.8  # 220 lb
            assumed_weight = True

        # Exercise (today) - prefer GraphDB, fallback Strava
        if not tg_user_id:
            answer = "I can list workouts, but I need you signed in with Telegram."
            if thread_id:
                await _memory_append(thread_id, "user", msg)
                await _memory_append(thread_id, "assistant", answer)
            return Output(answer=answer, citations=[], uiActions=[])
        wlist: list[dict[str, Any]] = []
        if _fitnesscore_use_graphdb():
            g = _fitnesscore_graph_iri_for_telegram_user_id(str(tg_user_id))
            q_w = f"""
PREFIX fc: <https://ontology.fitnesscore.ai/fc#>
PREFIX prov: <http://www.w3.org/ns/prov#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?activityType ?started ?activeEnergyKcal ?durationSeconds ?distanceMeters WHERE {{
  GRAPH <{g}> {{
    ?w a fc:Workout ;
      prov:startedAtTime ?started .
    OPTIONAL {{ ?w fc:activityType ?activityType . }}
    OPTIONAL {{ ?w fc:activeEnergyKcal ?activeEnergyKcal . }}
    OPTIONAL {{ ?w fc:durationSeconds ?durationSeconds . }}
    OPTIONAL {{ ?w fc:distanceMeters ?distanceMeters . }}
    FILTER(?started >= "{_sparql_iso_dt(from_iso)}"^^xsd:dateTime && ?started < "{_sparql_iso_dt(to_iso)}"^^xsd:dateTime)
  }}
}} ORDER BY ?started
""".strip()
            out_w = await _fitnesscore_graphdb_select(q_w)
            results_w = out_w.get("results") if isinstance(out_w, dict) else None
            rows_w = _sparql_bindings_rows(results_w)
            for b in rows_w:
                wlist.append(
                    {
                        "activity_type": _sparql_get_val(b, "activityType"),
                        "started_at_iso": _sparql_get_val(b, "started"),
                        "active_energy_kcal": _sparql_get_val(b, "activeEnergyKcal"),
                        "duration_seconds": _sparql_get_val(b, "durationSeconds"),
                        "distance_meters": _sparql_get_val(b, "distanceMeters"),
                    }
                )

        if not wlist:
            str0 = await _strava_call_json("strava_list_workouts", {"telegramUserId": tg_user_id, "limit": 200}) or {}
            workouts = str0.get("workouts") if isinstance(str0, dict) else None
            wlist = [w for w in workouts if isinstance(w, dict)] if isinstance(workouts, list) else []

        def _parse_iso(s: Any) -> Optional[datetime]:
            if not isinstance(s, str) or not s.strip():
                return None
            try:
                return datetime.fromisoformat(s.strip().replace("Z", "+00:00")).astimezone(timezone.utc)
            except Exception:
                return None

        today_workouts: list[dict[str, Any]] = []
        burn_kcal = 0.0
        for w in wlist:
            started = _parse_iso(w.get("started_at_iso")) or _parse_iso(w.get("ended_at_iso"))
            if not started:
                continue
            if started.astimezone(tz).date().isoformat() != date_iso:
                continue
            today_workouts.append(w)
            kcal = _num(w.get("active_energy_kcal"))
            if kcal is not None:
                burn_kcal += float(kcal)
            else:
                dist_m = _num(w.get("distance_meters"))
                if kg is not None and dist_m is not None and float(dist_m) > 0:
                    burn_kcal += kg * (float(dist_m) / 1000.0) * 1.0

        # Estimate BMR/TDEE if profile present.
        bmr = None
        tdee = None
        if kg is not None and height_in is not None and age is not None and sex in {"male", "female"}:
            cm = float(height_in) * 2.54
            s = 5 if sex == "male" else -161
            bmr = 10.0 * float(kg) + 6.25 * cm - 5.0 * float(age) + float(s)
            mult = {
                "sedentary": 1.2,
                "light": 1.375,
                "moderate": 1.55,
                "very_active": 1.725,
            }.get(activity)
            if mult:
                tdee = bmr * mult

        net_vs_exercise = intake_kcal - burn_kcal
        lines = [
            f"Today ({date_iso}, {tz_name}) calorie overview:",
            f"- Calories in (food): **{int(round(intake_kcal))} kcal**",
            f"- Calories out (workouts today): **{int(round(burn_kcal))} kcal**"
            + (f" (using {kg:.1f} kg{' assumed (220 lb)' if assumed_weight else ''})" if kg is not None else ""),
            f"- Net (in − workouts): **{int(round(net_vs_exercise))} kcal**",
        ]
        if tdee is not None:
            lines.append(f"- Est. TDEE (profile): **{int(round(tdee))} kcal/day** (activity={activity})")
        else:
            if not profile_tool_ok:
                lines.append("- Est. TDEE (profile): unavailable (weight_profile_get tool not loaded in this deployment).")
            else:
                lines.append("- Est. TDEE (profile): missing age/sex/height/activity_level in profile.")

        if today_workouts:
            lines.append("\nWorkouts today:")
            for w in today_workouts[:6]:
                typ = str(w.get("activity_type") or "Workout").strip() or "Workout"
                started = _parse_iso(w.get("started_at_iso"))
                started_local = started.astimezone(tz).strftime("%H:%M") if started else ""
                dist_m = w.get("distance_meters")
                dist_m_num = _num(dist_m)
                dist_s = f"{float(dist_m_num)/1609.34:.1f} mi" if dist_m_num is not None and float(dist_m_num) > 0 else ""
                dur_s = w.get("duration_seconds")
                dur_out = ""
                try:
                    s = int(_int(dur_s) or 0)
                    m = s // 60
                    dur_out = f"{m}m" if m < 60 else f"{m//60}h{m%60:02d}m"
                except Exception:
                    dur_out = ""
                bits = " • ".join([b for b in [started_local, dist_s, dur_out] if b])
                lines.append(f"- {typ}" + (f" ({bits})" if bits else ""))

        answer = "\n".join(lines).strip()
        if thread_id:
            await _memory_append(thread_id, "user", msg)
            await _memory_append(thread_id, "assistant", answer)
        return Output(
            answer=answer,
            citations=[],
            goalBundle=base_goal_bundle if had_session_goal_bundle else None,
            data={"asOfISO": _now_iso(), "dateISO": date_iso, "intake_kcal": intake_kcal, "burn_kcal": burn_kcal, "tdee_kcal": tdee},
        )

    # Deterministic: list all Strava workouts for today.
    if fitness_intent == "workouts_day":
        tz_name = (input.session.timezone if input.session and input.session.timezone else None) or "America/Denver"
        tz = ZoneInfo(tz_name or "UTC")
        date_iso = _resolve_date_iso_with_context(msg, tz_name, base_goal_bundle)
        _set_last_date_context(base_goal_bundle, date_iso, tz_name)

        tg_user_id = _session_telegram_user_id(input.session)
        if not tg_user_id:
            answer = "I can list workouts, but I need you signed in with Telegram."
            if thread_id:
                await _memory_append(thread_id, "user", msg)
                await _memory_append(thread_id, "assistant", answer)
            return Output(answer=answer, citations=[], uiActions=[])
        today_workouts: list[dict[str, Any]] = []
        if _fitnesscore_use_graphdb():
            from_iso, to_iso = _day_window_utc_from_local_date(date_iso, tz_name)
            g = _fitnesscore_graph_iri_for_telegram_user_id(str(tg_user_id))
            q = f"""
PREFIX fc: <https://ontology.fitnesscore.ai/fc#>
PREFIX prov: <http://www.w3.org/ns/prov#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?activityType ?started ?durationSeconds ?distanceMeters ?activeEnergyKcal WHERE {{
  GRAPH <{g}> {{
    ?w a fc:Workout ;
      prov:startedAtTime ?started .
    OPTIONAL {{ ?w fc:activityType ?activityType . }}
    OPTIONAL {{ ?w fc:durationSeconds ?durationSeconds . }}
    OPTIONAL {{ ?w fc:distanceMeters ?distanceMeters . }}
    OPTIONAL {{ ?w fc:activeEnergyKcal ?activeEnergyKcal . }}
    FILTER(?started >= "{_sparql_iso_dt(from_iso)}"^^xsd:dateTime && ?started < "{_sparql_iso_dt(to_iso)}"^^xsd:dateTime)
  }}
}} ORDER BY DESC(?started)
""".strip()
            out = await _fitnesscore_graphdb_select(q)
            results = out.get("results") if isinstance(out, dict) else None
            rows = _sparql_bindings_rows(results)
            for b in rows:
                today_workouts.append(
                    {
                        "activity_type": _sparql_get_val(b, "activityType"),
                        "started_at_iso": _sparql_get_val(b, "started"),
                        "duration_seconds": _sparql_get_val(b, "durationSeconds"),
                        "distance_meters": _sparql_get_val(b, "distanceMeters"),
                        "active_energy_kcal": _sparql_get_val(b, "activeEnergyKcal"),
                        "metadata_json": None,
                    }
                )

        # Fallback: Strava MCP
        if not today_workouts:
            data0 = await _strava_call_json("strava_list_workouts", {"telegramUserId": tg_user_id, "limit": 200}) or {}
            workouts = data0.get("workouts") if isinstance(data0, dict) else None
            wlist = [w for w in workouts if isinstance(w, dict)] if isinstance(workouts, list) else []

        def _parse_iso(s: Any) -> Optional[datetime]:
            if not isinstance(s, str) or not s.strip():
                return None
            try:
                return datetime.fromisoformat(s.strip().replace("Z", "+00:00")).astimezone(timezone.utc)
            except Exception:
                return None

        if not today_workouts:
            for w in wlist:
                started = _parse_iso(w.get("started_at_iso")) or _parse_iso(w.get("ended_at_iso"))
                if not started:
                    continue
                if started.astimezone(tz).date().isoformat() != date_iso:
                    continue
                today_workouts.append(w)

        if not today_workouts:
            day_word = "today" if "today" in mlow else "yesterday" if "yesterday" in mlow else "that day"
            answer = f"I’m not seeing any workouts for {day_word} ({date_iso}, {tz_name}) in your connected Strava data."
            if thread_id:
                await _memory_append(thread_id, "user", msg)
                await _memory_append(thread_id, "assistant", answer)
            return Output(answer=answer, citations=[], data={"asOfISO": _now_iso(), "dateISO": date_iso, "count": 0})

        # Most recent first (Strava MCP returns most recent first; keep that).
        if "yesterday" in mlow:
            header = f"Yesterday you did ({date_iso}, {tz_name}):"
        elif "today" in mlow:
            header = f"Today you did ({date_iso}, {tz_name}):"
        else:
            header = f"For {date_iso} ({tz_name}), you did:"
        lines = [header]

        def _fmt_duration(sec: Any) -> str:
            s = _int(sec)
            if s is None:
                return ""
            m = s // 60
            ss = s % 60
            if m < 60:
                return f"{m}:{ss:02d}"
            return f"{m//60}:{m%60:02d}:{ss:02d}"

        for w in today_workouts[:10]:
            typ = str(w.get("activity_type") or "Workout").strip() or "Workout"
            started = _parse_iso(w.get("started_at_iso")) or _parse_iso(w.get("ended_at_iso"))
            started_local = started.astimezone(tz).strftime("%H:%M") if started else ""

            # Optional name from metadata_json (Strava MCP stores {"name", "sport_type"}).
            name = ""
            meta = w.get("metadata_json")
            if isinstance(meta, str) and meta.strip():
                try:
                    mj = json.loads(meta)
                    if isinstance(mj, dict) and isinstance(mj.get("name"), str) and str(mj.get("name")).strip():
                        name = str(mj.get("name")).strip()
                except Exception:
                    name = ""

            dist_m = w.get("distance_meters")
            dist_s = ""
            dist_m_num = _num(dist_m)
            if dist_m_num is not None and float(dist_m_num) > 0:
                km = float(dist_m_num) / 1000.0
                dist_s = f"{km:.2f} km"

            dur_s = _fmt_duration(w.get("duration_seconds"))
            bits = " • ".join([b for b in [started_local, dist_s, dur_s] if b])
            label = f"{typ}" + (f" “{name}”" if name else "")
            lines.append(f"- {label}" + (f" ({bits})" if bits else ""))

        answer = "\n".join(lines).strip()
        if thread_id:
            await _memory_append(thread_id, "user", msg)
            await _memory_append(thread_id, "assistant", answer)
        return Output(answer=answer, citations=[], goalBundle=base_goal_bundle, data={"asOfISO": _now_iso(), "dateISO": date_iso, "count": len(today_workouts)})

    # Deterministic: workouts summary (past few days / last week).
    if fitness_intent == "workouts_trend":
        tz_name = (input.session.timezone if input.session and input.session.timezone else None) or "America/Denver"
        tz = ZoneInfo(tz_name or "UTC")
        days = 7 if ("week" in mlow or "7" in mlow) else 3
        cutoff = datetime.now(tz=timezone.utc) - timedelta(days=days)

        tg_user_id = _session_telegram_user_id(input.session)
        if not tg_user_id:
            return Output(answer="I need you signed in with Telegram to do that.", citations=[], data={"error": "missing_telegram_user_id"})

        if _fitnesscore_use_graphdb():
            g = _fitnesscore_graph_iri_for_telegram_user_id(str(tg_user_id))
            q = f"""
PREFIX fc: <https://ontology.fitnesscore.ai/fc#>
PREFIX prov: <http://www.w3.org/ns/prov#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?activityType ?started ?durationSeconds ?distanceMeters WHERE {{
  GRAPH <{g}> {{
    ?w a fc:Workout ;
      prov:startedAtTime ?started .
    OPTIONAL {{ ?w fc:activityType ?activityType . }}
    OPTIONAL {{ ?w fc:durationSeconds ?durationSeconds . }}
    OPTIONAL {{ ?w fc:distanceMeters ?distanceMeters . }}
    FILTER(?started >= "{_sparql_iso_dt(cutoff.isoformat())}"^^xsd:dateTime)
  }}
}} ORDER BY DESC(?started) LIMIT 200
""".strip()
            out = await _fitnesscore_graphdb_select(q)
            results = out.get("results") if isinstance(out, dict) else None
            rows = _sparql_bindings_rows(results)
            if rows:
                def _fmt_duration(sec: Any) -> str:
                    s = _int(sec)
                    if s is None:
                        return ""
                    m = s // 60
                    if m < 60:
                        return f"{m}m"
                    return f"{m//60}h{m%60:02d}m"

                lines = [f"Workouts (last {days} days):"]
                for b in rows[:10]:
                    typ = str(_sparql_get_val(b, "activityType") or "Workout").strip() or "Workout"
                    started = _parse_iso(_sparql_get_val(b, "started"))
                    started_local = ""
                    if started:
                        try:
                            started_local = started.astimezone(tz).strftime("%a %H:%M")
                        except Exception:
                            started_local = started.astimezone(tz).strftime("%Y-%m-%d %H:%M")
                    dist_m_num = _num(_sparql_get_val(b, "distanceMeters"))
                    dist_s = f"{float(dist_m_num)/1609.34:.1f} mi" if dist_m_num is not None and dist_m_num > 0 else ""
                    dur_s = _fmt_duration(_sparql_get_val(b, "durationSeconds"))
                    bits = " • ".join([x for x in [started_local, dist_s, dur_s] if x])
                    lines.append(f"- {typ}" + (f" ({bits})" if bits else ""))

                answer = "\n".join(lines).strip()
                if thread_id:
                    await _memory_append(thread_id, "user", msg)
                    await _memory_append(thread_id, "assistant", answer)
                return Output(
                    answer=answer,
                    citations=[],
                    goalBundle=base_goal_bundle if had_session_goal_bundle else None,
                    data={"asOfISO": _now_iso(), "count": len(rows), "days": days},
                )

        data0 = await _strava_call_json("strava_list_workouts", {"telegramUserId": tg_user_id, "limit": 200})
        if data0 is None:
            answer = (
                "Strava MCP isn't connected in this deployment, so I can't fetch your workout list. "
                "Fix: add the strava worker to MCP_SERVERS_JSON and include strava_strava_list_workouts in MCP_TOOL_ALLOWLIST."
            )
            if thread_id:
                await _memory_append(thread_id, "user", msg)
                await _memory_append(thread_id, "assistant", answer)
            return Output(answer=answer, citations=[], data={"asOfISO": _now_iso()})

        data = data0 or {}
        workouts = data.get("workouts") if isinstance(data, dict) else None
        if not isinstance(workouts, list) or not workouts:
            answer = f"No workouts found in the past {days} days."
            if thread_id:
                await _memory_append(thread_id, "user", msg)
                await _memory_append(thread_id, "assistant", answer)
            return Output(
                answer=answer,
                citations=[],
                goalBundle=base_goal_bundle if had_session_goal_bundle else None,
                data={"asOfISO": _now_iso(), "count": 0},
            )

        def _parse_iso(s: Any) -> Optional[datetime]:
            if not isinstance(s, str) or not s.strip():
                return None
            try:
                return datetime.fromisoformat(s.strip().replace("Z", "+00:00")).astimezone(timezone.utc)
            except Exception:
                return None

        recent: list[dict[str, Any]] = []
        for w in workouts:
            if not isinstance(w, dict):
                continue
            dt = _parse_iso(w.get("ended_at_iso")) or _parse_iso(w.get("started_at_iso"))
            if dt and dt >= cutoff:
                recent.append(w)

        if not recent:
            answer = f"No workouts found in the past {days} days."
            if thread_id:
                await _memory_append(thread_id, "user", msg)
                await _memory_append(thread_id, "assistant", answer)
            return Output(
                answer=answer,
                citations=[],
                goalBundle=base_goal_bundle if had_session_goal_bundle else None,
                data={"asOfISO": _now_iso(), "count": 0},
            )

        def _fmt_duration(sec: Any) -> str:
            s = _int(sec)
            if s is None:
                return ""
            m = s // 60
            if m < 60:
                return f"{m}m"
            return f"{m//60}h{m%60:02d}m"

        lines = [f"Workouts (last {days} days):"]
        for w in recent[:10]:
            typ = str(w.get("activity_type") or "Workout").strip() or "Workout"
            started = _parse_iso(w.get("started_at_iso"))
            # Show local start time (timezone-aware) to avoid confusing duration for a timestamp.
            started_local = ""
            if started:
                try:
                    started_local = started.astimezone(tz).strftime("%a %H:%M")
                except Exception:
                    started_local = started.astimezone(tz).strftime("%Y-%m-%d %H:%M")
            dist_m = w.get("distance_meters")
            dist_s = ""
            dist_m_num = _num(dist_m)
            if dist_m_num is not None and dist_m_num > 0:
                dist_s = f"{dist_m_num/1609.34:.1f} mi"
            dur_s = _fmt_duration(w.get("duration_seconds"))
            bits = " • ".join([b for b in [started_local, dist_s, dur_s] if b])
            lines.append(f"- {typ}" + (f" ({bits})" if bits else ""))

        answer = "\n".join(lines).strip()
        if thread_id:
            await _memory_append(thread_id, "user", msg)
            await _memory_append(thread_id, "assistant", answer)
        return Output(
            answer=answer,
            citations=[],
            goalBundle=base_goal_bundle if had_session_goal_bundle else None,
            data={"asOfISO": _now_iso(), "count": len(recent)},
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
        out = await _handle_checkout(input.session)
        if thread_id:
            await _memory_append(thread_id, "user", msg)
            await _memory_append(thread_id, "assistant", out.answer)
        return out
    if msg.startswith("__RESERVE_CLASS__:"):
        class_id = msg.split(":", 1)[1].strip()
        out = await _handle_reserve_class(input.session, class_id)
        if thread_id:
            await _memory_append(thread_id, "user", msg)
            await _memory_append(thread_id, "assistant", out.answer)
        return out

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

    history: list[Any] = []
    if thread_id:
        mem = await _core_call_json("core_memory_list_messages", {"threadId": thread_id, "limit": 12}) or {}
        msgs = mem.get("messages") if isinstance(mem, dict) else None
        if isinstance(msgs, list):
            for m in msgs:
                if not isinstance(m, dict):
                    continue
                role = str(m.get("role") or "")
                content = str(m.get("content") or "")
                if not content.strip():
                    continue
                # Avoid echoing deterministic control messages into context.
                if content.strip().startswith("__"):
                    continue
                if role == "user":
                    history.append(HumanMessage(content=content))
                elif role == "assistant":
                    history.append(AIMessage(content=content))

    messages: list[Any] = [
        SystemMessage(content=build_system_prompt()),
        SystemMessage(content=build_session_prompt(input.session)),
        *history,
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

    # Extract optional UI/cart/goal directives (order: UI, cart actions, goal bundle, legacy cart items)
    txt, ui_actions = _extract_json_line(raw, "UIActionsJSON:")
    txt, cart_actions = _extract_json_line(txt, "CartActionsJSON:")
    txt, goal_bundle_raw = _extract_json_line(txt, "GoalBundleJSON:")
    answer, suggested = _extract_cart(txt)
    goal_out = goal_bundle_raw if isinstance(goal_bundle_raw, dict) else None
    if goal_out and isinstance(goal_out.get("actionPlan"), list) and not goal_out.get("trainingPlan"):
        goal_out = {**goal_out, "trainingPlan": goal_out["actionPlan"]}

    # Persist Telegram meal import cursor + confirmations via GoalBundle.integrations.
    if isinstance(goal_out, dict):
        if isinstance(base_goal_bundle.get("integrations"), dict) and base_goal_bundle.get("integrations"):
            goal_out = {**goal_out, "integrations": base_goal_bundle["integrations"]}
    else:
        if imported_meals or had_session_goal_bundle:
            goal_out = base_goal_bundle

    ops_freshness = None
    if trace.ops_as_of and trace.ops_endpoints:
        ops_freshness = {"asOfISO": trace.ops_as_of, "endpoints": sorted(list(trace.ops_endpoints))}

    weather_freshness = None

    if imported_weights:
        wparts = []
        for it in imported_weights[:5]:
            if not isinstance(it, dict):
                continue
            wk = it.get("weightKg")
            if isinstance(wk, (int, float)):
                wparts.append(f"{float(wk):.1f} kg")
        wsuffix = f": {', '.join(wparts)}" if wparts else ""
        answer = (answer.rstrip() + f"\n\nImported {len(imported_weights)} weigh-in(s) from Telegram (Smart Agent){wsuffix}.").strip()

    if imported_meals:
        parts = []
        for it in imported_meals[:5]:
            meal = it.get("meal") if isinstance(it, dict) else None
            summary = it.get("summary") if isinstance(it, dict) else None
            s = " ".join([str(meal or "").strip(), str(summary or "").strip()]).strip()
            if s:
                parts.append(s)
        suffix = f": {', '.join(parts)}" if parts else ""
        answer = (answer.rstrip() + f"\n\nImported {len(imported_meals)} meal log(s) from Telegram (Smart Agent){suffix}.").strip()

    if thread_id:
        await _memory_append(thread_id, "user", msg)
        await _memory_append(thread_id, "assistant", answer)

    return Output(
        answer=answer,
        citations=trace.citations,
        opsFreshness=ops_freshness,
        weatherFreshness=weather_freshness,
        suggestedCartItems=suggested,
        cartActions=cart_actions if isinstance(cart_actions, list) else None,
        uiActions=ui_actions if isinstance(ui_actions, list) else None,
        goalBundle=goal_out,
    )

