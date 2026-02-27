import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type Env = {
  // Shared secret (optional). If set, caller must send header `x-api-key: <value>`.
  MCP_API_KEY?: string;

  // SendGrid credentials
  SENDGRID_API_KEY: string;
  SENDGRID_FROM_EMAIL: string;
};

function createServer(env: Env) {
  const server = new McpServer({
    name: "Gym SendGrid MCP",
    version: "0.1.0",
  });

  const SendEmailArgs = z.object({
    to: z.string().min(3),
    subject: z.string().min(1),
    text: z.string().optional(),
    html: z.string().optional(),
  });

  server.tool("sendEmail", "Send a single email via SendGrid", SendEmailArgs.shape, async (args) => {
    const parsed = SendEmailArgs.parse(args);
    const res = await sendgridSend(env, {
      to: parsed.to,
      subject: parsed.subject,
      text: parsed.text,
      html: parsed.html,
    });
    return {
      content: [{ type: "text", text: res.ok ? "Email sent." : `SendGrid error: ${res.error}` }],
    };
  });

  const ScheduleEmailArgs = z.object({
    to: z.string().min(3),
    subject: z.string().min(1),
    send_at: z.number().int().positive(), // unix seconds
    text: z.string().optional(),
    html: z.string().optional(),
  });

  server.tool(
    "scheduleEmail",
    "Schedule an email for a future unix timestamp (seconds) via SendGrid",
    ScheduleEmailArgs.shape,
    async (args) => {
      const parsed = ScheduleEmailArgs.parse(args);
      const res = await sendgridSend(env, {
        to: parsed.to,
        subject: parsed.subject,
        send_at: parsed.send_at,
        text: parsed.text,
        html: parsed.html,
      });
      return {
        content: [
          {
            type: "text",
            text: res.ok ? `Email scheduled (send_at=${parsed.send_at}).` : `SendGrid error: ${res.error}`,
          },
        ],
      };
    },
  );

  const SendTemplateArgs = z.object({
    to: z.string().min(3),
    templateId: z.string().min(1),
    subject: z.string().optional(),
    dynamicData: z.record(z.string(), z.unknown()).optional(),
  });

  server.tool(
    "sendEmailWithTemplate",
    "Send a SendGrid dynamic template email",
    SendTemplateArgs.shape,
    async (args) => {
      const parsed = SendTemplateArgs.parse(args);
      const res = await sendgridSend(env, {
        to: parsed.to,
        subject: parsed.subject,
        template_id: parsed.templateId,
        dynamic_template_data: parsed.dynamicData,
      });
      return {
        content: [{ type: "text", text: res.ok ? "Template email sent." : `SendGrid error: ${res.error}` }],
      };
    },
  );

  return server;
}

async function sendgridSend(
  env: Env,
  params: {
    to: string;
    subject?: string;
    text?: string;
    html?: string;
    send_at?: number;
    template_id?: string;
    dynamic_template_data?: Record<string, unknown>;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!env.SENDGRID_API_KEY) return { ok: false, error: "Missing SENDGRID_API_KEY" };
  if (!env.SENDGRID_FROM_EMAIL) return { ok: false, error: "Missing SENDGRID_FROM_EMAIL" };

  const content: Array<{ type: "text/plain" | "text/html"; value: string }> = [];
  if (typeof params.text === "string" && params.text.trim()) {
    content.push({ type: "text/plain", value: params.text });
  }
  if (typeof params.html === "string" && params.html.trim()) {
    content.push({ type: "text/html", value: params.html });
  }

  if (!params.template_id && content.length === 0) {
    return { ok: false, error: "Provide either text/html content or templateId." };
  }

  const payload: Record<string, unknown> = {
    personalizations: [
      {
        to: [{ email: params.to }],
        ...(typeof params.send_at === "number" ? { send_at: params.send_at } : {}),
        ...(params.dynamic_template_data ? { dynamic_template_data: params.dynamic_template_data } : {}),
      },
    ],
    from: { email: env.SENDGRID_FROM_EMAIL },
    ...(params.subject ? { subject: params.subject } : {}),
    ...(params.template_id ? { template_id: params.template_id } : {}),
    ...(content.length ? { content } : {}),
  };

  const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.SENDGRID_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (r.ok) return { ok: true };
  const txt = await r.text().catch(() => "");
  return { ok: false, error: txt || `HTTP ${r.status}` };
}

function checkApiKey(request: Request, env: Env): Response | null {
  const expected = (env.MCP_API_KEY ?? "").trim();
  if (!expected) return null;
  const got = request.headers.get("x-api-key") ?? request.headers.get("X-Api-Key") ?? "";
  if (got !== expected) return new Response("Unauthorized", { status: 401 });
  return null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const auth = checkApiKey(request, env);
    if (auth) return auth;

    // Create a new server instance per request (required by MCP SDK >= 1.26.0).
    const server = createServer(env);
    return createMcpHandler(server, { route: "/mcp" })(request, env, ctx);
  },
};

