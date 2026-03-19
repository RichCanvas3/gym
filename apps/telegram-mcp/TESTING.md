# Testing telegram-mcp

## 1. Local env

Create `apps/telegram-mcp/.dev.vars`:

```env
MCP_API_KEY=gym
TELEGRAM_BOT_TOKEN=123456789:ABC...your-token-from-BotFather
TELEGRAM_WEBHOOK_SECRET=your-webhook-secret
```

- `MCP_API_KEY`: required for `/mcp`; use the same value in `x-api-key` when calling MCP.
- `TELEGRAM_BOT_TOKEN`: required for any tool that calls Telegram (ping is local-only; set_webhook, send_message, list_chats, etc. need it).
- `TELEGRAM_WEBHOOK_SECRET`: optional; if set, webhook requests must send `x-telegram-bot-api-secret-token: <this value>`.

## 2. Apply schema

**Local D1** (for `pnpm dev`):

```bash
cd apps/telegram-mcp
pnpm exec wrangler d1 execute gym-telegram --local --file schema.sql
```

**Remote D1** (required for deployed worker; webhook writes here):

```bash
cd apps/telegram-mcp
pnpm exec wrangler d1 execute gym-telegram --remote --file schema.sql
```

If you only applied the schema locally, the deployed worker has no tables, so webhook writes can fail (you’d see 500) or you’re checking the wrong DB. `telegram_list_chats` / `telegram_list_messages` on the **deployed** worker read from **remote** D1.

## 3. Run locally

```bash
cd apps/telegram-mcp
pnpm dev
```

Default: `http://localhost:8787`. MCP endpoint: `http://localhost:8787/mcp`.

## 4. Call MCP tools (curl)

Use Streamable HTTP JSON-RPC. Replace `YOUR_API_KEY` and base URL (local or deployed).

**Ping (no Telegram token needed):**

```bash
curl -sS -N -m 10 \
  -H "accept: application/json, text/event-stream" \
  -H "content-type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"telegram_ping","arguments":{}}}' \
  http://localhost:8787/mcp
```

**List chats (from D1; need webhook to have received messages first):**

```bash
curl -sS -N -m 10 \
  -H "accept: application/json, text/event-stream" \
  -H "content-type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"telegram_list_chats","arguments":{"limit":20}}}' \
  http://localhost:8787/mcp
```

**List messages for a group (use `chatId` from list_chats; often negative number for groups):**

```bash
curl -sS -N -m 10 \
  -H "accept: application/json, text/event-stream" \
  -H "content-type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  --data '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"telegram_list_messages","arguments":{"chatId":"-1001234567890","limit":20}}}' \
  http://localhost:8787/mcp
```

**Search messages (optional `chatId`):**

```bash
curl -sS -N -m 10 \
  -H "accept: application/json, text/event-stream" \
  -H "content-type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  --data '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"telegram_search_messages","arguments":{"query":"ENS","limit":10}}}' \
  http://localhost:8787/mcp
```

**Get webhook info (needs TELEGRAM_BOT_TOKEN):**

```bash
curl -sS -N -m 10 \
  -H "accept: application/json, text/event-stream" \
  -H "content-type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  --data '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"telegram_get_webhook_info","arguments":{}}}' \
  http://localhost:8787/mcp
```

## 5. Configure webhook for a group (so list_chats has data)

1. **Deploy the worker** (Telegram can’t POST to localhost):
   ```bash
   cd apps/telegram-mcp && pnpm deploy
   ```
   Note the URL, e.g. `https://gym-telegram-mcp.<subdomain>.workers.dev`.

2. **Set the webhook** (one-time per bot). Use the MCP tool or curl to your worker:
   ```bash
   BASE=https://gym-telegram-mcp.<subdomain>.workers.dev
   curl -sS -N -m 15 \
     -H "accept: application/json, text/event-stream" \
     -H "content-type: application/json" \
     -H "x-api-key: gym" \
     --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"telegram_set_webhook\",\"arguments\":{\"url\":\"${BASE}/telegram/webhook\",\"secretToken\":\"your-webhook-secret\"}}}" \
     ${BASE}/mcp
   ```
   Use the same `secretToken` as `TELEGRAM_WEBHOOK_SECRET` in the worker (`wrangler secret put TELEGRAM_WEBHOOK_SECRET`). **Do not use your bot token** as the secret—Telegram rejects it. Use a random alphanumeric string (e.g. `openssl rand -hex 24`). If you don’t use a secret, omit `secretToken` and leave the env unset.

3. **Add the bot to the group**: In Telegram, open the group → Add members → your bot (@username) → add. An admin must add it.

4. **Let the bot see all messages**: In Telegram, [@BotFather](https://t.me/BotFather) → `/setprivacy` → select your bot → **Disable**. Then the bot receives every message in groups it’s in.

5. **Send a message in the group**. The worker gets POSTs at `/telegram/webhook` and writes chats/messages to D1.

6. **Check**: Call `telegram_list_chats`; you should see the group. Use its `chatId` in `telegram_list_messages` or `telegram_search_messages`.

**Local testing:** Telegram can’t reach localhost. Use a tunnel (e.g. `ngrok http 8787`) and set webhook URL to `https://<ngrok-host>/telegram/webhook`. Put the same secret in `.dev.vars` as `TELEGRAM_WEBHOOK_SECRET`.

## 6. Remote operations (deployed worker)

Use these steps to run and operate the **deployed** telegram-mcp worker. Set `BASE` to your worker URL (e.g. `https://gym-telegram-mcp.richardpedersen3.workers.dev`) and run from `apps/telegram-mcp` unless noted.

### 6.1 Deploy and database

```bash
cd apps/telegram-mcp

# Deploy the worker
pnpm deploy

# Create tables on remote D1 (required for webhook and list_chats / list_messages)
pnpm exec wrangler d1 execute gym-telegram --remote --file schema.sql
```

### 6.2 Secrets (Cloudflare dashboard or CLI)

Set secrets for the **deployed** worker so it can call Telegram and (optionally) verify webhooks:

```bash
cd apps/telegram-mcp

# Required: bot token from @BotFather
pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN

# Required for MCP: API key used in x-api-key when calling /mcp
pnpm exec wrangler secret put MCP_API_KEY

# Optional: webhook secret (only if you set secretToken when setting the webhook)
# Use a random alphanumeric string; do not use the bot token.
pnpm exec wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

### 6.3 Set webhook (one-time per bot)

Point Telegram at your worker’s webhook URL. Without a secret:

```bash
BASE=https://gym-telegram-mcp.richardpedersen3.workers.dev   # your worker URL
curl -sS -N -m 15 \
  -H "accept: application/json, text/event-stream" \
  -H "content-type: application/json" \
  -H "x-api-key: gym" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"telegram_set_webhook","arguments":{"url":"'"${BASE}"'/telegram/webhook"}}}' \
  "${BASE}/mcp"
```

With a secret: generate a safe token (e.g. `SECRET=$(openssl rand -hex 24)`), add `"secretToken":"'"${SECRET}"'"` to the `arguments` object, set `TELEGRAM_WEBHOOK_SECRET` to the same value (see §6.2), then run the curl with that `secretToken`.

### 6.4 Call MCP tools (remote)

Use the same `BASE` and your MCP API key. Examples:

```bash
BASE=https://gym-telegram-mcp.richardpedersen3.workers.dev
KEY=gym

# Health check
curl -sS -N -m 10 -H "accept: application/json, text/event-stream" -H "content-type: application/json" -H "x-api-key: $KEY" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"telegram_ping","arguments":{}}}' \
  "${BASE}/mcp"

# Webhook status (requires TELEGRAM_BOT_TOKEN)
curl -sS -N -m 10 -H "accept: application/json, text/event-stream" -H "content-type: application/json" -H "x-api-key: $KEY" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"telegram_get_webhook_info","arguments":{}}}' \
  "${BASE}/mcp"

# List chats (from remote D1)
curl -sS -N -m 10 -H "accept: application/json, text/event-stream" -H "content-type: application/json" -H "x-api-key: $KEY" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"telegram_list_chats","arguments":{"limit":20}}}' \
  "${BASE}/mcp"

# List messages for a group (replace CHAT_ID with chatId from list_chats)
curl -sS -N -m 10 -H "accept: application/json, text/event-stream" -H "content-type: application/json" -H "x-api-key: $KEY" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"telegram_list_messages","arguments":{"chatId":"CHAT_ID","limit":20}}}' \
  "${BASE}/mcp"

# Search messages
curl -sS -N -m 10 -H "accept: application/json, text/event-stream" -H "content-type: application/json" -H "x-api-key: $KEY" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"telegram_search_messages","arguments":{"query":"a","limit":10}}}' \
  "${BASE}/mcp"
```

### 6.5 Inspect remote D1

```bash
cd apps/telegram-mcp

pnpm exec wrangler d1 execute gym-telegram --remote --command "SELECT COUNT(*) AS chats FROM telegram_chats"
pnpm exec wrangler d1 execute gym-telegram --remote --command "SELECT COUNT(*) AS messages FROM telegram_messages"
pnpm exec wrangler d1 execute gym-telegram --remote --command "SELECT raw_json FROM telegram_updates LIMIT 1"
```

---

**Deployed base URL:** Replace `http://localhost:8787` with your worker URL (e.g. `https://gym-telegram-mcp.<your-subdomain>.workers.dev`) when calling the MCP endpoint.

## 7a. Webhook returns 401 Unauthorized

If `telegram_get_webhook_info` shows `last_error_message: "Wrong response from the webhook: 401 Unauthorized"`, Telegram is sending updates but the worker rejects them because of **webhook secret**. Notifications will not work until the webhook accepts requests (no 401).

**Quick fix (if you are not using a secret_token with setWebhook):** From the project that deploys to your worker URL, run:
```bash
cd apps/telegram-mcp
pnpm exec wrangler secret delete TELEGRAM_WEBHOOK_SECRET
```
If the secret doesn’t exist, the command is harmless. Redeploy if needed, then send a test message in the chat; `telegram_get_webhook_info` should show no `last_error_message`.

Details:

- The worker only checks a secret when **TELEGRAM_WEBHOOK_SECRET** is set (Cloudflare secret). If you set the webhook **without** a `secret_token`, Telegram does not send `X-Telegram-Bot-Api-Secret-Token`, so the worker returns 401.

**Fix (choose one):**

1. **Accept webhooks without a secret** (simplest): remove the env secret so the worker does not require the header:
   ```bash
   cd apps/telegram-mcp
   pnpm exec wrangler secret delete TELEGRAM_WEBHOOK_SECRET
   ```
   Redeploy if needed. Then set the webhook without `secret_token` (e.g. via `telegram_set_webhook` with no `secretToken`).

2. **Use a secret:** generate a value (e.g. `openssl rand -hex 24`), set it as a Cloudflare secret:
   ```bash
   pnpm exec wrangler secret put TELEGRAM_WEBHOOK_SECRET
   ```
   Then set the webhook **with** that same value as `secret_token` (e.g. `telegram_set_webhook` with `secretToken: "<that-value>"`). Do **not** use the bot token as the secret—Telegram rejects non‑alphanumeric characters in the secret.

After fixing, send a message in the chat and confirm `telegram_get_webhook_info` has no `last_error_message` and that messages appear in D1.

**Note:** If you use `curl ... | head -c N`, curl may exit with code 23 (Failure writing output) because `head` closes the pipe after N bytes. To avoid that, use `curl ... 2>/dev/null | head -c N` or run curl without piping to `head`.

## 7. Webhook 200 but nothing in the database

- **Deployed worker uses remote D1.** Apply the schema on remote (see §2) if you haven’t:
  ```bash
  cd apps/telegram-mcp
  pnpm exec wrangler d1 execute gym-telegram --remote --file schema.sql
  ```
- **Check remote D1** (local DB is separate):
  ```bash
  pnpm exec wrangler d1 execute gym-telegram --remote --command "SELECT COUNT(*) AS n FROM telegram_chats"
  pnpm exec wrangler d1 execute gym-telegram --remote --command "SELECT COUNT(*) AS n FROM telegram_messages"
  ```
- If counts stay 0 after new group messages, the webhook may be receiving non-message updates. **Inspect one update:**
  ```bash
  pnpm exec wrangler d1 execute gym-telegram --remote --command "SELECT raw_json FROM telegram_updates LIMIT 1"
  ```
  If the JSON has no `"message"` key (only `update_id`, or `my_chat_member`, etc.), then either:
  - **Bot privacy is still on** → In @BotFather run `/setprivacy` → your bot → **Disable**, so the bot receives all group messages, or
  - Only non-message events are being sent (e.g. bot added to group); send a normal **text message** in the group and check again.

## 8. Notify MCP client when Telegram adds a message (by chatId or title)

The server exposes **MCP Resources** for chat messages and supports **subscribe**. When new messages arrive in a chat, subscribed clients receive `notifications/resources/updated` (on their next MCP request) or can poll with a tool.

### Resource URIs

- **By chatId:** `telegram://chat/{chatId}/messages` (e.g. `telegram://chat/-1003743757503/messages`)
- **By title:** `telegram://chat/by-title/{encodedTitle}/messages` (e.g. `telegram://chat/by-title/Smart%20Agent/messages`)

### Session ID

Notifications are scoped to the **MCP session**. The worker **always returns an `mcp-session-id` response header**: if the client sends `mcp-session-id`, it is echoed; otherwise the worker generates one (UUID). Capture it from the first response and send the same value on every subsequent request so subscribe and pending notifications are associated with your client.

### Subscribe (by chatId or title)

1. Call **resources/list** to see available resources (chats as message resources).
2. Call **resources/subscribe** with `params: { "uri": "telegram://chat/-1003743757503/messages" }` (or a by-title URI). Use the same `mcp-session-id` header.
3. When someone sends a message in that chat, the webhook stores it and enqueues a pending notification for your session.
4. On your **next** MCP request (any tool or resources/read), the response stream will include one or more `notifications/resources/updated` events (with the resource URI) before the normal response. You can then call **resources/read** for that URI to get the updated messages.

### Poll fallback

If your client does not support session-based notifications, use the tool **telegram_poll_notifications**: it returns and clears pending updated URIs for the current session (session from `mcp-session-id` header). Call it periodically after subscribing; then call **resources/read** for each returned URI.

### Exact notification event format

The worker prepends one or more SSE events to the **next** MCP response for your session. Each event looks like:

```
event: message
data: {"jsonrpc":"2.0","method":"notifications/resources/updated","params":{"uri":"telegram://chat/by-title/Smart%20Agent/messages"}}
```

So the response body starts with these lines, then the normal `event: message` / `data: {"result":...}` for your request. Parse the stream and look for `method: "notifications/resources/updated"` to detect resource updates.

### Verify (order matters)

You must use the **same** `mcp-session-id` for subscribe and for the request that should receive the notification, and the message must be sent **after** you subscribe.

1. Get a stable session id: call **resources/list** (or any MCP request), capture `mcp-session-id` from the response header.
2. **Subscribe** with that SID: `resources/subscribe` with `uri: "telegram://chat/by-title/Smart%20Agent/messages"` and header `mcp-session-id: <that SID>`.
3. **Then** send a new message in that Telegram group (e.g. “Hello world”).
4. Make **one** MCP request with the **same** SID (e.g. **resources/read** for that URI, or **telegram_ping**). The response stream will **start** with the notification event(s) above, then the normal result. Pending notifications are cleared after this request, so only this first request will include them.
5. Optionally call **resources/read** again to see the new message in the payload.

If you get a **new** SID on each run (e.g. new `resources/list` each time), then messages sent before you subscribed with that SID were already delivered to older sessions and won’t appear for the new SID. Reuse one SID: subscribe → send message in chat → then do the next request with that same SID.
