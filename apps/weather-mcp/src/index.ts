import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type Env = {
  // Shared secret (optional). If set, caller must send header `x-api-key: <value>`.
  MCP_API_KEY?: string;

  // OpenWeather API key (One Call 3.0)
  OPENWEATHER_API_KEY: string;
};

const Units = z.enum(["standard", "metric", "imperial"]);

const BaseArgs = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  units: Units.optional(),
  lang: z.string().min(2).max(12).optional(),
  label: z.string().optional(),
});

function createServer(env: Env) {
  const server = new McpServer({
    name: "Gym Weather MCP (OpenWeather One Call 3.0)",
    version: "0.1.0",
  });

  server.tool(
    "weather_onecall",
    "Fetch OpenWeather One Call 3.0 payload (optionally excluding sections). Returns JSON text.",
    {
      ...BaseArgs.shape,
      exclude: z
        .array(z.enum(["current", "minutely", "hourly", "daily", "alerts"]))
        .optional(),
    },
    async (args) => {
      const parsed = BaseArgs.extend({
        exclude: z
          .array(z.enum(["current", "minutely", "hourly", "daily", "alerts"]))
          .optional(),
      }).parse(args);

      const res = await onecall(env, {
        lat: parsed.lat,
        lon: parsed.lon,
        units: parsed.units,
        lang: parsed.lang,
        exclude: parsed.exclude,
      });

      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    },
  );

  server.tool(
    "weather_current",
    "Get current weather (OpenWeather One Call 3.0). Returns JSON text with asOf + location + key fields.",
    BaseArgs.shape,
    async (args) => {
      const parsed = BaseArgs.parse(args);
      const payload = await onecall(env, {
        lat: parsed.lat,
        lon: parsed.lon,
        units: parsed.units,
        lang: parsed.lang,
        exclude: ["minutely", "hourly", "daily", "alerts"],
      });

      const current = (payload as any)?.current ?? null;
      const out = {
        asOfUnixUTC: current?.dt ?? null,
        location: { lat: parsed.lat, lon: parsed.lon, label: parsed.label ?? null },
        units: parsed.units ?? "standard",
        current,
      };
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    },
  );

  server.tool(
    "weather_forecast_hourly",
    "Get hourly forecast (up to 48 hours) from OpenWeather One Call 3.0. Returns JSON text.",
    {
      ...BaseArgs.shape,
      hours: z.number().int().min(1).max(48).optional(),
      includeMinutely: z.boolean().optional(),
      includeAlerts: z.boolean().optional(),
    },
    async (args) => {
      const parsed = BaseArgs.extend({
        hours: z.number().int().min(1).max(48).optional(),
        includeMinutely: z.boolean().optional(),
        includeAlerts: z.boolean().optional(),
      }).parse(args);

      const exclude: Array<"current" | "minutely" | "hourly" | "daily" | "alerts"> = [
        "daily",
      ];
      if (!parsed.includeMinutely) exclude.push("minutely");
      if (!parsed.includeAlerts) exclude.push("alerts");

      const payload = await onecall(env, {
        lat: parsed.lat,
        lon: parsed.lon,
        units: parsed.units,
        lang: parsed.lang,
        exclude,
      });

      const hourly = Array.isArray((payload as any)?.hourly) ? (payload as any).hourly : [];
      const sliced = hourly.slice(0, parsed.hours ?? 48);
      const out = {
        location: { lat: parsed.lat, lon: parsed.lon, label: parsed.label ?? null },
        units: parsed.units ?? "standard",
        hours: parsed.hours ?? 48,
        hourly: sliced,
        ...(parsed.includeMinutely ? { minutely: (payload as any)?.minutely ?? null } : {}),
        ...(parsed.includeAlerts ? { alerts: (payload as any)?.alerts ?? null } : {}),
      };

      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    },
  );

  server.tool(
    "weather_forecast_daily",
    "Get daily forecast (up to 8 days) from OpenWeather One Call 3.0. Returns JSON text.",
    {
      ...BaseArgs.shape,
      days: z.number().int().min(1).max(8).optional(),
      includeAlerts: z.boolean().optional(),
    },
    async (args) => {
      const parsed = BaseArgs.extend({
        days: z.number().int().min(1).max(8).optional(),
        includeAlerts: z.boolean().optional(),
      }).parse(args);

      const exclude: Array<"current" | "minutely" | "hourly" | "daily" | "alerts"> = [
        "hourly",
        "minutely",
      ];
      if (!parsed.includeAlerts) exclude.push("alerts");

      const payload = await onecall(env, {
        lat: parsed.lat,
        lon: parsed.lon,
        units: parsed.units,
        lang: parsed.lang,
        exclude,
      });

      const daily = Array.isArray((payload as any)?.daily) ? (payload as any).daily : [];
      const sliced = daily.slice(0, parsed.days ?? 8);
      const out = {
        location: { lat: parsed.lat, lon: parsed.lon, label: parsed.label ?? null },
        units: parsed.units ?? "standard",
        days: parsed.days ?? 8,
        daily: sliced,
        ...(parsed.includeAlerts ? { alerts: (payload as any)?.alerts ?? null } : {}),
      };

      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    },
  );

  server.tool(
    "weather_alerts",
    "Get government weather alerts (if any) from OpenWeather One Call 3.0. Returns JSON text.",
    BaseArgs.shape,
    async (args) => {
      const parsed = BaseArgs.parse(args);
      const payload = await onecall(env, {
        lat: parsed.lat,
        lon: parsed.lon,
        units: parsed.units,
        lang: parsed.lang,
        exclude: ["current", "minutely", "hourly", "daily"],
      });

      const out = {
        location: { lat: parsed.lat, lon: parsed.lon, label: parsed.label ?? null },
        alerts: (payload as any)?.alerts ?? null,
      };
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    },
  );

  return server;
}

async function onecall(
  env: Env,
  params: {
    lat: number;
    lon: number;
    exclude?: Array<"current" | "minutely" | "hourly" | "daily" | "alerts">;
    units?: "standard" | "metric" | "imperial";
    lang?: string;
  },
): Promise<unknown> {
  if (!env.OPENWEATHER_API_KEY) throw new Error("Missing OPENWEATHER_API_KEY");

  const url = new URL("https://api.openweathermap.org/data/3.0/onecall");
  url.searchParams.set("lat", String(params.lat));
  url.searchParams.set("lon", String(params.lon));
  url.searchParams.set("appid", env.OPENWEATHER_API_KEY);
  if (params.units) url.searchParams.set("units", params.units);
  if (params.lang) url.searchParams.set("lang", params.lang);
  if (params.exclude?.length) url.searchParams.set("exclude", params.exclude.join(","));

  const r = await fetch(url.toString(), { method: "GET" });
  const txt = await r.text().catch(() => "");
  if (!r.ok) {
    throw new Error(txt || `HTTP ${r.status}`);
  }

  try {
    return JSON.parse(txt) as unknown;
  } catch {
    return { raw: txt };
  }
}

function checkApiKey(request: Request, env: Env): Response | null {
  const expected = (env.MCP_API_KEY ?? "").trim();
  if (!expected) return null;
  const got = request.headers.get("x-api-key") ?? request.headers.get("X-Api-Key") ?? "";
  if (got !== expected) return new Response("Unauthorized", { status: 401 });
  return null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const auth = checkApiKey(request, env);
    if (auth) return auth;

    const server = createServer(env);
    return createMcpHandler(server, { route: "/mcp" })(request, env, ctx);
  },
};

