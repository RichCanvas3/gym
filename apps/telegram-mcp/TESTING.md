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
   Use the same `secretToken` as `TELEGRAM_WEBHOOK_SECRET` in the worker (`wrangler secret put TELEGRAM_WEBHOOK_SECRET`). If you don’t use a secret, omit `secretToken` and leave the env unset.

3. **Add the bot to the group**: In Telegram, open the group → Add members → your bot (@username) → add. An admin must add it.

4. **Let the bot see all messages**: In Telegram, [@BotFather](https://t.me/BotFather) → `/setprivacy` → select your bot → **Disable**. Then the bot receives every message in groups it’s in.

5. **Send a message in the group**. The worker gets POSTs at `/telegram/webhook` and writes chats/messages to D1.

6. **Check**: Call `telegram_list_chats`; you should see the group. Use its `chatId` in `telegram_list_messages` or `telegram_search_messages`.

**Local testing:** Telegram can’t reach localhost. Use a tunnel (e.g. `ngrok http 8787`) and set webhook URL to `https://<ngrok-host>/telegram/webhook`. Put the same secret in `.dev.vars` as `TELEGRAM_WEBHOOK_SECRET`.

## 6. Deployed base URL

Replace `http://localhost:8787` with your worker URL, e.g. `https://gym-telegram-mcp.<your-subdomain>.workers.dev`.

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
