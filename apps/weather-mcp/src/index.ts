import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type Env = {
  // Shared secret (optional). If set, caller must send header `x-api-key: <value>`.
  MCP_API_KEY?: string;

  // OpenWeather API key (One Call 3.0)
  OPENWEATHER_API_KEY?: string;
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
  const openweatherKey = (env.OPENWEATHER_API_KEY ?? "").trim();
  if (!openweatherKey) {
    return await openMeteoFallback({
      lat: params.lat,
      lon: params.lon,
      units: params.units,
    });
  }

  const url = new URL("https://api.openweathermap.org/data/3.0/onecall");
  url.searchParams.set("lat", String(params.lat));
  url.searchParams.set("lon", String(params.lon));
  url.searchParams.set("appid", openweatherKey);
  if (params.units) url.searchParams.set("units", params.units);
  if (params.lang) url.searchParams.set("lang", params.lang);
  if (params.exclude?.length) url.searchParams.set("exclude", params.exclude.join(","));

  const r = await fetch(url.toString(), { method: "GET" });
  const txt = await r.text().catch(() => "");
  if (!r.ok) {
    // One Call 3.0 often returns 401 if the account isn't subscribed.
    // Fall back to Open-Meteo for current/forecast so the agent can still answer.
    if (r.status === 401) {
      return await openMeteoFallback({
        lat: params.lat,
        lon: params.lon,
        units: params.units,
      });
    }
    throw new Error(txt || `HTTP ${r.status}`);
  }

  try {
    return JSON.parse(txt) as unknown;
  } catch {
    return { raw: txt };
  }
}

async function openMeteoFallback(params: {
  lat: number;
  lon: number;
  units?: "standard" | "metric" | "imperial";
}): Promise<unknown> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(params.lat));
  url.searchParams.set("longitude", String(params.lon));
  url.searchParams.set("timezone", "UTC");

  url.searchParams.set(
    "current",
    ["temperature_2m", "precipitation", "wind_speed_10m", "wind_gusts_10m", "weather_code"].join(","),
  );
  url.searchParams.set(
    "hourly",
    [
      "temperature_2m",
      "precipitation_probability",
      "precipitation",
      "wind_speed_10m",
      "wind_gusts_10m",
      "weather_code",
    ].join(","),
  );
  url.searchParams.set("forecast_hours", "48");
  url.searchParams.set(
    "daily",
    [
      "weather_code",
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_probability_max",
      "precipitation_sum",
      "wind_speed_10m_max",
      "wind_gusts_10m_max",
    ].join(","),
  );
  url.searchParams.set("forecast_days", "8");

  if (params.units === "imperial") {
    url.searchParams.set("temperature_unit", "fahrenheit");
    url.searchParams.set("wind_speed_unit", "mph");
    url.searchParams.set("precipitation_unit", "inch");
  } else {
    url.searchParams.set("temperature_unit", "celsius");
    url.searchParams.set("wind_speed_unit", "ms");
    url.searchParams.set("precipitation_unit", "mm");
  }

  const r = await fetch(url.toString(), { method: "GET" });
  const txt = await r.text().catch(() => "");
  if (!r.ok) throw new Error(txt || `Open-Meteo HTTP ${r.status}`);
  try {
    const raw = JSON.parse(txt) as any;
    return openMeteoToOneCallLike(raw, params);
  } catch {
    return { raw: txt };
  }
}

function openMeteoToOneCallLike(
  raw: any,
  params: { lat: number; lon: number; units?: "standard" | "metric" | "imperial" },
) {
  const offsetSeconds = typeof raw?.utc_offset_seconds === "number" ? raw.utc_offset_seconds : 0;

  const toUnix = (iso: unknown) => {
    if (typeof iso !== "string" || !iso) return null;
    const ms = Date.parse(iso.endsWith("Z") ? iso : `${iso}Z`);
    if (!Number.isFinite(ms)) return null;
    return Math.floor(ms / 1000);
  };

  const codeToWeather = (code: unknown) => {
    const id = typeof code === "number" ? code : null;
    return id == null
      ? []
      : [
          {
            id,
            main: "Weather",
            description: `code=${id}`,
            icon: "",
          },
        ];
  };

  const current = raw?.current ?? null;
  const currentDt = toUnix(current?.time);

  const hourly = raw?.hourly ?? null;
  const hTimes: unknown[] = Array.isArray(hourly?.time) ? hourly.time : [];
  const hourlyOut = hTimes.slice(0, 48).map((_, i) => {
    const dt = toUnix(hTimes[i]);
    const temp = hourly?.temperature_2m?.[i] ?? null;
    const wind_speed = hourly?.wind_speed_10m?.[i] ?? null;
    const wind_gust = hourly?.wind_gusts_10m?.[i] ?? null;
    const precipitation = hourly?.precipitation?.[i] ?? null;
    const popRaw = hourly?.precipitation_probability?.[i];
    const pop = typeof popRaw === "number" && Number.isFinite(popRaw) ? popRaw / 100 : null;
    const code = hourly?.weather_code?.[i] ?? null;
    return {
      dt,
      temp,
      wind_speed,
      wind_gust,
      pop,
      rain: precipitation == null ? undefined : { "1h": precipitation },
      weather: codeToWeather(code),
    };
  });

  const daily = raw?.daily ?? null;
  const dTimes: unknown[] = Array.isArray(daily?.time) ? daily.time : [];
  const dailyOut = dTimes.slice(0, 8).map((_, i) => {
    const dt = toUnix(dTimes[i]);
    const tmax = daily?.temperature_2m_max?.[i] ?? null;
    const tmin = daily?.temperature_2m_min?.[i] ?? null;
    const precip = daily?.precipitation_sum?.[i] ?? null;
    const popRaw = daily?.precipitation_probability_max?.[i];
    const pop = typeof popRaw === "number" && Number.isFinite(popRaw) ? popRaw / 100 : null;
    const wind_speed = daily?.wind_speed_10m_max?.[i] ?? null;
    const wind_gust = daily?.wind_gusts_10m_max?.[i] ?? null;
    const code = daily?.weather_code?.[i] ?? null;
    return {
      dt,
      temp: { min: tmin, max: tmax },
      wind_speed,
      wind_gust,
      pop,
      rain: precip == null ? undefined : precip,
      weather: codeToWeather(code),
      summary: "",
    };
  });

  return {
    lat: params.lat,
    lon: params.lon,
    timezone: typeof raw?.timezone === "string" ? raw.timezone : "UTC",
    timezone_offset: offsetSeconds,
    current: {
      dt: currentDt,
      temp: current?.temperature_2m ?? null,
      wind_speed: current?.wind_speed_10m ?? null,
      wind_gust: current?.wind_gusts_10m ?? null,
      rain: current?.precipitation == null ? undefined : { "1h": current.precipitation },
      weather: codeToWeather(current?.weather_code),
    },
    hourly: hourlyOut,
    daily: dailyOut,
    alerts: null,
    _provider: "open-meteo",
  };
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

