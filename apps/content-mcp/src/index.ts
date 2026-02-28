import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type Env = {
  MCP_API_KEY?: string;
  DB: D1Database;
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

  server.tool("ping", "Health check", {}, async () => ({ content: [{ type: "text", text: "ok" }] }));
  return server;
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
};

