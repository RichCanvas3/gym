export type WeatherResult = {
  ok: boolean;
  asOfISO: string;
  location: { lat: number; lon: number; label: string };
  current?: {
    temperatureC?: number;
    windSpeedMps?: number;
    precipitationMm?: number;
    weatherCode?: number;
  };
  assessment:
    | { status: "open_ok"; reason: string }
    | { status: "caution"; reason: string }
    | { status: "closed"; reason: string }
    | { status: "unknown"; reason: string };
};

const DEFAULT_LOCATION = {
  // Boulder, CO (approx)
  lat: 40.015,
  lon: -105.2705,
  label: "Boulder, CO",
};

export async function getCurrentWeather(input?: {
  lat?: number;
  lon?: number;
  label?: string;
}): Promise<WeatherResult> {
  const asOfISO = new Date().toISOString();
  const lat = typeof input?.lat === "number" ? input.lat : DEFAULT_LOCATION.lat;
  const lon = typeof input?.lon === "number" ? input.lon : DEFAULT_LOCATION.lon;
  const label =
    typeof input?.label === "string" && input.label.trim()
      ? input.label
      : DEFAULT_LOCATION.label;

  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(lat));
    url.searchParams.set("longitude", String(lon));
    url.searchParams.set("current", "temperature_2m,precipitation,wind_speed_10m,weather_code");
    url.searchParams.set("timezone", "auto");

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { "accept": "application/json" },
      // Next.js route runtime is nodejs; no caching for real-time-ish behavior
      cache: "no-store",
    });

    if (!res.ok) {
      return {
        ok: false,
        asOfISO,
        location: { lat, lon, label },
        assessment: { status: "unknown", reason: `Weather provider error (${res.status}).` },
      };
    }

    const json = (await res.json().catch(() => null)) as any;
    const current = json?.current ?? {};

    const temperatureC = numberOrUndefined(current.temperature_2m);
    const precipitationMm = numberOrUndefined(current.precipitation);
    const windSpeedMps = numberOrUndefined(current.wind_speed_10m);
    const weatherCode = numberOrUndefined(current.weather_code);

    const assessment = assessOutdoor({
      precipitationMm,
      windSpeedMps,
      weatherCode,
    });

    return {
      ok: true,
      asOfISO,
      location: { lat, lon, label },
      current: { temperatureC, windSpeedMps, precipitationMm, weatherCode },
      assessment,
    };
  } catch (e) {
    return {
      ok: false,
      asOfISO,
      location: { lat, lon, label },
      assessment: {
        status: "unknown",
        reason: e instanceof Error ? e.message : "Weather lookup failed.",
      },
    };
  }
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function assessOutdoor(input: {
  precipitationMm?: number;
  windSpeedMps?: number;
  weatherCode?: number;
}): WeatherResult["assessment"] {
  // Simple, conservative rules for an outdoor wall:
  // - Any precip => caution/closed depending on amount
  // - Strong wind => caution/closed
  // - Certain weather codes => closed (thunderstorm, heavy precip)
  const precip = input.precipitationMm ?? 0;
  const wind = input.windSpeedMps ?? 0;
  const code = input.weatherCode;

  // Open-Meteo weather codes: https://open-meteo.com/en/docs
  const thunderLike = code != null && (code === 95 || code === 96 || code === 99);
  const heavyPrecipLike = code != null && (code === 65 || code === 67 || code === 75 || code === 77 || code === 82);

  if (thunderLike) return { status: "closed", reason: "Thunderstorm conditions." };
  if (heavyPrecipLike) return { status: "closed", reason: "Heavy precipitation/snow conditions." };
  if (precip >= 2) return { status: "closed", reason: "Active precipitation (slick surfaces)." };
  if (wind >= 12) return { status: "closed", reason: "High winds." };
  if (precip > 0) return { status: "caution", reason: "Light precipitation—conditions may be slick." };
  if (wind >= 8) return { status: "caution", reason: "Breezy conditions." };
  return { status: "open_ok", reason: "No active precipitation and winds are mild." };
}

