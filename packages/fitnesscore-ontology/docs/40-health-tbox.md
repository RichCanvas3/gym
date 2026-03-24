# Health T-Box (`tbox/health.ttl`)

## Purpose

Adds OPE-inspired health/outcome modeling:

- `fc:Outcome` (intended or observed)
- `fc:Ailment` (conditions a program targets)
- `fc:ClinicalMeasurement` and “improves/raises/lowers” links

Like movement, this is **optional enrichment** that helps with “why” and “what should I do” queries.

## Diagram

```mermaid
flowchart LR
  W[fc:Workout] -->|fc:intendedOutcome| O[fc:Outcome]
  W -->|fc:targetsAilment| A[fc:Ailment]
  W -->|fc:improvesClinicalMeasurement| CM[fc:ClinicalMeasurement]
  CM --> L{{lower / raise}}
```

## Query implications

This module enables queries like:

- “What workouts target knee pain?” (via `fc:targetsAilment`)
- “What training improves blood pressure?” (via `fc:lowersClinicalMeasurement`)

