import { describe, expect, it, vi } from "vitest";

const d = process.env.CF_WORKERS === "1" ? describe : describe.skip;

async function readMcpResult(res: Response): Promise<any> {
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await res.json();
  const txt = await res.text();
  const m = txt.match(/data: (.+)\n/);
  if (!m) throw new Error(`Unexpected MCP response: ${txt.slice(0, 200)}`);
  return JSON.parse(m[1]);
}

async function toolCall(selfFetch: typeof fetch, name: string, args: Record<string, unknown>) {
  const res = await selfFetch("http://example.com/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const msg = await readMcpResult(res);
  const text = msg?.result?.content?.[0]?.text;
  return typeof text === "string" ? JSON.parse(text) : msg;
}

d("content-mcp crawl", () => {
  it("detects change on first fetch, not on second", async () => {
    const { SELF, env } = await import("cloudflare:test");

    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS content_docs (
        doc_id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        locale TEXT NOT NULL,
        title TEXT,
        slug TEXT,
        body_markdown TEXT NOT NULL,
        tags_json TEXT,
        created_at_iso TEXT NOT NULL,
        updated_at_iso TEXT NOT NULL,
        UNIQUE(entity_type, entity_id, locale)
      )`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS web_crawl_pages (
        url TEXT PRIMARY KEY,
        etag TEXT,
        last_modified TEXT,
        content_hash TEXT,
        title TEXT,
        status_code INTEGER,
        last_fetched_at_iso TEXT,
        last_changed_at_iso TEXT,
        error TEXT,
        updated_at_iso TEXT NOT NULL
      )`,
    ).run();

    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input?.url;
      if (typeof url === "string" && url.startsWith("https://www.erieco.gov/")) {
        return new Response("<html><head><title>Erie</title></head><body>Hello</body></html>", {
          status: 200,
          headers: { etag: 'W/"1"', "last-modified": "Mon, 01 Jan 2026 00:00:00 GMT" },
        });
      }
      return originalFetch(input, init);
    });

    try {
      const r1 = await toolCall(SELF.fetch, "content_crawl_erie_now", { limit: 1 });
      expect(r1.ok).toBe(true);
      expect(r1.pages?.[0]?.changed).toBe(true);

      const r2 = await toolCall(SELF.fetch, "content_crawl_erie_now", { limit: 1 });
      expect(r2.ok).toBe(true);
      expect(r2.pages?.[0]?.changed).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

