import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // Static “capability” description for clients. Source of truth is still MCP tool discovery
  // by the hosted agent, governed by MCP_SERVERS_JSON + MCP_TOOL_ALLOWLIST.
  return NextResponse.json({
    ok: true,
    requires: {
      env: ["LANGGRAPH_DEPLOYMENT_URL", "LANGSMITH_API_KEY"],
      mcp: ["MCP_SERVERS_JSON", "MCP_TOOL_NAME_PREFIX=1", "MCP_TOOL_ALLOWLIST"],
    },
    capabilities: [
      {
        id: "strava",
        label: "Exercise (Strava)",
        tools: [
          "strava_strava_sync",
          "strava_strava_list_workouts",
          "strava_strava_get_workout",
          "strava_strava_latest_workout",
        ],
      },
      {
        id: "weight",
        label: "Weight + meals",
        tools: [
          "weight_weight_day_summary",
          "weight_weight_log_weight",
          "weight_weight_list_weights",
          "weight_weight_log_food",
          "weight_weight_list_food",
          "weight_weight_log_meal_from_text",
        ],
      },
      {
        id: "telegram_meal_import",
        label: "Telegram meal-text auto import (Smart Agent)",
        tools: [
          "telegram_telegram_list_chats",
          "telegram_telegram_list_messages",
          "telegram_telegram_search_messages",
          "weight_weight_log_meal_from_text",
        ],
      },
    ],
  });
}

