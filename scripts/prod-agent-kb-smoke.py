import os
from pathlib import Path
import sys


def _load_env_local_if_needed() -> None:
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
    # Ensure we can compute query embeddings and that KB is pulled from core.
    os.environ.setdefault("KB_PERSIST_TO_CORE", "1")
    os.environ.setdefault("KB_INCLUDE_LOCAL_MARKDOWN", "0")

    from apps.api.knowledge_index import ensure_index_with_mcp, search_kb  # noqa: WPS433

    import asyncio

    async def run() -> None:
        idx = await ensure_index_with_mcp(ttl_seconds=0)
        text, hits = search_kb(idx, "FitnessCore ontology PROV-O EP-PLAN workout session intensity", k=5)
        source_ids = [h.sourceId for h in hits]
        ok = any("fitness/fitnesscore_ontology.md" in sid for sid in source_ids) or any("fitness/sql_schemas.md" in sid for sid in source_ids)
        if not ok:
            raise SystemExit(f"KB search did not return expected FitnessCore docs. hits={source_ids}\n{text}")
        print({"ok": True, "hits": source_ids})

    asyncio.run(run())


if __name__ == "__main__":
    main()

