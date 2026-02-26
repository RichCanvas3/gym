from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Optional
from datetime import datetime, timezone

import httpx


DEFAULT_LOCATION = {"lat": 40.015, "lon": -105.2705, "label": "Boulder, CO"}


@dataclass(frozen=True)
class WeatherAssessment:
    status: Literal["open_ok", "caution", "closed", "unknown"]
    reason: str


def assess_outdoor(precip_mm: float | None, wind_mps: float | None, code: int | None) -> WeatherAssessment:
    precip = precip_mm or 0.0
    wind = wind_mps or 0.0

    thunder_like = code in (95, 96, 99)
    heavy_precip_like = code in (65, 67, 75, 77, 82)

    if thunder_like:
        return WeatherAssessment(status="closed", reason="Thunderstorm conditions.")
    if heavy_precip_like:
        return WeatherAssessment(status="closed", reason="Heavy precipitation/snow conditions.")
    if precip >= 2.0:
        return WeatherAssessment(status="closed", reason="Active precipitation (slick surfaces).")
    if wind >= 12.0:
        return WeatherAssessment(status="closed", reason="High winds.")
    if precip > 0.0:
        return WeatherAssessment(status="caution", reason="Light precipitation—conditions may be slick.")
    if wind >= 8.0:
        return WeatherAssessment(status="caution", reason="Breezy conditions.")
    return WeatherAssessment(status="open_ok", reason="No active precipitation and winds are mild.")


async def get_current_weather(lat: float | None = None, lon: float | None = None, label: str | None = None) -> dict[str, Any]:
    as_of = datetime.now(timezone.utc).isoformat()
    lat_v = lat if isinstance(lat, (int, float)) else DEFAULT_LOCATION["lat"]
    lon_v = lon if isinstance(lon, (int, float)) else DEFAULT_LOCATION["lon"]
    label_v = label.strip() if isinstance(label, str) and label.strip() else DEFAULT_LOCATION["label"]

    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": str(lat_v),
        "longitude": str(lon_v),
        "current": "temperature_2m,precipitation,wind_speed_10m,weather_code",
        "timezone": "auto",
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(url, params=params, headers={"accept": "application/json"})
            if r.status_code != 200:
                return {
                    "ok": False,
                    "asOfISO": as_of,
                    "location": {"lat": lat_v, "lon": lon_v, "label": label_v},
                    "assessment": {"status": "unknown", "reason": f"Weather provider error ({r.status_code})."},
                }
            j = r.json()
    except Exception as e:
        return {
            "ok": False,
            "asOfISO": as_of,
            "location": {"lat": lat_v, "lon": lon_v, "label": label_v},
            "assessment": {"status": "unknown", "reason": str(e)},
        }

    cur = (j or {}).get("current") or {}
    temp = cur.get("temperature_2m")
    precip = cur.get("precipitation")
    wind = cur.get("wind_speed_10m")
    code = cur.get("weather_code")

    temp_c = float(temp) if isinstance(temp, (int, float)) else None
    precip_mm = float(precip) if isinstance(precip, (int, float)) else None
    wind_mps = float(wind) if isinstance(wind, (int, float)) else None
    code_i = int(code) if isinstance(code, (int, float)) else None

    assessment = assess_outdoor(precip_mm, wind_mps, code_i)

    return {
        "ok": True,
        "asOfISO": as_of,
        "location": {"lat": lat_v, "lon": lon_v, "label": label_v},
        "current": {
            "temperatureC": temp_c,
            "windSpeedMps": wind_mps,
            "precipitationMm": precip_mm,
            "weatherCode": code_i,
        },
        "assessment": {"status": assessment.status, "reason": assessment.reason},
    }

