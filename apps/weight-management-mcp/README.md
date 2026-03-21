# weight-management-mcp (`gym-weight`)

Cloudflare Worker MCP for weight, food, meal-photo estimates (vision), water, fasting windows, and daily targets (Yazio-style **data**, no app-specific diet logic).

**Repo:** [`apps/weight-management-mcp`](.) in the gym monorepo (imported from [myclaw](https://github.com/RichCanvas3/myclaw)).

## Worker secrets / vars

- `WEIGHT_MCP_LOG` — optional; default **`1`** in `wrangler.jsonc`. Set **`0`** in the dashboard to disable `[weight-mcp]` console logs (use `wrangler tail` / dashboard to view).
- `MCP_API_KEY` — `x-api-key` for `/mcp`
- `VISION_API_KEY`, `VISION_MODEL` (default `gpt-4o-mini`), optional `VISION_OPENAI_BASE_URL` — OpenAI-compatible vision for `weight_analyze_meal_photo`

This worker does **not** integrate with Telegram: callers pass **`imageUrl` (https)** only. Public image URLs (e.g. `https://…/telegram/media/…` from another service) are fetched server-side with no extra auth.

## D1

Database: **`gym-weight`** (binding `DB`). Apply migrations:

```bash
pnpm db:migrate
# or: pnpm exec wrangler d1 migrations apply gym-weight --remote
```

## LangSmith / LangGraph

Configure the LangGraph deployment so the agent can reach this MCP.

### `MCP_SERVERS_JSON` (example fragment)

Add a server entry (adjust URL to your deployed worker):

```json
{
  "gym-weight": {
    "url": "https://<your-gym-weight-worker>/mcp",
    "headers": { "x-api-key": "<same as GYM_MCP_API_KEY>" }
  }
}
```

If your stack names servers by full id, use `"gym-weight"` consistently with myclaw’s registry id.

### `MCP_TOOL_ALLOWLIST`

Prefix pattern matches how your deployment maps server id → tool names. If tools are exposed as `gym-weight_weight_*` or `weight_*` only, align with your gateway. Typical allowlist entries to add:

- `weight_ping`
- `weight_profile_get`, `weight_profile_upsert`
- `weight_log_weight`, `weight_list_weights`
- `weight_log_food`, `weight_list_food`
- `weight_log_photo`, `weight_list_photos`
- `weight_day_summary`, `weight_week_summary`
- `weight_analyze_meal_photo`, `weight_log_food_from_analysis`
- `weight_lookup_barcode`
- `weight_target_get`, `weight_target_upsert`
- `weight_water_log`, `weight_water_list`
- `weight_fast_start`, `weight_fast_end`, `weight_fast_list`

**Meal photos:** prefer `weight_analyze_meal_photo` then `weight_log_food_from_analysis` after the user confirms portions.

**Batch URLs (client-side):** [scripts/fetch-image-urls-from-telegram-mcp.mjs](./scripts/fetch-image-urls-from-telegram-mcp.mjs) calls **telegram-mcp** `telegram_list_messages` and writes `urls.txt`; then [scripts/batch-analyze-meal-photos.mjs](./scripts/batch-analyze-meal-photos.mjs) sends each URL to `weight_analyze_meal_photo`.

See [docs/client-meal-images.md](./docs/client-meal-images.md).
