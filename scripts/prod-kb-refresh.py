import os
from pathlib import Path
import sys


def _load_env_local_if_needed() -> None:
    """
    Convenience for local/prod-like runs.
    We load vars from apps/web/.env.local as defaults so ${VAR} placeholders
    inside MCP_SERVERS_JSON can be resolved.
    """

    env_path = Path(__file__).resolve().parents[1] / "apps" / "web" / ".env.local"
    if not env_path.exists():
        return

    vals: dict[str, str] = {}
    for line in env_path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, v = s.split("=", 1)
        vals[k.strip()] = v

    for k, v in vals.items():
        os.environ.setdefault(k, v)


def main() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(repo_root))

    _load_env_local_if_needed()
    os.environ.setdefault("KB_INCLUDE_LOCAL_MARKDOWN", "1")
    os.environ.setdefault("KB_PERSIST_TO_CORE", "1")
    os.environ.setdefault("KB_INDEX_TTL_SECONDS", "0")

    from apps.api.knowledge_index import ensure_index_with_mcp  # noqa: WPS433

    import asyncio

    async def run() -> None:
        idx = await ensure_index_with_mcp(ttl_seconds=0)
        # Print only counts (no secrets).
        source_ids = sorted({c.sourceId for c in idx})
        print({"ok": True, "chunks": len(idx), "sources": source_ids[:20], "sourcesTotal": len(source_ids)})

    asyncio.run(run())


if __name__ == "__main__":
    main()

