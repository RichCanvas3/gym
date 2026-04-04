from __future__ import annotations

import contextvars
import json
import os
import re
import time
from datetime import timedelta
from typing import Any, Optional, Tuple

from langchain_core.tools import BaseTool

_ENV_VAR_PATTERN = re.compile(r"\$\{([A-Z0-9_]+)\}")
_RUNTIME_MCP_OVERRIDES: contextvars.ContextVar[Optional[dict[str, Any]]] = contextvars.ContextVar(
    "runtime_mcp_overrides", default=None
)


def set_runtime_mcp_overrides(overrides: Optional[dict[str, Any]]) -> contextvars.Token[Optional[dict[str, Any]]]:
    return _RUNTIME_MCP_OVERRIDES.set(overrides if isinstance(overrides, dict) and overrides else None)


def reset_runtime_mcp_overrides(token: contextvars.Token[Optional[dict[str, Any]]]) -> None:
    _RUNTIME_MCP_OVERRIDES.reset(token)


def _truthy_env(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    v = raw.strip().lower()
    return v in {"1", "true", "yes", "y", "on"}


def _csv_set(name: str) -> set[str]:
    raw = os.environ.get(name, "")
    if not raw.strip():
        return set()
    return {p.strip() for p in raw.split(",") if p.strip()}


def _substitute_env_vars(value: str) -> str:
    def repl(m: re.Match[str]) -> str:
        key = m.group(1)
        return os.environ.get(key, "")

    return _ENV_VAR_PATTERN.sub(repl, value)


def _resolve_placeholders(obj: Any) -> Any:
    if isinstance(obj, str):
        return _substitute_env_vars(obj)
    if isinstance(obj, list):
        return [_resolve_placeholders(x) for x in obj]
    if isinstance(obj, dict):
        return {k: _resolve_placeholders(v) for k, v in obj.items()}
    return obj


def _parse_servers_json() -> Optional[dict[str, Any]]:
    raw = os.environ.get("MCP_SERVERS_JSON", "").strip()
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except Exception as e:
        raise RuntimeError(f"Invalid MCP_SERVERS_JSON: {e}") from e
    if not isinstance(parsed, dict):
        raise RuntimeError("Invalid MCP_SERVERS_JSON: must be a JSON object")
    return _resolve_placeholders(parsed)


def _apply_timeouts(servers: dict[str, Any]) -> dict[str, Any]:
    streamable_timeout_s = os.environ.get("MCP_STREAMABLE_HTTP_TIMEOUT_SECONDS")
    streamable_read_timeout_s = os.environ.get("MCP_STREAMABLE_HTTP_SSE_READ_TIMEOUT_SECONDS")

    timeout_td = None
    if streamable_timeout_s and streamable_timeout_s.strip():
        timeout_td = timedelta(seconds=max(1, int(float(streamable_timeout_s))))

    read_timeout_td = None
    if streamable_read_timeout_s and streamable_read_timeout_s.strip():
        read_timeout_td = timedelta(seconds=max(1, int(float(streamable_read_timeout_s))))

    if timeout_td is None and read_timeout_td is None:
        return servers

    out: dict[str, Any] = {}
    for name, cfg in servers.items():
        if not isinstance(cfg, dict):
            out[name] = cfg
            continue
        transport = str(cfg.get("transport", "")).strip()
        next_cfg = dict(cfg)
        if transport in {"streamable_http", "streamable-http", "http"}:
            if timeout_td is not None and "timeout" not in next_cfg:
                next_cfg["timeout"] = timeout_td
            if read_timeout_td is not None and "sse_read_timeout" not in next_cfg:
                next_cfg["sse_read_timeout"] = read_timeout_td
        out[name] = next_cfg
    return out


def _runtime_server_overrides() -> Optional[dict[str, Any]]:
    value = _RUNTIME_MCP_OVERRIDES.get()
    return value if isinstance(value, dict) and value else None


def _merge_runtime_overrides(servers: dict[str, Any], overrides: Optional[dict[str, Any]]) -> dict[str, Any]:
    if not overrides:
        return servers
    out: dict[str, Any] = {}
    for name, cfg in servers.items():
        base_cfg = dict(cfg) if isinstance(cfg, dict) else cfg
        ov = overrides.get(name) if isinstance(overrides, dict) else None
        if not isinstance(base_cfg, dict) or not isinstance(ov, dict):
            out[name] = base_cfg
            continue
        merged = dict(base_cfg)
        for key, value in ov.items():
            if key == "headers" and isinstance(value, dict):
                headers = dict(merged.get("headers") or {}) if isinstance(merged.get("headers"), dict) else {}
                headers.update(value)
                merged["headers"] = headers
            else:
                merged[key] = value
        out[name] = merged
    return out


def _filter_tools(tools: list[BaseTool]) -> list[BaseTool]:
    allow = _csv_set("MCP_TOOL_ALLOWLIST")
    deny = _csv_set("MCP_TOOL_DENYLIST")

    if allow and deny:
        # Prefer explicit allowlist
        deny = set()

    out: list[BaseTool] = []
    for t in tools:
        name = getattr(t, "name", None)
        if not isinstance(name, str) or not name:
            continue
        if allow and name not in allow:
            continue
        if deny and name in deny:
            continue
        out.append(t)
    return out


def _mcp_tools_cache_ttl_seconds() -> int:
    """
    Cache tool discovery to avoid reconnecting/handshaking every request.
    Set MCP_TOOLS_CACHE_TTL_SECONDS=0 to disable.
    """
    raw = os.environ.get("MCP_TOOLS_CACHE_TTL_SECONDS", "1800").strip()
    try:
        n = int(float(raw))
    except Exception:
        n = 1800
    return max(0, n)


def _cache_key_for_env() -> str:
    # Key off the env vars that affect tool discovery/filtering.
    parts = {
        "MCP_SERVERS_JSON": os.environ.get("MCP_SERVERS_JSON", "").strip(),
        "MCP_TOOL_NAME_PREFIX": os.environ.get("MCP_TOOL_NAME_PREFIX", "").strip(),
        "MCP_TOOL_ALLOWLIST": os.environ.get("MCP_TOOL_ALLOWLIST", "").strip(),
        "MCP_TOOL_DENYLIST": os.environ.get("MCP_TOOL_DENYLIST", "").strip(),
        "MCP_STREAMABLE_HTTP_TIMEOUT_SECONDS": os.environ.get("MCP_STREAMABLE_HTTP_TIMEOUT_SECONDS", "").strip(),
        "MCP_STREAMABLE_HTTP_SSE_READ_TIMEOUT_SECONDS": os.environ.get("MCP_STREAMABLE_HTTP_SSE_READ_TIMEOUT_SECONDS", "").strip(),
        "RUNTIME_MCP_OVERRIDES": _runtime_server_overrides(),
    }
    return json.dumps(parts, sort_keys=True)


_CACHED_TOOLS: list[BaseTool] | None = None
_CACHED_DIAG: dict[str, Any] | None = None
_CACHED_AT_MONO: float | None = None
_CACHED_KEY: str | None = None


async def load_mcp_tools_from_env() -> list[BaseTool]:
    tools, _diag = await load_mcp_tools_with_diagnostics_from_env()
    return tools


async def load_mcp_tools_with_diagnostics_from_env() -> Tuple[list[BaseTool], dict[str, Any]]:
    ttl = _mcp_tools_cache_ttl_seconds()
    runtime_overrides = _runtime_server_overrides()
    key = _cache_key_for_env()
    now = time.monotonic()
    global _CACHED_TOOLS, _CACHED_DIAG, _CACHED_AT_MONO, _CACHED_KEY
    if runtime_overrides is None and ttl > 0 and _CACHED_TOOLS is not None and _CACHED_DIAG is not None and _CACHED_AT_MONO is not None and _CACHED_KEY == key:
        if (now - _CACHED_AT_MONO) < ttl:
            return _CACHED_TOOLS, _CACHED_DIAG

    servers = _parse_servers_json()
    if not servers:
        tools0: list[BaseTool] = []
        diag0 = {"okServers": [], "failedServers": []}
        if runtime_overrides is None and ttl > 0:
            _CACHED_TOOLS, _CACHED_DIAG, _CACHED_AT_MONO, _CACHED_KEY = tools0, diag0, now, key
        return tools0, diag0

    servers = _apply_timeouts(servers)
    servers = _merge_runtime_overrides(servers, runtime_overrides)
    tool_name_prefix = _truthy_env("MCP_TOOL_NAME_PREFIX", default=True)

    try:
        from langchain_mcp_adapters.client import MultiServerMCPClient
    except Exception as e:
        raise RuntimeError(
            "MCP is configured but langchain-mcp-adapters is not installed."
        ) from e

    # Important: MultiServerMCPClient.get_tools() may use a TaskGroup and fail the entire
    # tool load if any one server is unhealthy/misconfigured. We prefer partial
    # availability: load what we can and skip failing servers.
    all_tools: list[BaseTool] = []
    ok_servers: list[dict[str, Any]] = []
    failed_servers: list[dict[str, Any]] = []
    for name, cfg in servers.items():
        try:
            client = MultiServerMCPClient({name: cfg}, tool_name_prefix=tool_name_prefix)
            tools = await client.get_tools()
            all_tools.extend(tools)
            ok_servers.append({"name": name, "toolCount": len(tools)})
        except Exception as e:
            # Skip this server; other servers may still be usable.
            failed_servers.append({"name": name, "error": f"{type(e).__name__}: {e}"})
            continue
    tools_out = _filter_tools(all_tools)
    diag_out = {"okServers": ok_servers, "failedServers": failed_servers}
    if runtime_overrides is None and ttl > 0:
        _CACHED_TOOLS, _CACHED_DIAG, _CACHED_AT_MONO, _CACHED_KEY = tools_out, diag_out, now, key
    return tools_out, diag_out

