from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from langchain_openai import OpenAIEmbeddings


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
    base = _knowledge_dir()
    docs: list[dict[str, Any]] = []
    for p in base.rglob("*.md"):
        text = p.read_text(encoding="utf-8")
        source_id = str(p.relative_to(base)).replace("\\", "/")
        docs.append({"sourceId": source_id, "text": text})
    return docs


_CACHED_INDEX: list[IndexedChunk] | None = None


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


def ensure_index() -> list[IndexedChunk]:
    global _CACHED_INDEX
    if _CACHED_INDEX is None:
        _CACHED_INDEX = build_index()
    return _CACHED_INDEX


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

