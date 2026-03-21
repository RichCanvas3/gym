# Google Calendar MCP – Troubleshooting

## "Expired or revoked token" / Can't access calendar

The error means the OAuth token stored for your `accountAddress` in D1 is expired or was revoked. The agent (e.g. myclaw) doesn’t hold the token—it calls this MCP worker, which uses the stored token.

### Fix

1. **Check connection status** for your account:

   ```bash
   BASE=https://gym-googlecalendar-mcp.richardpedersen3.workers.dev
   KEY=gym
   curl -sS -N \
     -H "accept: application/json, text/event-stream" \
     -H "content-type: application/json" \
     -H "x-api-key: $KEY" \
     --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"googlecalendar_get_connection_status","arguments":{"accountAddress":"acct_cust_casey"}}}' \
     "$BASE/mcp"
   ```

2. If the result shows **needs_auth** / **disconnected** or an auth/connect URL, complete the OAuth flow again (open the worker’s `/oauth/start?accountAddress=acct_cust_casey` URL, sign in with Google, then hit the success redirect).

3. Retry the calendar request from the agent.

## `/chat?googleCalendar=connected` shows **Unauthorized**

That happened because every path except OAuth required `x-api-key`, and a normal browser GET has no header.

- **Deployed fix:** `/chat` is now a public HTML success page (no API key).
- **Better setup:** Set `WEB_SUCCESS_REDIRECT_URL` (wrangler secret or var) to your **real web app** URL (e.g. `https://<your-vercel-app>/chat`), not `https://<worker>.workers.dev/chat`, so users land back in your Next.js app after OAuth.

## Send all events to a specific calendar (e.g. "myclaw")

Create/list/update use the **primary** calendar unless you set **TARGET_CALENDAR_ID**.

1. **Find your calendar id** (e.g. for "myclaw"): call the tool **googlecalendar_list_calendars** with your `accountAddress`. In the response, find the calendar whose `summary` is "myclaw" and note its `id` (often an email like `xxxx@group.calendar.google.com` or a long id).
2. **Set the worker config:** `wrangler secret put TARGET_CALENDAR_ID` and paste that calendar id (or set it in Cloudflare dashboard → Workers → your worker → Settings → Variables).
3. Redeploy. After that, **googlecalendar_create_event**, **googlecalendar_list_events**, and **googlecalendar_update_event** all use that calendar.

**Update events:** The worker now supports **googlecalendar_update_event** (accountAddress, eventId, and optionally summary, description, startISO, endISO). Use the `eventId` from a create or list response to patch an existing event.

## 404 Not Found (create / list / update)

Google returns **404** when:

1. **Wrong `TARGET_CALENDAR_ID`** — It must be the calendar’s **id** from **googlecalendar_list_calendars** (looks like `xxxxxxxx@group.calendar.google.com` or a long opaque id), **not** the display name `"myclaw"`. Fix: list calendars, copy `id`, set `TARGET_CALENDAR_ID` to that value, redeploy.

2. **Wrong `eventId` on update** — Events live on one calendar. If `TARGET_CALENDAR_ID` points at calendar A but the `eventId` came from **primary** or another calendar, PATCH returns 404. Create or list events **on the same target calendar**, then use that response’s `id`.

3. **Double-encoded id in secrets** — If you pasted a URL-encoded id twice, clear the secret and paste the raw id from list_calendars once.

After redeploying the worker, tool errors include a short hint when Google returns 404.
