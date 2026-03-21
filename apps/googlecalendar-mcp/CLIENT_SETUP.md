# Google Calendar MCP — Client setup

How to configure your **agent / client** (e.g. LangSmith Deployment, myclaw) to use the Google Calendar MCP endpoints.

---

## 1. Worker URL and auth

- **Base URL:** Your deployed worker, e.g. `https://gym-googlecalendar-mcp.<your-subdomain>.workers.dev`
- **MCP endpoint:** `{BASE_URL}/mcp`
- **Auth:** Every request must include header `x-api-key: <MCP_API_KEY>` (the value you set as the worker secret `MCP_API_KEY`).

---

## 2. Add the server to your agent (LangSmith Deployment)

In your **LangSmith Deployment** (or wherever the gym agent runs), set environment variables so the agent can call this MCP.

### 2.1 Add the server to `MCP_SERVERS_JSON`

Append (or merge) the `googlecalendar` entry. Single-server example:

```json
{
  "googlecalendar": {
    "transport": "streamable_http",
    "url": "https://gym-googlecalendar-mcp.<your-subdomain>.workers.dev/mcp",
    "headers": {
      "x-api-key": "gym"
    }
  }
}
```

If you already have other servers, add the `"googlecalendar": { ... }` key to the same JSON object. Example with core + sendgrid + googlecalendar:

```json
{
  "core": { "transport": "streamable_http", "url": "https://gym-core-mcp..../mcp", "headers": { "x-api-key": "gym" } },
  "sendgrid": { "transport": "streamable_http", "url": "https://gym-sendgrid-mcp..../mcp", "headers": { "x-api-key": "gym" } },
  "googlecalendar": {
    "transport": "streamable_http",
    "url": "https://gym-googlecalendar-mcp.<your-subdomain>.workers.dev/mcp",
    "headers": { "x-api-key": "gym" }
  }
}
```

- Replace `<your-subdomain>.workers.dev` with your worker’s host (e.g. `richardpedersen3.workers.dev`).
- Use the same `x-api-key` value that you set as the worker secret `MCP_API_KEY`.

### 2.2 Allow the calendar tools (`MCP_TOOL_ALLOWLIST`)

If your agent uses `MCP_TOOL_ALLOWLIST`, add the Google Calendar tool names. With **`MCP_TOOL_NAME_PREFIX=1`** (default), tools are prefixed with the server key `googlecalendar_`, so the names are:

| Tool | Prefixed name (use in allowlist) |
|------|----------------------------------|
| Health check | `googlecalendar_googlecalendar_ping` |
| Connection status | `googlecalendar_googlecalendar_get_connection_status` |
| Free/busy | `googlecalendar_googlecalendar_freebusy` |
| List calendars | `googlecalendar_googlecalendar_list_calendars` |
| List events | `googlecalendar_googlecalendar_list_events` |
| Create event | `googlecalendar_googlecalendar_create_event` |
| Update event | `googlecalendar_googlecalendar_update_event` |
| Delete event | `googlecalendar_googlecalendar_delete_event` |

Append these to your comma-separated allowlist (no spaces), e.g.:

```
...,googlecalendar_googlecalendar_ping,googlecalendar_googlecalendar_get_connection_status,googlecalendar_googlecalendar_freebusy,googlecalendar_googlecalendar_list_calendars,googlecalendar_googlecalendar_list_events,googlecalendar_googlecalendar_create_event,googlecalendar_googlecalendar_update_event,googlecalendar_googlecalendar_delete_event
```

If you don’t use an allowlist, the agent will see all tools from all configured MCP servers.

---

## 3. Send all events to the “myclaw” calendar

By default, create/list/update use the user’s **primary** calendar. To send everything to a specific calendar (e.g. “myclaw”):

1. **Get the calendar id**  
   Call **googlecalendar_list_calendars** once with the user’s `accountAddress`. In the response, find the calendar whose `summary` is `"myclaw"` and copy the **`id`** field (e.g. `xxxx@group.calendar.google.com` or a long opaque string).  
   **Important:** `TARGET_CALENDAR_ID` must be that **`id`**, not the display name `myclaw`. Using the name alone causes Google **404 Not Found**.

2. **Set the worker config**  
   In the **Cloudflare Worker** that runs googlecalendar-mcp:
   - **Dashboard:** Workers & Pages → gym-googlecalendar-mcp → Settings → Variables and Secrets → Add variable `TARGET_CALENDAR_ID` (value = that calendar id), or
   - **CLI:** `cd apps/googlecalendar-mcp && pnpm exec wrangler secret put TARGET_CALENDAR_ID` and paste the **`id`** exactly.

3. **Redeploy** the worker. After that, create_event, list_events, and update_event all use that calendar.

**Updates:** **googlecalendar_update_event** needs an `eventId` for an event that exists **on that same calendar**. If you previously created events on **primary** and then set `TARGET_CALENDAR_ID`, old event ids will 404—create new events (or list on the target calendar) and use those ids.

---

## 4. User OAuth (accountAddress)

The MCP stores tokens **per account address**. The client must use a stable **accountAddress** (e.g. from your app’s waiver/canonical account: `acct_cust_casey`).

- **First-time connect:** The user must complete OAuth once. Direct them to:
  `https://gym-googlecalendar-mcp.<your-subdomain>.workers.dev/oauth/start?accountAddress=<accountAddress>`
  They sign in with Google; the worker stores the refresh token for that `accountAddress`.

- **Check status:** The agent can call **googlecalendar_get_connection_status** with that `accountAddress` to see if the user is connected and get an auth URL if not.

- **All tools** take `accountAddress` (except ping). Use the same value the rest of your system uses for that user (e.g. from session/waiver).

---

## 5. Tool parameters (reference)

| Tool | Parameters |
|------|------------|
| **googlecalendar_get_connection_status** | `accountAddress` (string) |
| **googlecalendar_freebusy** | `accountAddress`, `timeMinISO`, `timeMaxISO` |
| **googlecalendar_list_calendars** | `accountAddress` |
| **googlecalendar_list_events** | `accountAddress`, `timeMinISO`, `timeMaxISO`, optional: `q`, `maxResults` |
| **googlecalendar_create_event** | `accountAddress`, `summary`, `startISO`, `endISO`, optional: `description` |
| **googlecalendar_update_event** | `accountAddress`, `eventId`, optional: `summary`, `description`, `startISO`, `endISO` (partial update) |
| **googlecalendar_delete_event** | `accountAddress`, `eventId`, optional: `sendUpdates` (`all` \| `externalOnly` \| `none`, default `all`) |

- **Times:** ISO 8601 with timezone (e.g. `2026-06-27T09:00:00.000Z`).
- **eventId:** From a previous create_event or list_events response (`event.id`) **on the same calendar** (primary or `TARGET_CALENDAR_ID` / myclaw).

**Change vs delete**

- **Change** an entry: call **googlecalendar_update_event** with the `eventId` and any fields to change.
- **Remove** an entry: call **googlecalendar_delete_event** with the same `accountAddress` and `eventId`.

---

## 6. Testing with curl

Replace `BASE`, `KEY`, and `accountAddress` as needed.

**Connection status:**
```bash
BASE=https://gym-googlecalendar-mcp.<your-subdomain>.workers.dev
KEY=gym
curl -sS -N \
  -H "accept: application/json, text/event-stream" \
  -H "content-type: application/json" \
  -H "x-api-key: $KEY" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"googlecalendar_get_connection_status","arguments":{"accountAddress":"acct_cust_casey"}}}' \
  "$BASE/mcp"
```

**List calendars (to find “myclaw” id):**
```bash
curl -sS -N \
  -H "accept: application/json, text/event-stream" \
  -H "content-type: application/json" \
  -H "x-api-key: $KEY" \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"googlecalendar_list_calendars","arguments":{"accountAddress":"acct_cust_casey"}}}' \
  "$BASE/mcp"
```

**Create event:**
```bash
curl -sS -N \
  -H "accept: application/json, text/event-stream" \
  -H "content-type: application/json" \
  -H "x-api-key: $KEY" \
  --data '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"googlecalendar_create_event","arguments":{"accountAddress":"acct_cust_casey","summary":"Test from MCP","startISO":"2026-06-27T14:00:00.000Z","endISO":"2026-06-27T15:00:00.000Z"}}}' \
  "$BASE/mcp"
```

If your agent uses the **prefixed** tool names (e.g. `googlecalendar_googlecalendar_create_event`), use that in the `"name"` field when calling via raw JSON-RPC.

---

## 7. Summary checklist for “client” (myclaw / LangSmith)

- [ ] Worker deployed and MCP endpoint reachable at `https://.../mcp`.
- [ ] `MCP_SERVERS_JSON` includes the `googlecalendar` entry with correct `url` and `headers.x-api-key`.
- [ ] `MCP_TOOL_ALLOWLIST` includes the googlecalendar tools (if you use an allowlist).
- [ ] (Optional) Worker has `TARGET_CALENDAR_ID` set so all events go to “myclaw”.
- [ ] Users complete OAuth once via `/oauth/start?accountAddress=<id>`; agent uses the same `accountAddress` in all calendar tool calls.
