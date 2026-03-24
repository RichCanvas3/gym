import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphDbClient } from './graphdbClient.mjs';

function usage() {
  // eslint-disable-next-line no-console
  console.log(`fitnesscore-kb-sync

One-time full rebuild sync: SQLite (D1 export) -> GraphDB.

Usage:
  fitnesscore-kb-sync \\
    --scope-id "tg:6105195555" \\
    --context-base "https://id.fitnesscore.ai/graph/d1" \\
    --strava-sqlite /path/to/strava.sqlite \\
    --weight-sqlite /path/to/weight.sqlite

Optional:
  --id-base https://id.fitnesscore.ai

Env (GraphDB):
  GRAPHDB_BASE_URL, GRAPHDB_REPOSITORY, GRAPHDB_USERNAME, GRAPHDB_PASSWORD
  Optional: GRAPHDB_CF_ACCESS_CLIENT_ID, GRAPHDB_CF_ACCESS_CLIENT_SECRET
`);
}

function argValue(argv, key) {
  const idx = argv.indexOf(key);
  if (idx === -1) return null;
  return argv[idx + 1] || null;
}

function requiredArg(argv, key) {
  const v = argValue(argv, key);
  if (!v) throw new Error(`Missing arg: ${key}`);
  return v;
}

function litString(s) {
  const v = String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  return `"${v}"`;
}

function litDecimal(n) {
  if (n == null || !Number.isFinite(Number(n))) return null;
  return `"${Number(n)}"^^<http://www.w3.org/2001/XMLSchema#decimal>`;
}

function litInt(n) {
  if (n == null || !Number.isFinite(Number(n))) return null;
  return `"${Math.trunc(Number(n))}"^^<http://www.w3.org/2001/XMLSchema#integer>`;
}

function litDateTimeIso(iso) {
  return `"${String(iso)}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`;
}

function isoFromMs(ms) {
  if (!Number.isFinite(Number(ms))) return null;
  return new Date(Number(ms)).toISOString();
}

function idIri(base, type, id) {
  return `${base.replace(/\/+$/, '')}/${type}/${encodeURIComponent(String(id))}`;
}

function scopeIri(base, scopeId) {
  return `${base.replace(/\/+$/, '')}/athlete/${encodeURIComponent(String(scopeId))}`;
}

function activityConceptIri(scopeBase, activityType) {
  const t0 = String(activityType || '').trim();
  const t = t0.toLowerCase();
  if (!t) return 'fc:ActivityType_Other';
  // Prefer C-Box concepts when possible.
  if (t === 'run') return 'fc:ActivityType_Run';
  if (t === 'ride') return 'fc:ActivityType_Ride';
  if (t === 'walk') return 'fc:ActivityType_Walk';
  if (t === 'hike') return 'fc:ActivityType_Hike';
  if (t === 'swim') return 'fc:ActivityType_Swim';
  if (t === 'row') return 'fc:ActivityType_Row';
  if (t === 'weighttraining' || t === 'weight_training' || t === 'weight training') return 'fc:ActivityType_WeightTraining';
  if (t === 'workout') return 'fc:ActivityType_Workout';
  if (t === 'yoga') return 'fc:ActivityType_Yoga';
  if (t === 'other') return 'fc:ActivityType_Other';

  // Otherwise mint a stable concept IRI under the KB id base (not the ontology base).
  const norm = t0.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `<${scopeBase.replace(/\/+$/, '')}/activity-type/${encodeURIComponent(norm)}>`;
}

function ttlPrefixBlock() {
  return [
    '@prefix fc: <https://ontology.fitnesscore.ai/fc#> .',
    '@prefix prov: <http://www.w3.org/ns/prov#> .',
    '@prefix sosa: <http://www.w3.org/ns/sosa/> .',
    '@prefix skos: <http://www.w3.org/2004/02/skos/core#> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '',
  ].join('\n');
}

async function openSqliteReadonly(sqlitePath) {
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs();
  const bytes = fs.readFileSync(sqlitePath);
  return new SQL.Database(new Uint8Array(bytes));
}

function allRows(db, sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const out = [];
    while (stmt.step()) out.push(stmt.getAsObject());
    return out;
  } finally {
    stmt.free();
  }
}

function* mapAthlete({ idBase, scopeId }) {
  const subj = `<${scopeIri(idBase, scopeId)}>`;
  yield `${subj} a fc:Athlete ; fc:description ${litString(`scope_id:${scopeId}`)} .`;
}

function* mapStravaWorkouts(db, { idBase, scopeId, cboxBase }) {
  const rows = allRows(
    db,
    `SELECT workout_id, scope_id, source, device, event_type, activity_type, started_at_iso, ended_at_iso, duration_seconds, distance_meters, active_energy_kcal, metadata_json
     FROM workouts
     WHERE scope_id = ?
     ORDER BY ended_at_iso DESC
     LIMIT 5000`,
    [scopeId],
  );
  const athlete = `<${scopeIri(idBase, scopeId)}>`;
  for (const r of rows) {
    const subj = `<${idIri(idBase, 'workout', r.workout_id)}>`;
    const parts = [
      `${subj} a fc:Workout`,
      `prov:wasAssociatedWith ${athlete}`,
    ];
    if (r.started_at_iso) parts.push(`prov:startedAtTime ${litDateTimeIso(r.started_at_iso)}`);
    if (r.ended_at_iso) parts.push(`prov:endedAtTime ${litDateTimeIso(r.ended_at_iso)}`);
    const atype = activityConceptIri(cboxBase, r.activity_type);
    parts.push(`fc:activityType ${atype}`);
    const dur = litInt(r.duration_seconds);
    if (dur) parts.push(`fc:durationSeconds ${dur}`);
    const dist = litDecimal(r.distance_meters);
    if (dist) parts.push(`fc:distanceMeters ${dist}`);
    const kcal = litDecimal(r.active_energy_kcal);
    if (kcal) parts.push(`fc:activeEnergyKcal ${kcal}`);
    if (r.source) parts.push(`fc:description ${litString(`source:${r.source}`)}`);
    if (r.device) parts.push(`fc:description ${litString(`device:${r.device}`)}`);
    if (r.event_type) parts.push(`fc:description ${litString(`event_type:${r.event_type}`)}`);
    if (r.metadata_json) parts.push(`fc:description ${litString(`metadata_json:${r.metadata_json}`)}`);
    yield `${parts.join(' ; ')} .`;
  }
}

function* mapWeightExercises(db, { idBase, scopeId }) {
  const rows = allRows(
    db,
    `SELECT id, at_ms, source, workout_id, activity_type, duration_seconds, distance_meters, active_energy_kcal
     FROM wm_exercise_entries
     WHERE scope_id = ?
     ORDER BY at_ms DESC
     LIMIT 5000`,
    [scopeId],
  );
  const athlete = `<${scopeIri(idBase, scopeId)}>`;
  for (const r of rows) {
    const subj = `<${idIri(idBase, 'exercise', `${r.source}:${r.workout_id}`)}>`;
    const parts = [
      `${subj} a fc:Workout`,
      `prov:wasAssociatedWith ${athlete}`,
    ];
    const atIso = isoFromMs(r.at_ms);
    if (atIso) parts.push(`prov:startedAtTime ${litDateTimeIso(atIso)}`);
    if (r.activity_type) parts.push(`fc:description ${litString(`activity_type:${r.activity_type}`)}`);
    const dur = litInt(r.duration_seconds);
    if (dur) parts.push(`fc:durationSeconds ${dur}`);
    const dist = litDecimal(r.distance_meters);
    if (dist) parts.push(`fc:distanceMeters ${dist}`);
    const kcal = litDecimal(r.active_energy_kcal);
    if (kcal) parts.push(`fc:activeEnergyKcal ${kcal}`);
    yield `${parts.join(' ; ')} .`;
  }
}

function* mapWeights(db, { idBase, scopeId }) {
  const rows = allRows(
    db,
    `SELECT id, at_ms, weight_kg, bodyfat_pct, source
     FROM wm_weights
     WHERE scope_id=?
     ORDER BY at_ms DESC
     LIMIT 5000`,
    [scopeId],
  );
  const athlete = `<${scopeIri(idBase, scopeId)}>`;
  for (const r of rows) {
    const subj = `<${idIri(idBase, 'weight', r.id)}>`;
    const parts = [
      `${subj} a fc:BodyWeightObservation, sosa:Observation`,
      `sosa:hasFeatureOfInterest ${athlete}`,
      `prov:wasAttributedTo ${athlete}`,
    ];
    const atIso = isoFromMs(r.at_ms);
    if (atIso) parts.push(`prov:generatedAtTime ${litDateTimeIso(atIso)}`);
    const kg = litDecimal(r.weight_kg);
    if (kg) parts.push(`fc:bodyWeightKg ${kg}`);
    if (r.bodyfat_pct != null && Number.isFinite(Number(r.bodyfat_pct))) {
      parts.push(`fc:description ${litString(`bodyfat_pct:${Number(r.bodyfat_pct)}`)}`);
    }
    if (r.source) parts.push(`fc:description ${litString(`source:${r.source}`)}`);
    yield `${parts.join(' ; ')} .`;
  }
}

function* mapFoodEntries(db, { idBase, scopeId }) {
  const rows = allRows(
    db,
    `SELECT id, at_ms, meal, text, calories, protein_g, carbs_g, fat_g, source
     FROM wm_food_entries
     WHERE scope_id=?
     ORDER BY at_ms DESC
     LIMIT 10000`,
    [scopeId],
  );
  const athlete = `<${scopeIri(idBase, scopeId)}>`;
  for (const r of rows) {
    const subj = `<${idIri(idBase, 'food', r.id)}>`;
    const parts = [
      `${subj} a fc:FoodEntry`,
      `prov:wasAttributedTo ${athlete}`,
    ];
    const atIso = isoFromMs(r.at_ms);
    if (atIso) parts.push(`prov:generatedAtTime ${litDateTimeIso(atIso)}`);
    if (r.meal) parts.push(`fc:description ${litString(`meal:${r.meal}`)}`);
    if (r.text) parts.push(`fc:description ${litString(`text:${r.text}`)}`);
    const kcal = litDecimal(r.calories);
    if (kcal) parts.push(`fc:caloriesKcal ${kcal}`);
    const p = litDecimal(r.protein_g);
    if (p) parts.push(`fc:proteinGrams ${p}`);
    const c = litDecimal(r.carbs_g);
    if (c) parts.push(`fc:carbsGrams ${c}`);
    const f = litDecimal(r.fat_g);
    if (f) parts.push(`fc:fatGrams ${f}`);
    if (r.source) parts.push(`fc:description ${litString(`source:${r.source}`)}`);
    yield `${parts.join(' ; ')} .`;
  }
}

function buildTurtle({ stravaDb, weightDb, opts }) {
  const lines = [ttlPrefixBlock()];
  for (const t of mapAthlete(opts)) lines.push(t);
  lines.push('');

  if (stravaDb) {
    for (const t of mapStravaWorkouts(stravaDb, opts)) lines.push(t);
    lines.push('');
  }
  if (weightDb) {
    for (const t of mapWeightExercises(weightDb, opts)) lines.push(t);
    lines.push('');
    for (const t of mapWeights(weightDb, opts)) lines.push(t);
    lines.push('');
    for (const t of mapFoodEntries(weightDb, opts)) lines.push(t);
    lines.push('');
  }
  return lines.join('\n');
}

async function uploadFitnesscoreOntology(client, { contextIri }) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const ontoDir = path.resolve(__dirname, '..', '..', 'fitnesscore-ontology', 'ontology');
  if (!fs.existsSync(ontoDir)) return;
  const files = fs.readdirSync(ontoDir, { withFileTypes: true });
  const ttlFiles = [];
  for (const f of files) {
    if (f.isFile() && f.name.endsWith('.ttl')) ttlFiles.push(path.join(ontoDir, f.name));
  }
  // Also include nested tbox/cbox/abox TTLs.
  for (const sub of ['tbox', 'cbox', 'abox']) {
    const d = path.join(ontoDir, sub);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (f.endsWith('.ttl')) ttlFiles.push(path.join(d, f));
    }
  }

  for (const p of ttlFiles) {
    const ttl = fs.readFileSync(p, 'utf8');
    // eslint-disable-next-line no-await-in-loop
    await client.uploadTurtleToGraph(ttl, { contextIri: `${contextIri}/ontology` });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }

  const scopeId = requiredArg(argv, '--scope-id');
  const contextBase = requiredArg(argv, '--context-base');
  const idBase = argValue(argv, '--id-base') || 'https://id.fitnesscore.ai';

  const stravaSqlite = argValue(argv, '--strava-sqlite');
  const weightSqlite = argValue(argv, '--weight-sqlite');
  if (!stravaSqlite && !weightSqlite) throw new Error('Provide at least one of --strava-sqlite or --weight-sqlite');

  const contextIri = `${contextBase.replace(/\/+$/, '')}/${encodeURIComponent(scopeId)}`;
  const client = GraphDbClient.fromEnv(process.env);

  const stravaDb = stravaSqlite ? await openSqliteReadonly(stravaSqlite) : null;
  const weightDb = weightSqlite ? await openSqliteReadonly(weightSqlite) : null;

  // eslint-disable-next-line no-console
  console.log(`[kb-sync] clearing graph ${contextIri}`);
  await client.clearGraph(contextIri);

  // eslint-disable-next-line no-console
  console.log(`[kb-sync] uploading ontology -> ${contextIri}/ontology`);
  await uploadFitnesscoreOntology(client, { contextIri });

  const turtle = buildTurtle({
    stravaDb,
    weightDb,
    opts: { idBase, scopeId, cboxBase: 'https://ontology.fitnesscore.ai/fc/cbox' },
  });

  // eslint-disable-next-line no-console
  console.log(`[kb-sync] uploading instance ttl (${turtle.length} bytes) -> ${contextIri}`);
  await client.uploadTurtleToGraph(turtle, { contextIri });

  // eslint-disable-next-line no-console
  console.log('[kb-sync] done');
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[kb-sync] failed', e);
  process.exitCode = 1;
});

