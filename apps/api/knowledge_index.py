from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from langchain_openai import OpenAIEmbeddings
from .mcp_tools import load_mcp_tools_from_env


@dataclass(frozen=True)
class KnowledgeHit:
    sourceId: str
    snippet: str


@dataclass(frozen=True)
class IndexedChunk:
    sourceId: str
    text: str
    embedding: list[float]


def _repo_root() -> Path:
    # apps/api/knowledge_index.py -> repo root
    return Path(__file__).resolve().parents[2]


def _knowledge_dir() -> Path:
    return _repo_root() / "packages" / "knowledge" / "content"


def _read_markdown_docs() -> list[dict[str, Any]]:
    include_local = os.environ.get("KB_INCLUDE_LOCAL_MARKDOWN", "0").strip().lower() in {"1", "true", "yes", "y", "on"}
    if not include_local:
        return []
    base = _knowledge_dir()
    docs: list[dict[str, Any]] = []
    for p in base.rglob("*.md"):
        text = p.read_text(encoding="utf-8")
        source_id = str(p.relative_to(base)).replace("\\", "/")
        docs.append({"sourceId": source_id, "text": text})
    return docs


_CACHED_INDEX: list[IndexedChunk] | None = None
_CACHED_INDEX_MCP: list[IndexedChunk] | None = None
_CACHED_INDEX_MCP_BUILT_AT: float | None = None


def build_index() -> list[IndexedChunk]:
    docs = _read_markdown_docs()
    chunks: list[tuple[str, str]] = []
    for d in docs:
        for piece in chunk_text(str(d["text"]), chunk_size=900, overlap=150):
            chunks.append((str(d["sourceId"]), piece))

    embeddings = OpenAIEmbeddings(
        api_key=os.environ.get("OPENAI_API_KEY"),
        model=os.environ.get("OPENAI_EMBEDDINGS_MODEL", "text-embedding-3-large"),
    )

    vectors = embeddings.embed_documents([t for (_, t) in chunks])
    out: list[IndexedChunk] = []
    for i, (sid, text) in enumerate(chunks):
        out.append(IndexedChunk(sourceId=sid, text=text, embedding=list(vectors[i] or [])))
    return out


def _tool_raw_to_json(raw: Any) -> dict[str, Any] | None:
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


async def _mcp_call_json(tool_suffix: str, args: dict[str, Any]) -> dict[str, Any] | None:
    tools = await load_mcp_tools_from_env()
    tool = next(
        (
            t
            for t in tools
            if isinstance(getattr(t, "name", None), str)
            and (t.name == tool_suffix or t.name.endswith(f"_{tool_suffix}"))
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


def ensure_index() -> list[IndexedChunk]:
    global _CACHED_INDEX
    if _CACHED_INDEX is None:
        _CACHED_INDEX = build_index()
    return _CACHED_INDEX


async def ensure_index_with_mcp(ttl_seconds: int = 300) -> list[IndexedChunk]:
    """
    Builds a KB index from:
    - local markdown in packages/knowledge/content
    - content-mcp docs (markdown)
    - core lists (class defs, instructors, products) as synthetic docs
    Cached in-memory with a TTL.
    """
    global _CACHED_INDEX_MCP, _CACHED_INDEX_MCP_BUILT_AT
    now = asyncio.get_running_loop().time()
    if (
        _CACHED_INDEX_MCP is not None
        and _CACHED_INDEX_MCP_BUILT_AT is not None
        and (now - _CACHED_INDEX_MCP_BUILT_AT) < ttl_seconds
    ):
        return _CACHED_INDEX_MCP

    docs = _read_markdown_docs()

    content = await _mcp_call_json("content_list_docs", {"limit": 500})
    if isinstance(content, dict) and isinstance(content.get("docs"), list):
        for d in content.get("docs") or []:
            if not isinstance(d, dict):
                continue
            body = d.get("bodyMarkdown")
            if not isinstance(body, str) or not body.strip():
                continue
            entity_type = str(d.get("entityType") or "other")
            entity_id = str(d.get("entityId") or "")
            locale = str(d.get("locale") or "en")
            doc_id = str(d.get("docId") or "")
            source_id = f"cms/{entity_type}/{entity_id}/{locale}#{doc_id}".replace("//", "/")
            docs.append({"sourceId": source_id, "text": body})

    class_defs = await _mcp_call_json("core_list_class_definitions", {})
    if isinstance(class_defs, dict) and isinstance(class_defs.get("classDefinitions"), list):
        docs.append({"sourceId": "core/class_definitions.json", "text": json.dumps(class_defs, indent=2)})

    instructors = await _mcp_call_json("core_list_instructors", {})
    if isinstance(instructors, dict) and isinstance(instructors.get("instructors"), list):
        docs.append({"sourceId": "core/instructors.json", "text": json.dumps(instructors, indent=2)})

    products = await _mcp_call_json("core_list_products", {})
    if isinstance(products, dict) and isinstance(products.get("products"), list):
        docs.append({"sourceId": "core/products.json", "text": json.dumps(products, indent=2)})

    chunks: list[tuple[str, str]] = []
    for d in docs:
        for piece in chunk_text(str(d["text"]), chunk_size=900, overlap=150):
            chunks.append((str(d["sourceId"]), piece))

    embeddings = OpenAIEmbeddings(
        api_key=os.environ.get("OPENAI_API_KEY"),
        model=os.environ.get("OPENAI_EMBEDDINGS_MODEL", "text-embedding-3-large"),
    )
    vectors = embeddings.embed_documents([t for (_, t) in chunks]) if chunks else []
    out: list[IndexedChunk] = []
    for i, (sid, text) in enumerate(chunks):
        out.append(IndexedChunk(sourceId=sid, text=text, embedding=list(vectors[i] or [])))

    _CACHED_INDEX_MCP = out
    _CACHED_INDEX_MCP_BUILT_AT = now
    return out


def search_kb(index: list[IndexedChunk], query: str, k: int = 4) -> tuple[str, list[KnowledgeHit]]:
    embeddings = OpenAIEmbeddings(
        api_key=os.environ.get("OPENAI_API_KEY"),
        model=os.environ.get("OPENAI_EMBEDDINGS_MODEL", "text-embedding-3-large"),
    )
    q = embeddings.embed_query(query)

    scored = sorted(
        [(cosine_similarity(q, c.embedding), c) for c in index],
        key=lambda x: x[0],
        reverse=True,
    )[:k]

    hits: list[KnowledgeHit] = []
    for _, c in scored:
        sid = c.sourceId
        snippet = (c.text or "").strip().replace("\n", " ")[:400]
        hits.append(KnowledgeHit(sourceId=sid, snippet=snippet))

    if not hits:
        return "No relevant knowledge base content found.", []

    tool_text = "Knowledge base matches:\n" + "\n".join(
        [f"- [{i+1}] {h.sourceId}: {h.snippet}" for i, h in enumerate(hits)]
    )
    return tool_text, hits


def chunk_text(text: str, chunk_size: int, overlap: int) -> list[str]:
    clean = text.replace("\r\n", "\n").strip()
    if len(clean) <= chunk_size:
        return [clean] if clean else []
    out: list[str] = []
    i = 0
    while i < len(clean):
        end = min(len(clean), i + chunk_size)
        out.append(clean[i:end])
        if end >= len(clean):
            break
        i = max(0, end - overlap)
    return [s for s in out if s.strip()]


def cosine_similarity(a: list[float], b: list[float]) -> float:
    n = min(len(a), len(b))
    dot = 0.0
    an = 0.0
    bn = 0.0
    for i in range(n):
        av = float(a[i])
        bv = float(b[i])
        dot += av * bv
        an += av * av
        bn += bv * bv
    denom = (an**0.5) * (bn**0.5)
    return 0.0 if denom == 0.0 else dot / denom

