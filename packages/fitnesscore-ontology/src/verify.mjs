import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgRoot = path.resolve(__dirname, '..');

const required = [
  'ontology/fitnesscore-all.ttl',
  'ontology/tbox/core.ttl',
  'ontology/tbox/fitness.ttl',
  'ontology/tbox/movement.ttl',
  'ontology/tbox/health.ttl',
  'ontology/tbox/context.ttl',
  'ontology/cbox/activity-types.ttl',
  'ontology/cbox/nutrition.ttl',
  'ontology/cbox/intensity.ttl',
  'ontology/abox/empty.ttl',
];

function main() {
  const missing = required.filter((p) => !fs.existsSync(path.join(pkgRoot, p)));
  if (missing.length) {
    throw new Error(`Missing ontology files:\n- ${missing.join('\n- ')}`);
  }
}

try {
  main();
  // eslint-disable-next-line no-console
  console.log('[fitnesscore-ontology] ok');
} catch (e) {
  // eslint-disable-next-line no-console
  console.error('[fitnesscore-ontology] verify failed', e);
  process.exitCode = 1;
}

