import { loadKnowledgeDocs } from "@climb-gym/knowledge";
import { OpenAIEmbeddings } from "@langchain/openai";
import type { Citation } from "../types/domain";

type IndexedChunk = {
  sourceId: string;
  text: string;
  embedding: number[];
};

let cachedIndex: null | Promise<{ chunks: IndexedChunk[] }> = null;

export async function searchKnowledgeBase(params: {
  query: string;
  k?: number;
}): Promise<{ citations: Citation[]; toolText: string }> {
  const k = params.k ?? 4;
  const { chunks } = await ensureIndex();
  const embeddings = makeEmbeddings();
  const q = await embeddings.embedQuery(params.query);

  const scored = chunks
    .map((c) => ({
      chunk: c,
      score: cosineSimilarity(q, c.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  const citations: Citation[] = scored.map((s) => ({
    sourceId: s.chunk.sourceId,
    snippet: s.chunk.text.slice(0, 400),
  }));

  const toolText =
    citations.length === 0
      ? "No relevant knowledge base content found."
      : [
          "Knowledge base matches:",
          ...citations.map(
            (c, i) =>
              `- [${i + 1}] ${c.sourceId}: ${c.snippet.replaceAll(/\s+/g, " ").trim()}`,
          ),
        ].join("\n");

  return { citations, toolText };
}

async function ensureIndex() {
  if (!cachedIndex) cachedIndex = buildIndex();
  return cachedIndex;
}

async function buildIndex() {
  const docs = await loadKnowledgeDocs();
  const chunks: Array<{ sourceId: string; text: string }> = [];
  for (const d of docs) {
    for (const text of chunkText(d.text, 900, 150)) {
      chunks.push({ sourceId: d.sourceId, text });
    }
  }

  const embeddings = makeEmbeddings();
  const vectors = await embeddings.embedDocuments(chunks.map((c) => c.text));
  const indexed: IndexedChunk[] = chunks.map((c, i) => ({
    sourceId: c.sourceId,
    text: c.text,
    embedding: vectors[i] ?? [],
  }));

  return { chunks: indexed };
}

function makeEmbeddings() {
  return new OpenAIEmbeddings({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_EMBEDDINGS_MODEL ?? "text-embedding-3-large",
  });
}

function chunkText(text: string, chunkSize: number, overlap: number): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length <= chunkSize) return [clean];

  const out: string[] = [];
  let i = 0;
  while (i < clean.length) {
    const end = Math.min(clean.length, i + chunkSize);
    out.push(clean.slice(i, end));
    if (end >= clean.length) break;
    i = Math.max(0, end - overlap);
  }
  return out.filter((s) => s.trim().length > 0);
}

function cosineSimilarity(a: number[], b: number[]) {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    aNorm += av * av;
    bNorm += bv * bv;
  }
  const denom = Math.sqrt(aNorm) * Math.sqrt(bNorm);
  return denom === 0 ? 0 : dot / denom;
}

