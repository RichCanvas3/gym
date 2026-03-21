# Meal images: client orchestration

**weight-management-mcp** only accepts **`imageUrl` (https)** or **`imageBase64`** for `weight_analyze_meal_photo`. It does not call Telegram APIs or resolve `file_id`.

## Flow

1. **Your client** (agent, app, or script) obtains HTTPS URLs for images:
   - e.g. list messages via **telegram-mcp**, read `imageUrl` / public `https://…/telegram/media/…` URLs, or resolve `getFile` yourself and pass any **https** URL.
2. Call **`weight_analyze_meal_photo`** with `{ scope, imageUrl }`.
3. Optionally pass **`sourceRef`: `{ chatId, messageId` }** for opaque correlation (stored in DB; the worker does not interpret the source).

## Fill `urls.txt` from telegram-mcp (stored messages)

Messages must already be in **telegram-mcp** D1 (webhook has received them). Image URLs are public `https://…/telegram/media/…` when `PUBLIC_BASE_URL` is set on the telegram worker.

```bash
export TELEGRAM_MCP_URL="https://gym-telegram-mcp.<your-subdomain>.workers.dev/mcp"
export MCP_API_KEY="..."   # x-api-key for telegram worker

# Either numeric/string chat id:
export CHAT_ID="-1001234567890"
# Or match by group title:
# export CHAT_TITLE="Smart Agent"

node scripts/fetch-image-urls-from-telegram-mcp.mjs --out urls.txt
```

Then run meal analysis on those URLs (weight worker; can use same `MCP_API_KEY` if you use one key everywhere):

```bash
export WEIGHT_MCP_URL="https://gym-weight-management-mcp.<your-subdomain>.workers.dev/mcp"
export SCOPE_JSON='{"accountAddress":"you"}'
node scripts/batch-analyze-meal-photos.mjs urls.txt
```

## Batch command (URLs you already have)

```bash
export WEIGHT_MCP_URL="https://gym-weight-management-mcp.<your-subdomain>.workers.dev/mcp"
export MCP_API_KEY="..."
export SCOPE_JSON='{"accountAddress":"you"}'

printf '%s\n' "https://example.com/meal1.jpg" | node scripts/batch-analyze-meal-photos.mjs
```

## Privacy

Do not log or persist token-bearing `api.telegram.org/file/bot…` URLs in untrusted logs. Prefer short-lived public proxy URLs when available.
