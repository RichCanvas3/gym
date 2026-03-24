# FitnessCore ontology docs

This folder documents the FitnessCore ontology modules in `packages/fitnesscore-ontology/ontology/` and how they’re used with GraphDB.

## Modules

- `10-core-tbox.md`: PROV-O / P-Plan / EP-PLAN spine + core entities
- `20-fitness-tbox.md`: workouts, food, body weight (Strava + weight management alignment)
- `30-movement-tbox.md`: movement patterns, anatomy, equipment (OPE-inspired)
- `40-health-tbox.md`: outcomes, ailments, clinical measurements (OPE-inspired)
- `50-context-tbox.md`: session/context, intensity, frequency (PACO-style)
- `60-cbox.md`: SKOS concept schemes (activity types, intensity, nutrition)

## Agent + GraphDB integration

- `90-agent-graphdb-integration.md`: how the LangSmith agent uses GraphDB (SPARQL) + how RAG with T-Box helps query construction

