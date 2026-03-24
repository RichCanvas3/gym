# `@fitnesscore/fitnesscore-ontology`

FitnessCore ontology modules (Turtle TTL).

Design goals:

- Align to **PROV-O** (as-executed provenance) + **P-Plan / EP-PLAN** (as-planned)
- Reuse **W3C** standards where possible (PROV-O, SOSA)
- Use **DOLCE+DnS** foundations where feasible (DUL)
- Keep FitnessCore domain concepts modular (workouts, body weight, nutrition, movement/outcomes)

## What’s inside

- `ontology/`: modular TTL files
  - `fitnesscore-all.ttl` (master import)
  - `tbox/`: schema (classes + properties)
  - `cbox/`: controlled vocabularies (e.g. activity types)
  - `abox/`: placeholder
- `src/ns.mjs`: namespace constants used by tools
- `src/verify.mjs`: verifier used by `pnpm lint`

## Commands

```bash
pnpm -C packages/fitnesscore-ontology lint
```

