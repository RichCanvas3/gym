# FitnessCore ontology (overview)

This repo includes a FitnessCore ontology under `packages/fitnesscore-ontology/`.

## Goals

- **Upper layer**: PROV-O + P-Plan + EP-PLAN for plan/execution + provenance.
- **Fitness abstraction**: workouts, body weight observations, food entries.
- **Context layer (PACO-style)**: intensity, amount, location, effects, required conditions.
- **Semantic layer (OPE-inspired)**: movement patterns, engaged structures, equipment/devices, outcomes/ailments.

## Key files

- `packages/fitnesscore-ontology/ontology/tbox/core.ttl`
- `packages/fitnesscore-ontology/ontology/tbox/fitness.ttl`
- `packages/fitnesscore-ontology/ontology/tbox/context.ttl`
- `packages/fitnesscore-ontology/ontology/tbox/movement.ttl`
- `packages/fitnesscore-ontology/ontology/tbox/health.ttl`
- `packages/fitnesscore-ontology/ontology/cbox/activity-types.ttl`
- `packages/fitnesscore-ontology/ontology/cbox/intensity.ttl`

## Using it in the agent

The agent’s `knowledge_search` tool indexes markdown docs from:

- `packages/knowledge/content/**`
- `content-mcp` docs (if configured)
- `gym-core-mcp` lists (class defs, instructors, products)

You can also persist the embedding index to `gym-core-mcp` via:

- `core_kb_upsert_chunks`
- `core_kb_list_chunks`

