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
