type Service = { fetch(input: Request | string, init?: RequestInit): Promise<Response> };

export type Env = {
  MCP_API_KEY?: string;
  // Which weight-management scope we sync into.
  SYNC_TELEGRAM_USER_ID?: string;
  SYNC_CHAT_TITLE?: string;
  SYNC_TZ_NAME?: string;
  SYNC_LOOKBACK_DAYS?: string;

  // Optional: Google Calendar cache sync (uses googlecalendar-mcp).
  GCAL_SYNC_ENABLED?: string;
  GCAL_SYNC_LOOKBACK_DAYS?: string;
  GCAL_SYNC_LOOKAHEAD_DAYS?: string;

  // Optional: GraphDB sync (FitnessCore KB graph). Enabled when GRAPHDB_SYNC_ENABLED=1.
  GRAPHDB_SYNC_ENABLED?: string;
  GRAPHDB_CONTEXT_BASE?: string;
  GRAPHDB_ID_BASE?: string;
  GRAPHDB_BASE_URL?: string;
  GRAPHDB_REPOSITORY?: string;
  GRAPHDB_USERNAME?: string;
  GRAPHDB_PASSWORD?: string;
  GRAPHDB_CF_ACCESS_CLIENT_ID?: string;
  GRAPHDB_CF_ACCESS_CLIENT_SECRET?: string;

  TELEGRAM_MCP: Service;
  WEIGHT_MCP: Service;
  STRAVA_MCP: Service;
  GOOGLECAL_MCP: Service;

  // Optional: LLM kcal estimation during GraphDB sync
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  GRAPHDB_KCAL_LLM_ENABLED?: string;

  // If profile is missing weight, set this (lb) into wm_profiles.profile_json.
  DEFAULT_PROFILE_WEIGHT_LB?: string;
};

function nowISO() {
  return new Date().toISOString();
}

async function readSseJson(res: Response): Promise<any> {
  const txt = await res.text();
  const m = txt.match(/data: (.+)\n/);
  if (!m) {
    return { jsonrpc: "2.0", id: 1, error: { message: `Unexpected SSE: ${txt.slice(0, 200)}` } };
  }
  return JSON.parse(m[1]);
}

async function mcpCall(service: Service, apiKey: string | undefined, tool: string, args: Record<string, unknown>) {
  const res = await service.fetch("http://service/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const msg = await readSseJson(res);
  const text = msg?.result?.content?.[0]?.text;
  return typeof text === "string" ? JSON.parse(text) : msg;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function firstImageUrl(m: any): string | null {
  const direct = typeof m?.imageUrl === "string" ? m.imageUrl.trim() : "";
  if (direct) return direct;
  const img = m?.image;
  const u1 = typeof img?.url === "string" ? img.url.trim() : "";
  if (u1) return u1;
  const u2 = typeof img?.imageUrl === "string" ? img.imageUrl.trim() : "";
  if (u2) return u2;
  return null;
}

function safeInt(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}

function fmtKcal(v: unknown): string {
  return typeof v === "number" && Number.isFinite(v) ? `~${Math.round(v)} kcal` : "";
}

function normalizeTelegramUserId(raw: string): string {
  const t = (raw || "").trim();
  if (!t) return "";
  // Accept either "6105195555" or "tg:6105195555"
  if (t.startsWith("tg:")) return t.slice("tg:".length);
  return t;
}

function plausibleTelegramUserId(id: string): boolean {
  const t = (id || "").trim();
  if (!t) return false;
  if (!/^\d+$/.test(t)) return false;
  return t.length >= 6;
}

async function resolveSyncTelegramUserId(env: Env, apiKey: string | undefined): Promise<{ tgUserId: string; reason?: string; candidates?: string[] }> {
  const explicit = normalizeTelegramUserId((env.SYNC_TELEGRAM_USER_ID ?? "").trim());
  if (explicit) return { tgUserId: explicit };

  const out = await mcpCall(env.TELEGRAM_MCP, apiKey, "telegram_list_unique_user_ids", { limit: 200 });
  const raw: unknown[] = Array.isArray((out as any)?.userIds) ? ((out as any).userIds as unknown[]) : [];
  const ids: string[] = raw
    .map((x) => String(x ?? "").trim())
    .filter((s): s is string => Boolean(s && s.trim()));
  const candidates: string[] = Array.from(new Set(ids.filter(plausibleTelegramUserId)));
  if (candidates.length === 1) return { tgUserId: candidates[0] as string, candidates };
  return { tgUserId: "", reason: "missing_sync_telegram_user_id", candidates: candidates.slice(0, 20) };
}

function fmtDistanceMeters(m: unknown): string {
  if (typeof m !== "number" || !Number.isFinite(m) || m <= 0) return "";
  const km = m / 1000;
  const mi = km * 0.621371;
  return mi >= 0.5 ? `${mi.toFixed(1)} mi` : `${km.toFixed(1)} km`;
}

function fmtDurationSeconds(s: unknown): string {
  if (typeof s !== "number" || !Number.isFinite(s) || s <= 0) return "";
  const sec = Math.trunc(s);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtWorkoutLine(wk: any): string {
  const activityType = asString(wk?.activity_type).trim() || "Workout";
  const startedAtISO = asString(wk?.started_at_iso).trim();
  const when = startedAtISO ? startedAtISO.replace(".000Z", "Z") : "";
  const dist = fmtDistanceMeters(wk?.distance_meters);
  const dur = fmtDurationSeconds(wk?.duration_seconds);
  const kcal = fmtKcal(wk?.active_energy_kcal);
  const parts = [activityType, when ? `(${when})` : "", dur ? `• ${dur}` : "", dist ? `• ${dist}` : "", kcal ? `• ${kcal}` : ""].filter(Boolean);
  return `Workout synced: ${parts.join(" ")}`.trim();
}

function truthy(s: string | undefined): boolean {
  const v = (s ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "y" || v === "on";
}

function safeDays(s: string | undefined, fallback: number): number {
  const n = Number(String(s ?? "").trim());
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

async function syncGoogleCalendar(env: Env) {
  const apiKey = (env.MCP_API_KEY ?? "").trim() || undefined;
  if (!truthy(env.GCAL_SYNC_ENABLED)) return { ok: true, skipped: true };

  const lookbackDays = safeDays(env.GCAL_SYNC_LOOKBACK_DAYS, 30);
  const lookaheadDays = safeDays(env.GCAL_SYNC_LOOKAHEAD_DAYS, 90);
  const now = Date.now();
  const timeMinISO = new Date(now - lookbackDays * 24 * 3600 * 1000).toISOString();
  const timeMaxISO = new Date(now + lookaheadDays * 24 * 3600 * 1000).toISOString();

  const idsOut = await mcpCall(env.TELEGRAM_MCP, apiKey, "telegram_list_unique_user_ids", { limit: 200 });
  const raw: unknown[] = Array.isArray((idsOut as any)?.userIds) ? ((idsOut as any).userIds as unknown[]) : [];
  const ids: string[] = raw
    .map((x) => String(x ?? "").trim())
    .filter((s): s is string => Boolean(s && s.trim()))
    .filter(plausibleTelegramUserId);
  const tgUserIds = Array.from(new Set(ids));

  let syncedUsers = 0;
  const errors: Array<{ telegramUserId: string; error: string }> = [];
  for (const tgUserId of tgUserIds) {
    try {
      await mcpCall(env.GOOGLECAL_MCP, apiKey, "googlecalendar_sync_events", {
        telegramUserId: tgUserId,
        timeMinISO,
        timeMaxISO,
        maxResults: 2500,
      });
      syncedUsers += 1;
    } catch (e) {
      errors.push({ telegramUserId: tgUserId, error: String((e as any)?.message ?? e) });
    }
  }

  return { ok: errors.length === 0, asOfISO: nowISO(), timeMinISO, timeMaxISO, totalUsers: tgUserIds.length, syncedUsers, errors: errors.slice(0, 5) };
}

function b64(s: string): string {
  // Browser-safe base64 (works in Workers).
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  // btoa expects binary string
  return btoa(bin);
}

async function graphDbClearAndUploadTtl(env: Env, contextIri: string, ttl: string): Promise<void> {
  const baseUrl = (env.GRAPHDB_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const repo = (env.GRAPHDB_REPOSITORY ?? "").trim();
  const user = (env.GRAPHDB_USERNAME ?? "").trim();
  const pass = (env.GRAPHDB_PASSWORD ?? "").trim();
  if (!baseUrl || !repo || !user || !pass) throw new Error("Missing GRAPHDB_* env (base_url/repository/username/password)");

  const headers: Record<string, string> = {
    authorization: `Basic ${b64(`${user}:${pass}`)}`,
  };
  const cfId = (env.GRAPHDB_CF_ACCESS_CLIENT_ID ?? "").trim();
  const cfSecret = (env.GRAPHDB_CF_ACCESS_CLIENT_SECRET ?? "").trim();
  if (cfId && cfSecret) {
    headers["CF-Access-Client-Id"] = cfId;
    headers["CF-Access-Client-Secret"] = cfSecret;
  }

  const statementsUrl = `${baseUrl}/repositories/${encodeURIComponent(repo)}/statements`;

  // Clear graph
  const body = new URLSearchParams({ update: `CLEAR GRAPH <${contextIri}>` }).toString();
  const res0 = await fetch(statementsUrl, {
    method: "POST",
    headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res0.ok) throw new Error(`GraphDB CLEAR failed: ${res0.status} ${await res0.text()}`);

  // Upload TTL
  const uploadUrl = `${statementsUrl}?context=${encodeURIComponent(`<${contextIri}>`)}`;
  const res1 = await fetch(uploadUrl, {
    method: "POST",
    headers: { ...headers, "content-type": "text/turtle; charset=utf-8" },
    body: ttl,
  });
  if (!res1.ok) throw new Error(`GraphDB upload failed: ${res1.status} ${await res1.text()}`);
}

async function openaiJson(env: Env, messages: Array<{ role: "system" | "user"; content: string }>): Promise<any> {
  const key = (env.OPENAI_API_KEY ?? "").trim();
  if (!key) throw new Error("Missing OPENAI_API_KEY");
  const model = (env.OPENAI_MODEL ?? "").trim() || "gpt-4o-mini";
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages,
      response_format: { type: "json_object" },
    }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${txt.slice(0, 500)}`);
  return JSON.parse(txt);
}

function isFinitePosNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

async function estimateWorkoutsKcalWithLlm(
  env: Env,
  args: { weightKg: number; workouts: any[] },
): Promise<Record<string, number>> {
  const wk = Array.isArray(args.workouts) ? args.workouts : [];
  const weightKg = args.weightKg;
  const items = wk
    .map((w) => ({
      workout_id: asString(w?.workout_id).trim(),
      activity_type: asString(w?.activity_type).trim(),
      duration_seconds: typeof w?.duration_seconds === "number" ? Math.trunc(w.duration_seconds) : null,
      distance_meters: typeof w?.distance_meters === "number" ? w.distance_meters : null,
      started_at_iso: asString(w?.started_at_iso).trim() || null,
    }))
    .filter((w) => Boolean(w.workout_id));

  const sys =
    "You estimate active calories burned (kcal) for workouts.\n" +
    "Return JSON only, shape: {\"kcalByWorkoutId\": {\"<workout_id>\": <kcal_number>, ...}}.\n" +
    "Rules:\n" +
    "- Use the provided weightKg.\n" +
    "- Use activity_type, duration_seconds, distance_meters.\n" +
    "- If data is insufficient, omit that workout_id (do not guess wildly).\n" +
    "- kcal must be a positive number.\n";
  const user = JSON.stringify({ weightKg, workouts: items });
  const out = await openaiJson(env, [
    { role: "system", content: sys },
    { role: "user", content: user },
  ]);
  const content = out?.choices?.[0]?.message?.content;
  let parsed: any = null;
  try {
    parsed = typeof content === "string" ? JSON.parse(content) : content;
  } catch {
    parsed = null;
  }
  const m = parsed?.kcalByWorkoutId;
  const outMap: Record<string, number> = {};
  if (m && typeof m === "object") {
    for (const [k, v] of Object.entries(m)) {
      const id = String(k ?? "").trim();
      const n = typeof v === "number" ? v : Number(v);
      if (id && Number.isFinite(n) && n > 0) outMap[id] = n;
    }
  }
  return outMap;
}

function ttlEscape(s: string): string {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function litStr(s: string): string {
  return `"${ttlEscape(s)}"`;
}

function iri(base: string, kind: string, id: string): string {
  return `<${base.replace(/\/+$/, "")}/${kind}/${encodeURIComponent(id)}>`;
}

function ttlPrefixBlock(): string {
  return [
    "@prefix fc: <https://ontology.fitnesscore.ai/fc#> .",
    "@prefix prov: <http://www.w3.org/ns/prov#> .",
    "@prefix sosa: <http://www.w3.org/ns/sosa/> .",
    "@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .",
    "",
  ].join("\n");
}

function workoutTypeToConcept(activityType: string): string {
  const t = (activityType || "").trim().toLowerCase();
  if (t === "run") return "fc:ActivityType_Run";
  if (t === "ride") return "fc:ActivityType_Ride";
  if (t === "walk") return "fc:ActivityType_Walk";
  if (t === "hike") return "fc:ActivityType_Hike";
  if (t === "swim") return "fc:ActivityType_Swim";
  if (t === "row") return "fc:ActivityType_Row";
  if (t === "weighttraining" || t === "weight training" || t === "weight_training") return "fc:ActivityType_WeightTraining";
  if (t === "workout") return "fc:ActivityType_Workout";
  if (t === "yoga") return "fc:ActivityType_Yoga";
  return "fc:ActivityType_Other";
}

function weightKgFromProfile(profile: any): number | null {
  try {
    const kg =
      (typeof profile?.weight_kg === "number" && Number.isFinite(profile.weight_kg) ? Number(profile.weight_kg) : null) ??
      (typeof profile?.weightKg === "number" && Number.isFinite(profile.weightKg) ? Number(profile.weightKg) : null) ??
      (typeof profile?.body_weight_kg === "number" && Number.isFinite(profile.body_weight_kg) ? Number(profile.body_weight_kg) : null) ??
      (typeof profile?.bodyWeightKg === "number" && Number.isFinite(profile.bodyWeightKg) ? Number(profile.bodyWeightKg) : null);
    if (kg != null && kg > 0) return kg;
    const lb =
      (typeof profile?.weight_lb === "number" && Number.isFinite(profile.weight_lb) ? Number(profile.weight_lb) : null) ??
      (typeof profile?.weightLb === "number" && Number.isFinite(profile.weightLb) ? Number(profile.weightLb) : null) ??
      (typeof profile?.bodyWeightLb === "number" && Number.isFinite(profile.bodyWeightLb) ? Number(profile.bodyWeightLb) : null);
    if (lb != null && lb > 0) return lb * 0.45359237;
    return null;
  } catch {
    return null;
  }
}

function estimateExerciseKcal(args: {
  activityType: unknown;
  durationSeconds: unknown;
  distanceMeters: unknown;
  weightKg: number;
}): number | null {
  const w = args.weightKg;
  if (!Number.isFinite(w) || w <= 0) return null;

  const typ = typeof args.activityType === "string" ? args.activityType.trim().toLowerCase() : "";
  const dur = typeof args.durationSeconds === "number" && Number.isFinite(args.durationSeconds) ? Math.max(0, Math.trunc(args.durationSeconds)) : 0;
  const distM = typeof args.distanceMeters === "number" && Number.isFinite(args.distanceMeters) ? Number(args.distanceMeters) : 0;

  // Prefer distance-based for run/walk when distance is present.
  if (distM > 0) {
    const km = distM / 1000.0;
    if (typ.includes("run") || typ.includes("jog")) return Math.round(w * km * 1.0);
    if (typ.includes("walk") || typ.includes("hike")) return Math.round(w * km * 0.6);
  }

  if (dur > 0) {
    const hours = dur / 3600.0;
    // Simple MET mapping (coarse). kcal ≈ MET * kg * hours
    let met = 5.0;
    if (typ.includes("walk")) met = 3.3;
    else if (typ.includes("run")) met = 9.8;
    else if (typ.includes("ride") || typ.includes("bike") || typ.includes("cycle")) met = 8.0;
    else if (typ.includes("swim")) met = 8.0;
    else if (typ.includes("strength") || typ.includes("weight") || typ.includes("workout")) met = 6.0;
    return Math.round(met * w * hours);
  }

  return null;
}

async function syncFitnesscoreGraphDb(env: Env): Promise<{ ok: boolean; contextIri?: string; bytes?: number; reason?: string }> {
  if (!truthy(env.GRAPHDB_SYNC_ENABLED)) return { ok: true, reason: "disabled" };
  const apiKey = (env.MCP_API_KEY ?? "").trim() || undefined;
  const resolved = await resolveSyncTelegramUserId(env, apiKey);
  const tgUserId = resolved.tgUserId;
  if (!tgUserId) return { ok: true, reason: resolved.reason ?? "missing_sync_telegram_user_id" };
  const lookbackDays = Number.parseInt((env.SYNC_LOOKBACK_DAYS ?? "7").trim(), 10);
  const days = Number.isFinite(lookbackDays) ? lookbackDays : 7;

  // Pull recent workouts + food + weights via MCPs, then upload a compact TTL snapshot.
  const w = await mcpCall(env.STRAVA_MCP, apiKey, "strava_list_workouts", { telegramUserId: tgUserId, limit: 200 });
  const workouts = Array.isArray(w?.workouts) ? w.workouts : [];

  const now = Date.now();
  const fromISO = new Date(now - days * 24 * 3600 * 1000).toISOString();
  const toISO = new Date(now).toISOString();
  const scope = { telegramUserId: tgUserId };
  const foods = await mcpCall(env.WEIGHT_MCP, apiKey, "weight_list_food", { scope, fromISO, toISO, limit: 500 });
  const foodItems = Array.isArray(foods?.items) ? foods.items : [];
  const prof0 = await mcpCall(env.WEIGHT_MCP, apiKey, "weight_profile_get", { scope });
  let profile = prof0 && typeof prof0 === "object" ? (prof0 as any).profile : null;
  let weightKg = profile ? weightKgFromProfile(profile) : null;
  if (weightKg == null) {
    const defLbRaw = (env.DEFAULT_PROFILE_WEIGHT_LB ?? "").trim();
    const defLb = defLbRaw ? Number(defLbRaw) : 220;
    if (Number.isFinite(defLb) && defLb > 0) {
      const next = profile && typeof profile === "object" ? { ...(profile as any) } : {};
      // Only set if missing (don't overwrite).
      if (next.weight_lb == null && next.weightKg == null && next.weight_kg == null && next.weightLb == null) {
        next.weight_lb = defLb;
        // Persist back into wm_profiles.profile_json
        await mcpCall(env.WEIGHT_MCP, apiKey, "weight_profile_upsert", { scope, profile: next });
        profile = next;
        weightKg = weightKgFromProfile(profile);
      }
    }
  }

  // If Strava doesn't provide kcal, optionally use LLM to estimate per-workout kcal (batch).
  const wantLlm = truthy(env.GRAPHDB_KCAL_LLM_ENABLED) && typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.trim().length > 10;
  const missingKcal = workouts.filter((wk: any) => asString(wk?.workout_id).trim() && typeof wk?.active_energy_kcal !== "number");
  const kcalByWorkoutId =
    wantLlm && weightKg != null && missingKcal.length
      ? await estimateWorkoutsKcalWithLlm(env, { weightKg, workouts: missingKcal.slice(0, 50) })
      : {};

  const idBase = (env.GRAPHDB_ID_BASE ?? "https://id.fitnesscore.ai").trim() || "https://id.fitnesscore.ai";
  const contextBase = (env.GRAPHDB_CONTEXT_BASE ?? "https://id.fitnesscore.ai/graph/d1").trim() || "https://id.fitnesscore.ai/graph/d1";
  const contextIri = `${contextBase.replace(/\/+$/, "")}/${encodeURIComponent(`tg:${tgUserId}`)}`;

  const athlete = iri(idBase, "athlete", `tg:${tgUserId}`);
  const lines: string[] = [ttlPrefixBlock()];
  lines.push(`${athlete} a fc:Athlete ; fc:description ${litStr(`telegramUserId:${tgUserId}`)} .`);
  lines.push("");

  for (const wk of workouts.slice(0, 500)) {
    const workoutId = asString(wk?.workout_id).trim();
    if (!workoutId) continue;
    const subj = iri(idBase, "workout", workoutId);
    const parts: string[] = [`${subj} a fc:Workout`, `prov:wasAssociatedWith ${athlete}`];
    const started = asString(wk?.started_at_iso).trim();
    const ended = asString(wk?.ended_at_iso).trim();
    if (started) parts.push(`prov:startedAtTime "${ttlEscape(started)}"^^xsd:dateTime`);
    if (ended) parts.push(`prov:endedAtTime "${ttlEscape(ended)}"^^xsd:dateTime`);
    const typ = workoutTypeToConcept(asString(wk?.activity_type));
    parts.push(`fc:activityType ${typ}`);
    if (typeof wk?.duration_seconds === "number") parts.push(`fc:durationSeconds "${Math.trunc(wk.duration_seconds)}"^^xsd:integer`);
    if (typeof wk?.distance_meters === "number") parts.push(`fc:distanceMeters "${wk.distance_meters}"^^xsd:decimal`);
    if (typeof wk?.active_energy_kcal === "number") {
      parts.push(`fc:activeEnergyKcal "${wk.active_energy_kcal}"^^xsd:decimal`);
    } else {
      const wkid = workoutId;
      const llmKcal = wkid ? (kcalByWorkoutId[wkid] ?? null) : null;
      if (llmKcal != null && isFinitePosNum(llmKcal)) {
        parts.push(`fc:activeEnergyKcal "${llmKcal}"^^xsd:decimal`);
        parts.push(`fc:description ${litStr("activeEnergyKcalSource:llm")}`);
      } else if (weightKg != null) {
        // Fallback heuristic if LLM disabled/unavailable
        const est = estimateExerciseKcal({
          activityType: wk?.activity_type,
          durationSeconds: wk?.duration_seconds,
          distanceMeters: wk?.distance_meters,
          weightKg,
        });
        if (typeof est === "number" && Number.isFinite(est) && est > 0) {
          parts.push(`fc:activeEnergyKcal "${est}"^^xsd:decimal`);
          parts.push(`fc:description ${litStr("activeEnergyKcalSource:estimated")}`);
        }
      }
    }
    lines.push(parts.join(" ; ") + " .");
  }
  lines.push("");

  // Body weight from profile (wm_profiles.profile_json), represented as an Observation snapshot.
  if (weightKg != null && Number.isFinite(weightKg) && weightKg > 0) {
    const subj = iri(idBase, "weight", `profile:${tgUserId}`);
    const parts: string[] = [
      `${subj} a fc:BodyWeightObservation, sosa:Observation`,
      `sosa:hasFeatureOfInterest ${athlete}`,
      `prov:wasAttributedTo ${athlete}`,
      `prov:generatedAtTime "${new Date().toISOString()}"^^xsd:dateTime`,
      `fc:bodyWeightKg "${weightKg}"^^xsd:decimal`,
      `fc:description ${litStr("bodyWeightKgSource:profile")}`,
    ];
    lines.push(parts.join(" ; ") + " .");
    lines.push("");
  }

  for (const it of foodItems.slice(0, 5000)) {
    const id = asString(it?.id).trim();
    if (!id) continue;
    const subj = iri(idBase, "food", id);
    const parts: string[] = [`${subj} a fc:FoodEntry`, `prov:wasAttributedTo ${athlete}`];
    const at_ms = typeof it?.at_ms === "number" ? it.at_ms : null;
    if (at_ms != null) parts.push(`prov:generatedAtTime "${new Date(at_ms).toISOString()}"^^xsd:dateTime`);
    const meal = asString(it?.meal).trim();
    const text = asString(it?.text).trim();
    if (meal) parts.push(`fc:description ${litStr(`meal:${meal}`)}`);
    if (text) parts.push(`fc:description ${litStr(`text:${text}`)}`);
    if (typeof it?.calories === "number") parts.push(`fc:caloriesKcal "${it.calories}"^^xsd:decimal`);
    if (typeof it?.protein_g === "number") parts.push(`fc:proteinGrams "${it.protein_g}"^^xsd:decimal`);
    if (typeof it?.carbs_g === "number") parts.push(`fc:carbsGrams "${it.carbs_g}"^^xsd:decimal`);
    if (typeof it?.fat_g === "number") parts.push(`fc:fatGrams "${it.fat_g}"^^xsd:decimal`);
    lines.push(parts.join(" ; ") + " .");
  }

  const ttl = lines.join("\n");
  await graphDbClearAndUploadTtl(env, contextIri, ttl);
  return { ok: true, contextIri, bytes: ttl.length };
}

async function syncTelegram(env: Env) {
  const apiKey = (env.MCP_API_KEY ?? "").trim() || undefined;
  const chatTitle = (env.SYNC_CHAT_TITLE ?? "Smart Agent").trim();
  const tzName = (env.SYNC_TZ_NAME ?? "UTC").trim() || "UTC";

  const tgUserIdEnv = normalizeTelegramUserId((env.SYNC_TELEGRAM_USER_ID ?? "").trim());

  // NOTE: Smart Agent may be a channel feed (channel_post) where Telegram provides no from_user_id.
  // In that case, filtering chats/messages by fromUserId will drop the chat entirely.
  const chats = await mcpCall(env.TELEGRAM_MCP, apiKey, "telegram_list_chats", { limit: 200 });
  const chatList = Array.isArray(chats?.chats) ? chats.chats : [];
  const chat = chatList.find((c: any) => asString(c?.title).trim().toLowerCase() === chatTitle.toLowerCase());
  const chatId = asString(chat?.chatId).trim();
  if (!chatId) return { ok: true, imported: 0, replied: 0, reason: "chat_not_found" };

  const msgs = await mcpCall(env.TELEGRAM_MCP, apiKey, "telegram_list_messages", {
    chatId,
    limit: 50,
    includeImageUrls: true,
    includeImageBytes: false,
  });
  const items = Array.isArray(msgs?.messages) ? msgs.messages : [];

  let imported = 0;
  let replied = 0;
  const errors: Array<{ messageId: number; error: string }> = [];
  for (const m of items) {
    const mid = safeInt(m?.messageId);
    if (mid == null) continue;
    const dateUnix = safeInt(m?.dateUnix);
    const atMs = dateUnix != null ? dateUnix * 1000 : Date.now();
    const text = asString(m?.text).trim();
    const imageUrl = firstImageUrl(m);
    if (!text && !imageUrl) continue;

    // telegram-mcp returns fromUserId as a number (or null). Treat both string/number as valid.
    // Also allow channel posts (no fromUserId) to map to a single configured user.
    const fromRaw = (m as any)?.fromUserId;
    const fromId = (typeof fromRaw === "number" && Number.isFinite(fromRaw)) || typeof fromRaw === "string" ? String(fromRaw).trim() : "";
    const tgUserId = fromId || (tgUserIdEnv ?? "");
    if (!tgUserId) continue;

    const out = await mcpCall(env.WEIGHT_MCP, apiKey, "weight_ingest_telegram_message", {
      scope: { telegramUserId: tgUserId },
      tzName,
      chatId,
      messageId: mid,
      dateUnix,
      atMs,
      text,
      imageUrl,
      locale: "en-US",
    });

    if (out?.ok !== true) {
      const err = typeof out?.error === "string" ? out.error : JSON.stringify(out?.error ?? out).slice(0, 300);
      errors.push({ messageId: mid, error: err });
      continue;
    }
    if (out?.kind === "ignored") continue;
    if (out?.deduped === true) continue;
    imported += 1;

    // Reply with quick summary to confirm ingestion.
    let reply = "";
    if (out.kind === "meal_text") {
      const r = out.result ?? {};
      reply = `Logged ${asString(r.meal || "meal")} (${fmtKcal(r?.totals?.calories || r?.calories)}).`;
    } else if (out.kind === "meal_photo") {
      const fe = out.foodEntry ?? null;
      if (fe && typeof fe === "object") {
        reply = `Logged ${asString((fe as any).meal || "meal")} (${fmtKcal((fe as any).calories)}).`;
      } else {
        const r = out.result ?? {};
        reply = `Analyzed meal photo (${asString(r?.summary) || "ok"}).`;
      }
    } else if (out.kind === "weight") {
      const r = out.result ?? {};
      const kg = typeof r.weight_kg === "number" ? `${r.weight_kg.toFixed(1)} kg` : "weight";
      reply = `Logged weigh-in: ${kg}.`;
    } else {
      reply = `Logged: ${asString(out.kind) || "entry"}.`;
    }

    if (reply) {
      await mcpCall(env.TELEGRAM_MCP, apiKey, "telegram_send_message", {
        chatId,
        text: reply,
        replyToMessageId: mid,
        disableNotification: true,
      });
      replied += 1;
    }
  }

  return { ok: true, imported, replied, errors: errors.slice(0, 5) };
}

async function syncStrava(env: Env) {
  const apiKey = (env.MCP_API_KEY ?? "").trim() || undefined;
  const tzName = (env.SYNC_TZ_NAME ?? "UTC").trim() || "UTC";
  const chatTitle = (env.SYNC_CHAT_TITLE ?? "Smart Agent").trim();
  const resolved = await resolveSyncTelegramUserId(env, apiKey);
  const tgUserId = resolved.tgUserId;
  if (!tgUserId) return { ok: true, inserted: 0, messaged: 0, reason: resolved.reason ?? "missing_sync_telegram_user_id", candidates: resolved.candidates ?? [] };

  const chats = await mcpCall(env.TELEGRAM_MCP, apiKey, "telegram_list_chats", { limit: 200 });
  const chatList = Array.isArray(chats?.chats) ? chats.chats : [];
  const chat = chatList.find((c: any) => asString(c?.title).trim().toLowerCase() === chatTitle.toLowerCase());
  const chatId = asString(chat?.chatId).trim();
  if (!chatId) return { ok: true, inserted: 0, messaged: 0, reason: "chat_not_found" };

  const lookbackDays = Number.parseInt((env.SYNC_LOOKBACK_DAYS ?? "7").trim(), 10);
  await mcpCall(env.STRAVA_MCP, apiKey, "strava_sync", {
    telegramUserId: tgUserId,
    lookbackDays: Number.isFinite(lookbackDays) ? lookbackDays : 7,
  });
  const w = await mcpCall(env.STRAVA_MCP, apiKey, "strava_list_workouts", { telegramUserId: tgUserId, limit: 50 });
  const workouts = Array.isArray(w?.workouts) ? w.workouts : [];

  let inserted = 0;
  let messaged = 0;
  const errors: Array<{ workoutId: string; error: string }> = [];
  for (const wk of workouts.slice(0, 50)) {
    const workoutId = asString(wk?.workout_id).trim();
    if (!workoutId) continue;
    const startedAtISO = asString(wk?.started_at_iso).trim();
    const activityType = asString(wk?.activity_type).trim();
    const durationSeconds = safeInt(wk?.duration_seconds);
    const distanceMeters = typeof wk?.distance_meters === "number" ? wk.distance_meters : null;
    const kcal = typeof wk?.active_energy_kcal === "number" ? wk.active_energy_kcal : null;

    const out = await mcpCall(env.WEIGHT_MCP, apiKey, "weight_ingest_workout", {
      scope: { telegramUserId: tgUserId },
      source: "strava",
      workoutId,
      startedAtISO,
      activityType,
      durationSeconds,
      distanceMeters,
      activeEnergyKcal: kcal,
      raw: wk,
    });
    if (out?.ok !== true) {
      const err = typeof out?.error === "string" ? out.error : JSON.stringify(out?.error ?? out).slice(0, 300);
      errors.push({ workoutId, error: err });
      continue;
    }
    if (out?.deduped === true) continue;
    inserted += 1;

    const line = fmtWorkoutLine(wk);
    await mcpCall(env.TELEGRAM_MCP, apiKey, "telegram_send_message", {
      chatId,
      text: line,
      disableNotification: true,
    });
    messaged += 1;
  }

  return { ok: true, inserted, messaged, tzName, scopeTelegramUserId: tgUserId, errors: errors.slice(0, 5) };
}

async function runCron(env: Env) {
  const t0 = Date.now();
  const tg = await syncTelegram(env).catch((e) => ({ ok: false, error: String((e as any)?.message ?? e) }));
  const st = await syncStrava(env).catch((e) => ({ ok: false, error: String((e as any)?.message ?? e) }));
  const gc = await syncGoogleCalendar(env).catch((e) => ({ ok: false, error: String((e as any)?.message ?? e) }));
  const kb = await syncFitnesscoreGraphDb(env).catch((e) => ({ ok: false, error: String((e as any)?.message ?? e) }));
  return { ok: true, asOfISO: nowISO(), ms: Date.now() - t0, telegram: tg, strava: st, googlecalendar: gc, graphdb: kb };
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response(JSON.stringify({ ok: true, asOfISO: nowISO() }, null, 2));
    if (url.pathname === "/run") {
      const out = await runCron(env);
      return new Response(JSON.stringify(out, null, 2), { headers: { "content-type": "application/json; charset=utf-8" } });
    }
    return new Response("Not Found", { status: 404 });
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runCron(env));
  },
};

