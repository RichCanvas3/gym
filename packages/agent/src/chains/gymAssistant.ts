import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";

import type {
  GymAssistantResult,
  GymAssistantSession,
  OpsFreshness,
  WeatherFreshness,
} from "../types/domain";
import { buildSessionPrompt } from "../prompts/session";
import { buildSystemPrompt } from "../prompts/system";
import { searchKnowledgeBase } from "../tools/ragTool";
import { getCurrentWeather } from "../tools/weatherTool";
import {
  opsClassAvailability,
  opsGetCatalogItem,
  opsListCatalog,
  opsProductAvailability,
  opsSearchCatalog,
  opsSearchClasses,
  opsSearchCoaches,
} from "../tools/opsTool";

type Trace = {
  citations: GymAssistantResult["citations"];
  opsEndpoints: Set<string>;
  opsAsOfISO: string | null;
  weatherAsOfISO: string | null;
  weatherLocationLabel: string | null;
};

export async function runGymAssistant(input: {
  message: string;
  session?: GymAssistantSession;
}): Promise<GymAssistantResult> {
  if (!process.env.OPENAI_API_KEY) {
    return {
      answer:
        "Missing OPENAI_API_KEY. Set it in apps/web/.env.local (copy from .env.example).",
      citations: [],
    };
  }

  const trace: Trace = {
    citations: [],
    opsEndpoints: new Set<string>(),
    opsAsOfISO: null,
    weatherAsOfISO: null,
    weatherLocationLabel: null,
  };

  const tools = makeTools(trace);

  const llm = new ChatOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL ?? "gpt-5.2",
    temperature: 0.2,
  });

  const toolsByName: Record<string, any> = Object.fromEntries(
    tools.map((t) => [t.name, t] as const),
  );
  const model = llm.bindTools(tools);

  const messages: Array<SystemMessage | HumanMessage | ToolMessage | any> = [
    new SystemMessage(buildSystemPrompt()),
    new SystemMessage(buildSessionPrompt(input.session)),
    new HumanMessage(input.message),
  ];

  let finalText = "";
  for (let step = 0; step < 6; step++) {
    const ai = await model.invoke(messages);
    messages.push(ai);

    const toolCalls = normalizeToolCalls(ai);
    if (toolCalls.length === 0) {
      finalText = String((ai as any).content ?? "");
      break;
    }

    for (const call of toolCalls) {
      const t = toolsByName[call.name];
      if (!t) {
        messages.push(
          new ToolMessage({
            tool_call_id: call.id,
            content: `Unknown tool: ${call.name}`,
          }) as any,
        );
        continue;
      }

      const toolResult = await (t as any).invoke(call.args);
      messages.push(
        new ToolMessage({
          tool_call_id: call.id,
          content: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult),
        }) as any,
      );
    }
  }

  const { answer, suggestedCartItems } = extractCartSuggestions(finalText);

  const opsFreshness: OpsFreshness | undefined =
    trace.opsAsOfISO && trace.opsEndpoints.size
      ? { asOfISO: trace.opsAsOfISO, endpoints: [...trace.opsEndpoints] }
      : undefined;

  const weatherFreshness: WeatherFreshness | undefined =
    trace.weatherAsOfISO && trace.weatherLocationLabel
      ? { asOfISO: trace.weatherAsOfISO, locationLabel: trace.weatherLocationLabel }
      : undefined;

  return {
    answer,
    citations: dedupeCitations(trace.citations),
    opsFreshness,
    weatherFreshness,
    suggestedCartItems,
  };
}

function makeTools(trace: Trace) {
  const rag = tool(
    async ({ query, k }: { query: string; k?: number }) => {
      const { citations, toolText } = await searchKnowledgeBase({ query, k });
      trace.citations.push(...citations);
      return toolText;
    },
    {
      name: "knowledge_search",
      description:
        "Search the gym knowledge base (policies, hours, class descriptions, coach bios, rentals). Use this for FAQs and policy questions.",
      schema: z.object({
        query: z.string().min(1),
        k: z.number().int().min(1).max(10).optional(),
      }),
    },
  );

  const productAvail = tool(
    async ({ sku, size }: { sku: string; size?: string }) => {
      const res = opsProductAvailability({ sku, size });
      trace.opsEndpoints.add(res.endpoint);
      trace.opsAsOfISO = res.asOfISO;
      return JSON.stringify(res, null, 2);
    },
    {
      name: "ops_product_availability",
      description:
        "Get real-time-ish product availability (inventory). Use for in-stock questions, especially rentals like shoes by size.",
      schema: z.object({
        sku: z.string().min(1),
        size: z.string().min(1).optional(),
      }),
    },
  );

  const classAvail = tool(
    async ({ classId }: { classId: string }) => {
      const res = opsClassAvailability({ classId });
      trace.opsEndpoints.add(res.endpoint);
      trace.opsAsOfISO = res.asOfISO;
      return JSON.stringify(res, null, 2);
    },
    {
      name: "ops_class_availability",
      description: "Get real-time-ish class seat availability by classId.",
      schema: z.object({
        classId: z.string().min(1),
      }),
    },
  );

  const classSearch = tool(
    async ({
      dateISO,
      skillLevel,
      type,
    }: {
      dateISO?: string;
      skillLevel?: "beginner" | "intermediate" | "advanced";
      type?: "group" | "private";
    }) => {
      const res = opsSearchClasses({ dateISO, skillLevel, type });
      trace.opsEndpoints.add(res.endpoint);
      trace.opsAsOfISO = res.asOfISO;
      return JSON.stringify(res, null, 2);
    },
    {
      name: "ops_search_classes",
      description:
        "Search classes by date (YYYY-MM-DD), skill level, and type (group/private).",
      schema: z.object({
        dateISO: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        skillLevel: z.enum(["beginner", "intermediate", "advanced"]).optional(),
        type: z.enum(["group", "private"]).optional(),
      }),
    },
  );

  const coachSearch = tool(
    async ({ skillIdOrName }: { skillIdOrName: string }) => {
      const res = opsSearchCoaches({ skillIdOrName });
      trace.opsEndpoints.add(res.endpoint);
      trace.opsAsOfISO = res.asOfISO;
      return JSON.stringify(res, null, 2);
    },
    {
      name: "ops_search_coaches",
      description: "Search coaches by skill id or partial skill name.",
      schema: z.object({
        skillIdOrName: z.string().min(1),
      }),
    },
  );

  const catalogList = tool(
    async () => {
      const res = opsListCatalog();
      trace.opsEndpoints.add(res.endpoint);
      trace.opsAsOfISO = res.asOfISO;
      return JSON.stringify(res, null, 2);
    },
    {
      name: "ops_list_catalog",
      description: "List all purchasable catalog items (products, memberships, packs, coaching, camps).",
      schema: z.object({}),
    },
  );

  const catalogSearch = tool(
    async ({ query, limit }: { query: string; limit?: number }) => {
      const res = opsSearchCatalog({ query, limit });
      trace.opsEndpoints.add(res.endpoint);
      trace.opsAsOfISO = res.asOfISO;
      return JSON.stringify(res, null, 2);
    },
    {
      name: "ops_search_catalog",
      description: "Search purchasable catalog items by text query (use this to find SKUs).",
      schema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(20).optional(),
      }),
    },
  );

  const catalogGet = tool(
    async ({ sku }: { sku: string }) => {
      const res = opsGetCatalogItem({ sku });
      trace.opsEndpoints.add(res.endpoint);
      trace.opsAsOfISO = res.asOfISO;
      return JSON.stringify(res, null, 2);
    },
    {
      name: "ops_get_catalog_item",
      description: "Get one catalog item by SKU.",
      schema: z.object({
        sku: z.string().min(1),
      }),
    },
  );

  const weather = tool(
    async ({
      lat,
      lon,
      label,
    }: {
      lat?: number;
      lon?: number;
      label?: string;
    }) => {
      const res = await getCurrentWeather({ lat, lon, label });
      trace.weatherAsOfISO = res.asOfISO;
      trace.weatherLocationLabel = res.location.label;
      return JSON.stringify(res, null, 2);
    },
    {
      name: "weather_current",
      description:
        "Get current weather for outdoor wall decisions. Use for outdoor wall access and outdoor classes.",
      schema: z.object({
        lat: z.number().min(-90).max(90).optional(),
        lon: z.number().min(-180).max(180).optional(),
        label: z.string().min(1).optional(),
      }),
    },
  );

  return [
    rag,
    productAvail,
    classAvail,
    classSearch,
    coachSearch,
    catalogList,
    catalogSearch,
    catalogGet,
    weather,
  ];
}

function dedupeCitations(citations: GymAssistantResult["citations"]) {
  const seen = new Set<string>();
  const out: GymAssistantResult["citations"] = [];
  for (const c of citations) {
    const key = `${c.sourceId}::${c.snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function normalizeToolCalls(ai: any): Array<{ id: string; name: string; args: any }> {
  const direct = Array.isArray(ai?.tool_calls) ? ai.tool_calls : null;
  const viaKwargs = Array.isArray(ai?.additional_kwargs?.tool_calls)
    ? ai.additional_kwargs.tool_calls
    : null;
  const calls = (direct ?? viaKwargs ?? []) as any[];

  return calls
    .map((c) => {
      const id = String(c.id ?? c.tool_call_id ?? "");
      const name = String(c.name ?? c.function?.name ?? "");
      const rawArgs = c.args ?? c.function?.arguments ?? {};
      let args: any = rawArgs;
      if (typeof rawArgs === "string") {
        try {
          args = JSON.parse(rawArgs);
        } catch {
          args = {};
        }
      }
      return { id, name, args };
    })
    .filter((c) => c.id && c.name);
}

function extractCartSuggestions(text: string): {
  answer: string;
  suggestedCartItems?: Array<{ sku: string; quantity: number; note?: string }>;
} {
  const marker = "\nCartItemsJSON:";
  const idx = text.lastIndexOf(marker);
  if (idx === -1) return { answer: text };

  const jsonPart = text.slice(idx + marker.length).trim();
  const answer = text.slice(0, idx).trimEnd();
  try {
    const parsed = JSON.parse(jsonPart) as unknown;
    if (!Array.isArray(parsed)) return { answer };
    const items = parsed
      .map((it) => {
        if (!it || typeof it !== "object") return null;
        const o = it as Record<string, unknown>;
        const sku = typeof o.sku === "string" ? o.sku : "";
        const quantity = typeof o.quantity === "number" ? o.quantity : 1;
        const note = typeof o.note === "string" ? o.note : undefined;
        if (!sku) return null;
        return { sku, quantity: Number.isFinite(quantity) ? quantity : 1, note };
      })
      .filter(Boolean) as Array<{ sku: string; quantity: number; note?: string }>;
    return { answer, suggestedCartItems: items.length ? items : undefined };
  } catch {
    return { answer };
  }
}

