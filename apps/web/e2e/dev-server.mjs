import http from "node:http";
import { spawn } from "node:child_process";

const NEXT_PORT = Number(process.env.NEXT_PORT || "3100");
const STUB_PORT = Number(process.env.LANGGRAPH_STUB_PORT || "4010");

function readJson(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += String(c)));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function outputForMessage(message) {
  const m = String(message || "").toLowerCase();

  if (message === "__CHAT_HISTORY__") {
    return {
      answer: "",
      data: {
        messages: [{ role: "assistant", content: "Hi — ask about classes, meals, workouts, or schedules." }],
      },
    };
  }

  if (m.startsWith("__calendar_week__")) {
    return {
      answer: "",
      schedule: {
        asOfISO: "2026-03-21T00:00:00Z",
        classes: [
          {
            id: "class_picklball_dropin_stub_001",
            title: "Pickleball (drop-in)",
            type: "group",
            skillLevel: "beginner",
            coachId: "coach_stub",
            startTimeISO: "2026-03-23T18:00:00.000Z",
            durationMinutes: 120,
            capacity: 24,
          },
        ],
      },
    };
  }

  if (m.includes("what have i eaten") || m.includes("past week") || m.includes("last week")) {
    return {
      answer: "Meals for the past 7 days (America/Denver):\n\n2026-03-21\n- breakfast: 2 eggs + wheat toast (~320 kcal)",
    };
  }

  if (m.includes("what exercises") || m.includes("workouts") || m.includes("past few days")) {
    return {
      answer: "Workouts (last 3 days):\n- Run 6.0 mi (52m)\n- Strength 45m",
    };
  }

  if (m.includes("add") && m.includes("cart")) {
    return {
      answer: "Added that to your cart.",
      cartActions: [{ op: "add", sku: "DAY_PASS", quantity: 1 }],
    };
  }

  return { answer: "OK." };
}

async function waitForUrl(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
          res.resume();
          res.on("end", resolve);
        });
        req.on("error", reject);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const stubServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

  if (req.method === "POST" && url.pathname === "/runs/wait") {
    const body = await readJson(req);
    const message = body?.input?.message;
    return sendJson(res, 200, { output: outputForMessage(message) });
  }

  return sendJson(res, 404, { error: "not found" });
});

await new Promise((resolve) => stubServer.listen(STUB_PORT, "127.0.0.1", resolve));

const nextEnv = {
  ...process.env,
  PORT: String(NEXT_PORT),
  LANGGRAPH_DEPLOYMENT_URL: `http://127.0.0.1:${STUB_PORT}`,
  LANGSMITH_API_KEY: process.env.LANGSMITH_API_KEY || "test_key",
  LANGGRAPH_ASSISTANT_ID: process.env.LANGGRAPH_ASSISTANT_ID || "gym",
};

const nextProc = spawn("pnpm", ["dev"], {
  stdio: "inherit",
  env: nextEnv,
});

const shutdown = () => {
  try {
    stubServer.close();
  } catch {}
  try {
    nextProc.kill("SIGTERM");
  } catch {}
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

nextProc.on("exit", (code) => {
  shutdown();
  process.exit(code ?? 0);
});

await waitForUrl(`http://127.0.0.1:${NEXT_PORT}/`, 120_000);
console.log(`[e2e] ready http://127.0.0.1:${NEXT_PORT} (stub ${STUB_PORT})`);

