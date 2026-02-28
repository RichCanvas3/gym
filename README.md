# Climb Gym Copilot

Monorepo with:

- Next.js web UI: `apps/web`
- Hosted agent (LangGraph for LangSmith Deployments): `langgraph.json` + `apps/api/graph.py`
- Local JS agent (optional): `apps/web/app/api/chat/route.ts`

## Local dev (web + local JS agent)

```bash
pnpm install
pnpm dev
```

Open `http://localhost:3000/chat`.

## Deploy to LangSmith Deployments (push-to-deploy)

1) Push this repo to GitHub.

2) In LangSmith:
- Go to **Deployments** → **New Deployment**
- Select your repo + branch
- Config path: `langgraph.json`
- Set env vars:
  - `OPENAI_API_KEY`
  - (optional) `OPENAI_MODEL=gpt-5.2`
  - (optional) `OPENAI_EMBEDDINGS_MODEL=text-embedding-3-large`

3) In your Next.js host (Vercel/etc), set env vars:
- `NEXT_PUBLIC_USE_LANGGRAPH=1`
- `LANGGRAPH_DEPLOYMENT_URL=<deployment base url>`
- `LANGGRAPH_ASSISTANT_ID=gym`
- `LANGSMITH_API_KEY=<server-side secret>`

Web calls `POST /api/agent/run` (server-side proxy) → `<DEPLOYMENT_URL>/runs/wait`.

## MCP tools (optional)

The hosted Python agent can load tools from one or more **MCP servers** (recommended transport: **Streamable HTTP**).

- Configure MCP servers via `MCP_SERVERS_JSON` (see `.env.example`).
- Tool governance:
  - `MCP_TOOL_NAME_PREFIX=1` prefixes tool names with `<server>_` to avoid collisions.
  - `MCP_TOOL_ALLOWLIST` / `MCP_TOOL_DENYLIST` (comma-separated) restricts which tools the model can call.

### LangSmith Deployment env vars (copy/paste example)

If you deployed the Workers below, set these in your **LangSmith Deployment** env vars:

- `MCP_TOOL_NAME_PREFIX=1`
- `MCP_SERVERS_JSON={"core":{"transport":"streamable_http","url":"https://gym-core-mcp.richardpedersen3.workers.dev/mcp","headers":{"x-api-key":"gym"}},"sendgrid":{"transport":"streamable_http","url":"https://gym-sendgrid-mcp.richardpedersen3.workers.dev/mcp","headers":{"x-api-key":"gym"}},"weather":{"transport":"streamable_http","url":"https://gym-weather-mcp.richardpedersen3.workers.dev/mcp","headers":{"x-api-key":"gym"}},"scheduling":{"transport":"streamable_http","url":"https://gym-scheduling-mcp.richardpedersen3.workers.dev/mcp","headers":{"x-api-key":"gym"}}}`
- `MCP_TOOL_ALLOWLIST=sendgrid_sendEmail,sendgrid_scheduleEmail,sendgrid_sendEmailWithTemplate,weather_weather_current,weather_weather_forecast_hourly,weather_weather_forecast_daily,weather_weather_alerts,scheduling_schedule_upsert_instructor,scheduling_schedule_list_instructors,scheduling_schedule_create_class,scheduling_schedule_assign_instructor,scheduling_schedule_list_classes,scheduling_schedule_list_reservations,scheduling_schedule_reserve_seat,scheduling_schedule_cancel_reservation,core_core_list_instructors,core_core_list_class_definitions,core_core_upsert_customer,core_core_record_reservation`

Example `MCP_SERVERS_JSON` (core + scheduler + weather + sendgrid):

```json
{
  "core": { "transport": "streamable_http", "url": "https://<core>.workers.dev/mcp", "headers": { "x-api-key": "..." } },
  "scheduling": { "transport": "streamable_http", "url": "https://<scheduling>.workers.dev/mcp", "headers": { "x-api-key": "..." } },
  "weather": { "transport": "streamable_http", "url": "https://<weather>.workers.dev/mcp", "headers": { "x-api-key": "..." } },
  "sendgrid": { "transport": "streamable_http", "url": "https://<sendgrid>.workers.dev/mcp", "headers": { "x-api-key": "..." } }
}
```



Recommended MCP tool categories for a climbing gym:

- **Gym-core (canonical)**: accounts/customers/instructors/class definitions/orders/reservation ledger.
- **Scheduling**: class/private coaching booking + availability.
- **Messaging**: SMS/email confirmations + reminders.
- **Forecast weather**: hourly/daily forecast for outdoor wall operations.

### SendGrid MCP server (Cloudflare Workers)

This repo includes a deployable MCP server you can run on Cloudflare Workers:

- App: `apps/sendgrid-mcp`
- Endpoint: `https://<your-worker>.workers.dev/mcp`
- Tools (prefixed in the gym agent as `sendgrid_<tool>` when `MCP_TOOL_NAME_PREFIX=1`):
  - `sendEmail`
  - `scheduleEmail`
  - `sendEmailWithTemplate`

Deploy steps (high level):

- `pnpm -C apps/sendgrid-mcp dev` (local worker)
- `pnpm -C apps/sendgrid-mcp deploy` (deploy)
- Set Worker secrets:
  - `SENDGRID_API_KEY`
  - `SENDGRID_FROM_EMAIL`
  - (optional) `MCP_API_KEY` (require `x-api-key` header)

Then in your **gym LangSmith Deployment** env vars, set `MCP_SERVERS_JSON` to point at that `/mcp` endpoint.

### Weather MCP server (Cloudflare Workers, OpenWeather One Call 3.0)

This repo includes a deployable MCP server you can run on Cloudflare Workers:

- App: `apps/weather-mcp`
- Endpoint: `https://<your-worker>.workers.dev/mcp`
- Tools (prefixed in the gym agent as `weather_<tool>` when `MCP_TOOL_NAME_PREFIX=1`):
  - `weather_onecall`
  - `weather_current`
  - `weather_forecast_hourly` (up to 48h)
  - `weather_forecast_daily` (up to 8 days)
  - `weather_alerts`

Worker secrets:

- `OPENWEATHER_API_KEY`
- (optional) `MCP_API_KEY` (require `x-api-key` header)

### Gym Core MCP server (Cloudflare Workers + D1)

This repo includes a **D1-backed** canonical data MCP server you can run on Cloudflare Workers:

- App: `apps/gym-core-mcp`
- Endpoint: `https://<your-core-worker>.workers.dev/mcp`
- Tools (prefixed in the gym agent as `core_<tool>` when `MCP_TOOL_NAME_PREFIX=1`):
  - `core_upsert_account`, `core_get_account`
  - `core_upsert_customer`
  - `core_upsert_instructor`, `core_list_instructors`
  - `core_upsert_class_definition`, `core_list_class_definitions`
  - `core_create_order`
  - `core_record_reservation`
  - `core_set_gym_metadata`, `core_get_gym_metadata`

Setup:

- Create a D1 DB: `wrangler d1 create gym-core`
- Put the `database_id` into `apps/gym-core-mcp/wrangler.jsonc`
- Apply schema (remote): `wrangler d1 execute gym-core --remote --file apps/gym-core-mcp/schema.sql`
- Run locally: `pnpm -C apps/gym-core-mcp dev`

Env vars (see `.env.example`):

- (optional) `MCP_API_KEY` (require `x-api-key` header)

### Scheduling MCP server (Cloudflare Workers + D1)

This repo includes a **D1-backed** scheduling MCP server you can run on Cloudflare Workers:

- Scheduler-only: stores class occurrences, instructor assignment, reservations, availability. It references users/instructors by **canonical account address** (string) and does not store canonical account rows.

- App: `apps/scheduling-mcp`
- Endpoint: `https://<your-worker>.workers.dev/mcp`
- Tools (prefixed in the gym agent as `scheduling_<tool>` when `MCP_TOOL_NAME_PREFIX=1`):
  - `schedule_upsert_instructor`
  - `schedule_list_instructors`
  - `schedule_create_class`
  - `schedule_get_class`
  - `schedule_assign_instructor`
  - `schedule_list_classes`
  - `schedule_class_availability`
  - `schedule_list_reservations`
  - `schedule_reserve_seat`
  - `schedule_cancel_reservation`

Setup:

- Create a D1 DB: `wrangler d1 create gym-scheduling`
- Put the `database_id` into `apps/scheduling-mcp/wrangler.jsonc`
- Apply schema (remote): `wrangler d1 execute gym-scheduling --remote --file apps/scheduling-mcp/schema.sql`
- If upgrading from the older v1/v2 schemas:
  - v1 → v2 (accounts/customers): `wrangler d1 execute gym-scheduling --remote --file apps/scheduling-mcp/migrations/v1_to_v2_accounts.sql`
  - v2 → v3 (scheduler-only): `wrangler d1 execute gym-scheduling --remote --file apps/scheduling-mcp/migrations/v2_to_v3_scheduler_only.sql`
- Run locally: `pnpm -C apps/scheduling-mcp dev`

Env vars (see `.env.example`):

- (optional) `MCP_API_KEY` (require `x-api-key` header)

