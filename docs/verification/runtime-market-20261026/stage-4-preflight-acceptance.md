# Stage 4: Runtime Preflight Acceptance

Date: 2026-10-28. Ubuntu local Docker (`/var/run/docker.sock`); no host-accessible address because the task network is internal and no ports are published.

The host-side preflight inspects only explicitly named Compose projects. It blocks a live legacy API or scheduler, ignores non-scheduler services, and fails closed if Docker cannot be queried. It does not read heartbeat freshness as ownership and does not mutate containers.

## Verification

- Pure and CLI-contract tests: `PYTHONPATH=backend python -m pytest -q tests/ops/test_runtime_preflight.py`: **5 passed**.
- Ubuntu Docker contract uses task/project `mw-runtime-preflight-stage4-20261028`, Compose file `deploy/ubuntu/runtime-preflight.acceptance.yaml`, an internal network, two 64 MiB/0.1 CPU containers, no ports, and no volumes.
- Start: `docker compose -p mw-runtime-preflight-stage4-20261028 -f deploy/ubuntu/runtime-preflight.acceptance.yaml up -d --no-build`.
- Conflict check: `python deploy/ubuntu/runtime_preflight.py --project mw-runtime-stage4-candidate --legacy-project mw-runtime-preflight-stage4-20261028` returned 1 and named `notify-worker`.
- Non-scheduler check: after stopping only `notify-worker`, the same command returned 0 while the fixture `postgres` remained running.
- Stop/cleanup: `docker compose -p mw-runtime-preflight-stage4-20261028 -f deploy/ubuntu/runtime-preflight.acceptance.yaml down`.

This verifies local Docker label handling and the conflict policy, not a production project inventory or an actual deployment switch. The operator must supply the verified legacy project list at switch time.
