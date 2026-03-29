# Event Pipeline

The Matrix application layer now uses a single event pipeline contract for targeted event-producing flows.

Execution order:

1. `validate`
2. `resolveAuth`
3. `authorize`
4. `buildEvent`
5. `persist`
6. `fanout`
7. `notifyFederation`

Design rules:

- `persist` is the only in-transaction state mutation step.
- `fanout` and `notifyFederation` are post-commit side effects.
- post-commit failures are recorded in pipeline results and do not roll back persistence.

The current migrations use this pipeline for:

- local room join
- room send
