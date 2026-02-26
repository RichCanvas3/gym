from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from langchain_community.vectorstores import FAISS
from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_openai import OpenAIEmbeddings


@dataclass(frozen=True)
class KnowledgeHit:
    sourceId: str
    snippet: str


def _repo_root() -> Path:
    # apps/api/knowledge_index.py -> repo root
    return Path(__file__).resolve().parents[2]


def _knowledge_dir() -> Path:
    return _repo_root() / "packages" / "knowledge" / "content"


def _read_markdown_docs() -> list[Document]:
    base = _knowledge_dir()
    docs: list[Document] = []
    for p in base.rglob("*.md"):
        text = p.read_text(encoding="utf-8")
        source_id = str(p.relative_to(base)).replace("\\", "/")
        docs.append(Document(page_content=text, metadata={"sourceId": source_id}))
    return docs


def build_vectorstore() -> FAISS:
    docs = _read_markdown_docs()
    splitter = RecursiveCharacterTextSplitter(chunk_size=900, chunk_overlap=150)
    chunks = splitter.split_documents(docs)

    embeddings = OpenAIEmbeddings(
        api_key=os.environ.get("OPENAI_API_KEY"),
        model=os.environ.get("OPENAI_EMBEDDINGS_MODEL", "text-embedding-3-large"),
    )
    return FAISS.from_documents(chunks, embeddings)


def search_kb(store: FAISS, query: str, k: int = 4) -> tuple[str, list[KnowledgeHit]]:
    results = store.similarity_search(query, k=k)
    hits: list[KnowledgeHit] = []
    for r in results:
        sid = str((r.metadata or {}).get("sourceId", "unknown"))
        snippet = (r.page_content or "").strip().replace("\n", " ")[:400]
        hits.append(KnowledgeHit(sourceId=sid, snippet=snippet))

    if not hits:
        return "No relevant knowledge base content found.", []

    tool_text = "Knowledge base matches:\n" + "\n".join(
        [f"- [{i+1}] {h.sourceId}: {h.snippet}" for i, h in enumerate(hits)]
    )
    return tool_text, hits

