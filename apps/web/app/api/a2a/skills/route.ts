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
        id: "telegram_import",
        label: "Telegram auto import (Smart Agent): meals + weigh-ins",
        tools: [
          "telegram_telegram_list_chats",
          "telegram_telegram_list_messages",
          "telegram_telegram_search_messages",
          "weight_weight_log_meal_from_text",
          "weight_weight_log_weight",
        ],
      },
      {
        id: "scheduling",
        label: "Scheduling + reservations (internal D1)",
        tools: [
          "scheduling_schedule_list_classes",
          "scheduling_schedule_get_class",
          "scheduling_schedule_class_availability",
          "scheduling_schedule_reserve_seat",
          "scheduling_schedule_cancel_reservation",
          "scheduling_schedule_list_reservations",
        ],
      },
      {
        id: "core",
        label: "Canonical gym data (products, instructors, class defs)",
        tools: [
          "core_core_get_gym_metadata",
          "core_core_set_gym_metadata",
          "core_core_list_instructors",
          "core_core_list_class_definitions",
          "core_core_list_products",
          "core_core_list_class_def_products",
          "core_core_record_reservation",
          "core_core_create_order",
          "core_core_memory_list_messages",
          "core_core_memory_append_message",
        ],
      },
      {
        id: "content",
        label: "Content + Erie web crawl (KB)",
        tools: [
          "content_content_list_docs",
          "content_content_get_doc_by_entity",
          "content_content_upsert_doc",
          "content_content_crawl_erie_now",
        ],
      },
      {
        id: "native",
        label: "Agent-native helpers",
        tools: ["fitness_snapshot", "knowledge_search", "ops_search_classes", "ops_class_availability", "ops_reserve_class"],
      },
    ],
  });
}

