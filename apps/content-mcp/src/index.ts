import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type Env = {
  MCP_API_KEY?: string;
  DB: D1Database;
  /** Set to "1" to enable scheduled Erie site crawl. */
  ERIE_CRAWL_ENABLED?: string;
};

function nowISO() {
  return new Date().toISOString();
}

function jsonText(obj: unknown) {
  return JSON.stringify(obj, null, 2);
}

async function requireApiKey(request: Request, env: Env) {
  const want = (env.MCP_API_KEY ?? "").trim();
  if (!want) return;
  const got = (request.headers.get("x-api-key") ?? "").trim();
  if (got !== want) throw new Error("Unauthorized (bad x-api-key)");
}

function createServer(env: Env) {
  const server = new McpServer({ name: "Gym Content MCP (D1)", version: "0.1.0" });

  const EntityType = z.enum(["class_definition", "instructor", "product", "gym", "policy", "other"]);

  const UpsertArgs = z.object({
    docId: z.string().min(1).optional(),
    entityType: EntityType,
    entityId: z.string().min(1),
    locale: z.string().min(2).optional(),
    title: z.string().min(1).optional(),
    slug: z.string().min(1).optional(),
    bodyMarkdown: z.string().min(1),
    tags: z.array(z.string()).optional(),
  });

  server.tool("content_upsert_doc", "Upsert a rich-content markdown doc for a core entity.", UpsertArgs.shape, async (args) => {
    const p = UpsertArgs.parse(args);
    const ts = nowISO();
    const docId = p.docId ?? `doc_${crypto.randomUUID()}`;
    const locale = (p.locale ?? "en").trim() || "en";
    const tagsJson = p.tags ? JSON.stringify(p.tags) : null;

    await env.DB.prepare(
      `
      INSERT INTO content_docs (
        doc_id, entity_type, entity_id, locale, title, slug, body_markdown, tags_json, created_at_iso, updated_at_iso
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_type, entity_id, locale) DO UPDATE SET
        doc_id=excluded.doc_id,
        title=excluded.title,
        slug=excluded.slug,
        body_markdown=excluded.body_markdown,
        tags_json=excluded.tags_json,
        updated_at_iso=excluded.updated_at_iso
    `,
    )
      .bind(docId, p.entityType, p.entityId, locale, p.title ?? null, p.slug ?? null, p.bodyMarkdown, tagsJson, ts, ts)
      .run();

    return { content: [{ type: "text", text: jsonText({ docId, entityType: p.entityType, entityId: p.entityId, locale }) }] };
  });

  const GetArgs = z.object({ docId: z.string().min(1) });
  server.tool("content_get_doc", "Get a rich-content doc by docId.", GetArgs.shape, async (args) => {
    const p = GetArgs.parse(args);
    const r = await env.DB.prepare(
      `SELECT doc_id, entity_type, entity_id, locale, title, slug, body_markdown, tags_json, updated_at_iso
       FROM content_docs WHERE doc_id = ? LIMIT 1`,
    )
      .bind(p.docId)
      .first();
    if (!r) return { content: [{ type: "text", text: jsonText({ doc: null }) }] };
    const doc = {
      docId: String((r as any).doc_id ?? ""),
      entityType: String((r as any).entity_type ?? ""),
      entityId: String((r as any).entity_id ?? ""),
      locale: String((r as any).locale ?? ""),
      title: (r as any).title ? String((r as any).title) : null,
      slug: (r as any).slug ? String((r as any).slug) : null,
      bodyMarkdown: String((r as any).body_markdown ?? ""),
      tags: (() => {
        try {
          const v = (r as any).tags_json ? JSON.parse(String((r as any).tags_json)) : null;
          return Array.isArray(v) ? v : [];
        } catch {
          return [];
        }
      })(),
      updatedAtISO: String((r as any).updated_at_iso ?? ""),
    };
    return { content: [{ type: "text", text: jsonText({ doc }) }] };
  });

  const GetByEntityArgs = z.object({
    entityType: EntityType,
    entityId: z.string().min(1),
    locale: z.string().min(2).optional(),
  });
  server.tool(
    "content_get_doc_by_entity",
    "Get a rich-content doc by (entityType, entityId, locale).",
    GetByEntityArgs.shape,
    async (args) => {
      const p = GetByEntityArgs.parse(args);
      const locale = (p.locale ?? "en").trim() || "en";
      const r = await env.DB.prepare(
        `SELECT doc_id, entity_type, entity_id, locale, title, slug, body_markdown, tags_json, updated_at_iso
         FROM content_docs WHERE entity_type = ? AND entity_id = ? AND locale = ? LIMIT 1`,
      )
        .bind(p.entityType, p.entityId, locale)
        .first();
      if (!r) return { content: [{ type: "text", text: jsonText({ doc: null }) }] };
      const doc = {
        docId: String((r as any).doc_id ?? ""),
        entityType: String((r as any).entity_type ?? ""),
        entityId: String((r as any).entity_id ?? ""),
        locale: String((r as any).locale ?? ""),
        title: (r as any).title ? String((r as any).title) : null,
        slug: (r as any).slug ? String((r as any).slug) : null,
        bodyMarkdown: String((r as any).body_markdown ?? ""),
        tags: (() => {
          try {
            const v = (r as any).tags_json ? JSON.parse(String((r as any).tags_json)) : null;
            return Array.isArray(v) ? v : [];
          } catch {
            return [];
          }
        })(),
        updatedAtISO: String((r as any).updated_at_iso ?? ""),
      };
      return { content: [{ type: "text", text: jsonText({ doc }) }] };
    },
  );

  const ListArgs = z.object({
    entityType: EntityType.optional(),
    entityId: z.string().min(1).optional(),
    limit: z.number().int().positive().max(500).optional(),
  });
  server.tool("content_list_docs", "List rich-content docs (optionally filtered).", ListArgs.shape, async (args) => {
    const p = ListArgs.parse(args);
    const limit = p.limit ?? 200;
    const res = await env.DB.prepare(
      `
      SELECT doc_id, entity_type, entity_id, locale, title, slug, body_markdown, tags_json, updated_at_iso
      FROM content_docs
      WHERE (? IS NULL OR entity_type = ?)
        AND (? IS NULL OR entity_id = ?)
      ORDER BY updated_at_iso DESC
      LIMIT ?
    `,
    )
      .bind(p.entityType ?? null, p.entityType ?? null, p.entityId ?? null, p.entityId ?? null, limit)
      .all();

    const docs = (res.results ?? []).map((r: any) => ({
      docId: String(r.doc_id ?? ""),
      entityType: String(r.entity_type ?? ""),
      entityId: String(r.entity_id ?? ""),
      locale: String(r.locale ?? ""),
      title: r.title ? String(r.title) : null,
      slug: r.slug ? String(r.slug) : null,
      bodyMarkdown: String(r.body_markdown ?? ""),
      tags: (() => {
        try {
          const v = r.tags_json ? JSON.parse(String(r.tags_json)) : null;
          return Array.isArray(v) ? v : [];
        } catch {
          return [];
        }
      })(),
      updatedAtISO: String(r.updated_at_iso ?? ""),
    }));

    return { content: [{ type: "text", text: jsonText({ docs }) }] };
  });

  server.tool(
    "content_crawl_erie_now",
    "Fetch key Erie Community Center pages and upsert into content docs (entityType=other).",
    { limit: z.number().int().positive().max(20).optional() },
    async (args) => {
      const p = z.object({ limit: z.number().int().positive().max(20).optional() }).parse(args);
      const result = await crawlEriePages(env, { limit: p.limit ?? 10 });
      return { content: [{ type: "text", text: jsonText(result) }] };
    },
  );

  server.tool("ping", "Health check", {}, async () => ({ content: [{ type: "text", text: "ok" }] }));
  return server;
}

const ERIE_KEY_PAGES = [
  "https://www.erieco.gov/172/Erie-Community-Center",
  "https://www.erieco.gov/1971/Drop-in-Schedules",
  "https://www.erieco.gov/1896/Climbing-Wall",
  "https://www.erieco.gov/2139/Pool-Schedule",
  "https://www.erieco.gov/1800/Pickleball-Courts",
];

function truthy(v: unknown): boolean {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const dig = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(dig);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  if (!m) return null;
  const t = m[1]?.trim() ?? "";
  return t ? t : null;
}

function htmlToText(html: string): string {
  // very lightweight extraction; enough for KB/RAG
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<\/(p|div|h1|h2|h3|li|br|tr|td)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/&nbsp;/g, " ");
  s = s.replace(/&amp;/g, "&");
  s = s.replace(/&quot;/g, '"');
  s = s.replace(/&#39;/g, "'");
  s = s.replace(/\r/g, "");
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function erieEntityIdForUrl(url: string): string {
  // Keep entity ids short and stable; the full URL is recorded in the markdown body and crawl metadata table.
  const u = new URL(url);
  const base = `${u.hostname}${u.pathname}`;
  const safe = base.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase();
  return `erie_web_${safe.slice(0, 80)}`;
}

async function crawlEriePages(env: Env, opts: { limit: number }) {
  const urls = ERIE_KEY_PAGES.slice(0, Math.max(1, Math.min(opts.limit, ERIE_KEY_PAGES.length)));
  const out: Array<Record<string, unknown>> = [];
  const ts = nowISO();

  for (const url of urls) {
    const prev = await env.DB.prepare(
      `SELECT etag, last_modified, content_hash FROM web_crawl_pages WHERE url=? LIMIT 1`,
    )
      .bind(url)
      .first<{ etag: string | null; last_modified: string | null; content_hash: string | null }>();

    const headers: Record<string, string> = {};
    if (prev?.etag) headers["if-none-match"] = String(prev.etag);
    if (prev?.last_modified) headers["if-modified-since"] = String(prev.last_modified);

    let status = 0;
    try {
      const res = await fetch(url, { method: "GET", headers });
      status = res.status;
      if (res.status === 304) {
        await env.DB.prepare(
          `INSERT INTO web_crawl_pages (url, etag, last_modified, content_hash, title, status_code, last_fetched_at_iso, last_changed_at_iso, error, updated_at_iso)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
           ON CONFLICT(url) DO UPDATE SET status_code=excluded.status_code, last_fetched_at_iso=excluded.last_fetched_at_iso, updated_at_iso=excluded.updated_at_iso, error=NULL`,
        )
          .bind(url, prev?.etag ?? null, prev?.last_modified ?? null, prev?.content_hash ?? null, null, 304, ts, null, null, ts)
          .run();
        out.push({ url, status: 304, changed: false });
        continue;
      }
      const html = await res.text();
      const etag = res.headers.get("etag");
      const lastModified = res.headers.get("last-modified");
      const title = extractTitle(html);
      const text = htmlToText(html);
      const contentHash = await sha256Hex(text);

      const changed = !prev?.content_hash || prev.content_hash !== contentHash;
      const entityId = erieEntityIdForUrl(url);
      if (changed) {
        const md = `# ${title ?? "Erie Community Center"}\n\nSource: ${url}\n\n${text}\n`;
        await env.DB.prepare(
          `INSERT INTO content_docs (doc_id, entity_type, entity_id, locale, title, slug, body_markdown, tags_json, created_at_iso, updated_at_iso)
           VALUES (?1, 'other', ?2, 'en', ?3, ?4, ?5, ?6, ?7, ?7)
           ON CONFLICT(entity_type, entity_id, locale) DO UPDATE SET
             title=excluded.title,
             slug=excluded.slug,
             body_markdown=excluded.body_markdown,
             tags_json=excluded.tags_json,
             updated_at_iso=excluded.updated_at_iso`,
        )
          .bind(`doc_${entityId}`, entityId, title ?? null, entityId.replace(/^erie_web_/, ""), md, JSON.stringify(["erie", "web"]), ts)
          .run();
      }

      await env.DB.prepare(
        `INSERT INTO web_crawl_pages (url, etag, last_modified, content_hash, title, status_code, last_fetched_at_iso, last_changed_at_iso, error, updated_at_iso)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
         ON CONFLICT(url) DO UPDATE SET
           etag=excluded.etag,
           last_modified=excluded.last_modified,
           content_hash=excluded.content_hash,
           title=excluded.title,
           status_code=excluded.status_code,
           last_fetched_at_iso=excluded.last_fetched_at_iso,
           last_changed_at_iso=excluded.last_changed_at_iso,
           error=NULL,
           updated_at_iso=excluded.updated_at_iso`,
      )
        .bind(url, etag, lastModified, contentHash, title, status, ts, changed ? ts : null, null, ts)
        .run();

      out.push({ url, status, changed, entityId });
    } catch (e) {
      await env.DB.prepare(
        `INSERT INTO web_crawl_pages (url, etag, last_modified, content_hash, title, status_code, last_fetched_at_iso, last_changed_at_iso, error, updated_at_iso)
         VALUES (?1,NULL,NULL,NULL,NULL,?2,?3,NULL,?4,?5)
         ON CONFLICT(url) DO UPDATE SET status_code=excluded.status_code, last_fetched_at_iso=excluded.last_fetched_at_iso, error=excluded.error, updated_at_iso=excluded.updated_at_iso`,
      )
        .bind(url, status || 0, ts, String((e as Error)?.message ?? e), ts)
        .run();
      out.push({ url, status: status || 0, changed: false, error: String((e as Error)?.message ?? e) });
    }
  }

  return { ok: true, asOfISO: ts, pages: out };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    try {
      await requireApiKey(request, env);
    } catch {
      return new Response("Unauthorized", { status: 401 });
    }
    const server = createServer(env);
    return createMcpHandler(server, { route: "/mcp" })(request, env, ctx);
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    if (!truthy(env.ERIE_CRAWL_ENABLED)) return;
    ctx.waitUntil(crawlEriePages(env, { limit: ERIE_KEY_PAGES.length }));
  },
};

